import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from "yaml";

/**
 * The two ways to write a definition in the editor.
 *
 * This is an editing convenience, not a storage format. A definition is
 * published as JSON and read back as JSON — `fleet_workflows.definition` is a
 * `json` column and the engine reads that. So YAML comments and layout live
 * only as long as the text in the textarea; the editor says so rather than
 * letting anyone discover it by reopening a file they had annotated.
 */
export type DefinitionFormat = "json" | "yaml";

export interface ParsedDefinition {
  /** The parsed object, or null when the text does not describe one. */
  value: Record<string, unknown> | null;
  /** What is wrong with the text, phrased for someone looking at it. */
  error: string | null;
}

/** `yaml` reports a position; JSON.parse buries one in its message. */
function yamlError(err: unknown): string {
  if (err instanceof YAMLParseError) {
    const at = err.linePos?.[0];
    const where = at ? `line ${at.line}, column ${at.col}: ` : "";
    // The library appends its own multi-line excerpt; the first line is the
    // part a person needs.
    return where + err.message.split("\n")[0];
  }
  return err instanceof Error ? err.message : String(err);
}

export function parseDefinition(
  text: string,
  format: DefinitionFormat,
): ParsedDefinition {
  if (text.trim() === "") {
    return { value: null, error: "the definition is empty" };
  }
  try {
    const parsed = format === "yaml" ? parseYaml(text) : JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        value: null,
        error: `a definition must be ${format === "yaml" ? "a mapping" : "a JSON object"}`,
      };
    }
    return { value: parsed as Record<string, unknown>, error: null };
  } catch (err) {
    return { value: null, error: format === "yaml" ? yamlError(err) : (err as Error).message };
  }
}

export function serializeDefinition(value: unknown, format: DefinitionFormat): string {
  return format === "yaml"
    ? stringifyYaml(value, { indent: 2, lineWidth: 0 })
    : `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Rewrite the text into the other format when the toggle flips.
 *
 * A conversion that cannot parse leaves the text exactly as it was: the
 * alternative is discarding someone's half-written definition because they
 * clicked a tab, which is a far worse outcome than staying on the old format
 * until the syntax error is fixed.
 */
export function convertText(
  text: string,
  from: DefinitionFormat,
  to: DefinitionFormat,
): { text: string; error: string | null } {
  if (from === to) return { text, error: null };
  const { value, error } = parseDefinition(text, from);
  if (!value) return { text, error };
  return { text: serializeDefinition(value, to), error: null };
}

const JSON_TEMPLATE = `{
  "workflow": "NAME",
  "version": 1,
  "start": [{ "goto": "working" }],
  "states": {
    "working": {
      "call": { "skill": "some.skill", "payload": {} },
      "next": [
        { "when": "result.ok", "goto": "completed" },
        { "fail": "the step did not succeed" }
      ]
    }
  }
}
`;

/** The same definition, using the two things YAML has and JSON does not:
 *  comments, and no punctuation to lose track of. */
const YAML_TEMPLATE = `workflow: NAME
version: 1

# Where a run begins. Each entry is tried in order; the first whose
# \`when\` holds decides, and an entry with no \`when\` is the fallback.
start:
  - goto: working

states:
  working:
    # The skill must be one an agent in this tenant advertises.
    call:
      skill: some.skill
      payload: {}
    next:
      - when: result.ok
        goto: completed
      # No \`when\`, so this is what happens otherwise.
      - fail: the step did not succeed
`;

export function templateFor(name: string, format: DefinitionFormat): string {
  const template = format === "yaml" ? YAML_TEMPLATE : JSON_TEMPLATE;
  return template.replace("NAME", name);
}
