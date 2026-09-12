import { Ajv, type ErrorObject } from "ajv";

/**
 * Checking a payload against the `inputSchema` a skill declares on its card
 * (gateway docs §5).
 *
 * The card is the agent author's own statement of what the skill accepts, and
 * until now we only ever checked that the *skill id* existed. A payload that
 * did not match travelled all the way to the agent and came back as a failure
 * hours later — which is the expensive way to learn about a typo.
 *
 * Two callers, one implementation:
 *
 *   A person's message carries literal values, so it is checked outright.
 *
 *   A workflow's `call.payload` carries templates — `"{{vars.requirement}}"`
 *   is resolved at dispatch, so its type is unknowable while editing. Those
 *   positions are excluded rather than guessed at; what stays checkable is
 *   the key set (a missing required key, a key the skill does not declare)
 *   and the type of any value written literally.
 */

export interface PayloadIssue {
  /** Dotted path into the payload, e.g. `issueUrl` or `files[0].path`. */
  path: string;
  message: string;
}

/**
 * Schemas arrive from tenant-controlled cards, so:
 *
 *   `strict: false` — an unknown keyword is the agent author using more of
 *   JSON Schema than we do, not an error to refuse the whole card over.
 *
 *   `allErrors` — a form should show everything that is wrong at once, not
 *   make the user fix one field per round trip.
 *
 * Not cached: a compile happens once per message sent or per editor
 * keystroke-batch, against schemas that are a handful of properties.
 */
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });

/** `/files/0/path` → `files[0].path`, which is how a person would say it. */
function dotted(instancePath: string, appendKey?: string): string {
  const path = instancePath
    .split("/")
    .filter(Boolean)
    .reduce((acc, segment) => {
      if (/^\d+$/.test(segment)) return `${acc}[${segment}]`;
      return acc ? `${acc}.${segment}` : segment;
    }, "");
  if (!appendKey) return path;
  return path ? `${path}.${appendKey}` : appendKey;
}

function describe(error: ErrorObject): PayloadIssue {
  if (error.keyword === "required") {
    const key = (error.params as { missingProperty: string }).missingProperty;
    return { path: dotted(error.instancePath, key), message: "required, but missing" };
  }
  if (error.keyword === "additionalProperties") {
    const key = (error.params as { additionalProperty: string }).additionalProperty;
    return {
      path: dotted(error.instancePath, key),
      message: "not declared by this skill",
    };
  }
  return {
    path: dotted(error.instancePath) || "(payload)",
    message: error.message ?? `failed ${error.keyword}`,
  };
}

export interface CheckOptions {
  /**
   * JSON Pointer prefixes whose values are not knowable — workflow template
   * positions. An error *at or under* one of these is dropped.
   *
   * Note this drops only errors about the value itself: a missing key and an
   * undeclared key are both reported against the parent object, so they
   * survive even when the value at that key is a template.
   */
  unknownAt?: string[];
}

export function checkPayload(
  schema: unknown,
  payload: unknown,
  opts: CheckOptions = {},
): PayloadIssue[] {
  // A skill that declares nothing accepts anything. `inputSchema` is optional
  // on the card and plenty of agents will not have one.
  if (schema === null || schema === undefined) return [];

  let validate;
  try {
    validate = ajv.compile(schema as object);
  } catch (err) {
    // A broken schema is the agent author's problem, not the sender's, and
    // saying so beats either crashing or silently passing everything.
    return [
      {
        path: "(schema)",
        message: `the skill's inputSchema cannot be compiled: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    ];
  }

  if (validate(payload)) return [];

  const unknown = opts.unknownAt ?? [];
  return (validate.errors ?? [])
    .filter(
      (error) =>
        !unknown.some(
          (prefix) =>
            error.instancePath === prefix ||
            error.instancePath.startsWith(`${prefix}/`),
        ),
    )
    .map(describe);
}

/** Every position holding a `{{ … }}` template, as JSON Pointers. */
export function templatePaths(value: unknown, at = ""): string[] {
  if (typeof value === "string") return value.includes("{{") ? [at] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => templatePaths(item, `${at}/${i}`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      // `~0`/`~1` are JSON Pointer's escapes; without them a key containing a
      // slash would produce a pointer that matches the wrong position.
      templatePaths(item, `${at}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`),
    );
  }
  return [];
}

/**
 * Replace template positions with `null` so the surrounding structure still
 * validates. The type errors this provokes are then filtered out by
 * `unknownAt` — the stub only has to keep the object shape intact so that
 * key-level checks still mean something.
 */
function stub(value: unknown): unknown {
  if (typeof value === "string") return value.includes("{{") ? null : value;
  if (Array.isArray(value)) return value.map(stub);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = stub(item);
    }
    return out;
  }
  return value;
}

/** A workflow `call.payload`: keys and literal values checked, templates not. */
export function checkTemplatedPayload(
  schema: unknown,
  payload: unknown,
): PayloadIssue[] {
  return checkPayload(schema, stub(payload), { unknownAt: templatePaths(payload) });
}
