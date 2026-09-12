import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  FleetTaskRecord,
  GatewayAgentRecord,
  TenantRecord,
} from "../site/gatewayStore.js";
import type { A2APart } from "../protocol/a2a.js";
import type { WorkflowDefinition } from "../workflow/engine.js";
import { validateDefinition, WorkflowError } from "../workflow/engine.js";
import type { WorkflowRunRecord } from "../workflow/driver.js";
import { WorkflowDriverError, WorkflowRunFailed } from "../workflow/driver.js";
import { WorkflowDispatchError } from "../workflow/driver.js";
import { checkCallPayloads, skillIndex } from "../workflow/callCheck.js";
import { ConsoleDispatchError } from "./messages.js";
import type { AgentCredential } from "../site/a2aClient.js";
import {
  RegistrationError,
  type RegisterAgentInput,
  type RegisterAgentResult,
} from "../site/registration.js";
import {
  BodyTooLargeError,
  readBodyBuffer,
  toFetchRequest,
  writeFetchResponse,
} from "./nodeBridge.js";

/**
 * The console API (docs/fleet-console.md §3, §5).
 *
 * Deliberately separate from `/a2a/*`. Letting one endpoint accept both a
 * session cookie and a bearer token is the easy move, and it costs two
 * things: the machine surface grows a CSRF face it never needed, and
 * `caller_agent_id` stops being one kind of thing. So the console
 * reimplements what it needs over the same stores.
 *
 * Every handler here resolves the tenant from the **session**. A tenant
 * identifier is never read from the path, the query or the body.
 */

export interface SessionUser {
  id: string;
  email: string;
  name?: string;
}

export interface ConsoleAuth {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(args: { headers: Headers }): Promise<{ user: SessionUser } | null>;
  };
}

export interface ConsoleStore {
  tenantForUser(userId: string): Promise<TenantRecord | null>;
  ensureTenantForUser(user: SessionUser): Promise<TenantRecord>;
  listAgents(tenantId: number): Promise<GatewayAgentRecord[]>;
  getAgent(tenantId: number, agentId: string): Promise<GatewayAgentRecord | null>;
  deleteAgent(tenantId: number, agentId: string): Promise<boolean>;
  getTask(taskId: number): Promise<FleetTaskRecord | null>;
}

/**
 * `messages.ts`, narrowed. A person's message is an ordinary task row whose
 * caller happens to be a user rather than an agent (docs §8).
 */
export interface ConsoleMessenger {
  send(input: {
    tenantId: number;
    userId: string;
    target: GatewayAgentRecord;
    skillId: string;
    parts: A2APart[];
  }): Promise<FleetTaskRecord>;
}

/**
 * `registration.ts`, narrowed to what the console calls. Reusing it is not a
 * convenience: its SSRF checks (private ranges, IPv4-in-IPv6, per-hop
 * revalidation) exist for exactly this shape of request — a URL typed into a
 * browser that the server then fetches (docs §5, §9.2).
 */
export interface ConsoleRegistration {
  register(input: RegisterAgentInput): Promise<RegisterAgentResult>;
  rotateToken(
    agent: Pick<GatewayAgentRecord, "tenantId" | "agentId">,
  ): Promise<{ token: string; revoked: number }>;
  update(
    agent: GatewayAgentRecord,
    changes: {
      displayName?: string;
      endpointUrl?: string;
      credential?: AgentCredential | null;
    },
  ): Promise<GatewayAgentRecord>;
}

/**
 * The composition layer, narrowed to what the console reads (docs §5).
 *
 * Structurally the same port the gateway holds, and deliberately a second
 * declaration rather than a shared one: the two surfaces are allowed to drift
 * — the console will grow a draft/editor shape the machine surface must not.
 */
export interface ConsoleWorkflows {
  putDefinition(input: {
    tenantId: number;
    name: string;
    version: number;
    definition: WorkflowDefinition;
  }): Promise<{ id: number }>;
  listDefinitions(
    tenantId: number,
  ): Promise<Array<{ id: number; name: string; version: number }>>;
  /** Latest version unless one is named — what the editor opens with. */
  findDefinition(
    tenantId: number,
    name: string,
    version?: number,
  ): Promise<{ id: number; definition: WorkflowDefinition } | null>;
  getRun(tenantId: number, runId: number): Promise<WorkflowRunRecord | null>;
  listRuns(tenantId: number, limit?: number): Promise<WorkflowRunRecord[]>;
  listRunEvents(
    tenantId: number,
    runId: number,
  ): Promise<Array<{ eventType: string; payload: unknown; createdAt: string }>>;
}

export interface ConsoleWorkflowStarter {
  start(input: {
    tenantId: number;
    workflowName: string;
    version?: number;
    payload: Record<string, unknown>;
    createdBy: string;
    sourceType: string;
    sourceRef: string;
  }): Promise<{ run: WorkflowRunRecord; deduplicated: boolean }>;
}

export interface ConsoleDeps {
  auth: ConsoleAuth;
  store: ConsoleStore;
  registration: ConsoleRegistration;
  messenger: ConsoleMessenger;
  /** Omit either and the workflow and run routes answer 404, exactly as the
   *  gateway's own do. */
  workflows?: ConsoleWorkflows;
  workflowStarter?: ConsoleWorkflowStarter;
  /** Origin used to rebuild an absolute URL for the fetch-style handler. */
  origin: string;
  maxBodyBytes?: number;
  /**
   * Registering an agent makes the gateway issue an outbound request, so an
   * unmetered endpoint is an open scanning proxy (docs §9.2). Per user, not
   * per IP: the session is the thing we can actually trust here.
   *
   * In-process, so it is per gateway instance rather than per fleet. That is
   * the right shape for a limiter whose job is to blunt a burst, not to
   * account for one.
   */
  registrationRateLimit?: { limit: number; windowMs: number };
  logger?: { error(data: Record<string, unknown>, message?: string): void };
}

export interface Caller {
  user: SessionUser;
  tenant: TenantRecord;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.set(key, value);
  }
  return headers;
}

class ConsoleInputError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ConsoleInputError";
  }
}

const DEFAULT_MAX_BODY = 1024 * 1024;
const CREDENTIAL_SCHEMES = ["bearer", "apiKey", "oauth2", "mtls"] as const;

/** HTTP status per registration outcome. The message itself is the agent
 *  author's own feedback loop, so it is passed through rather than flattened
 *  into something generic. */
const REGISTRATION_STATUS: Record<string, number> = {
  invalid_agent_id: 400,
  invalid_card: 400,
  invalid_endpoint: 400,
  // The caller's URL was refused before a packet left, so it is their input
  // that is wrong, not an upstream that failed.
  endpoint_rejected: 400,
  agent_id_taken: 409,
  unreachable: 502,
};

function str(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ConsoleInputError(`${key} must be a string`, "invalid_body");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * What the gateway must present when it calls this agent — the other
 * direction from the token we mint. Sealed by `FLEET_SECRET_KEY` on the way
 * into the registry.
 */
function parseCredential(value: unknown): AgentCredential | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") {
    throw new ConsoleInputError("credential must be an object", "invalid_body");
  }
  const raw = value as Record<string, unknown>;
  const scheme = raw.scheme;
  if (!CREDENTIAL_SCHEMES.includes(scheme as (typeof CREDENTIAL_SCHEMES)[number])) {
    throw new ConsoleInputError(
      `credential.scheme must be one of ${CREDENTIAL_SCHEMES.join(", ")}`,
      "invalid_body",
    );
  }
  const secret = str(raw, "secret");
  if (!secret) {
    throw new ConsoleInputError("credential.secret is required", "invalid_body");
  }
  const headerName = str(raw, "headerName");
  return {
    scheme: scheme as AgentCredential["scheme"],
    secret,
    ...(headerName ? { headerName } : {}),
  };
}

/**
 * `registration.ts` resolves the card path against this string, so a value
 * that is not a URL at all would throw a bare TypeError from deep inside it
 * and surface as a 500 — a validation failure wearing a server error's face.
 */
function assertEndpointUrl(endpointUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new ConsoleInputError(
      `endpointUrl is not a valid URL: ${endpointUrl}`,
      "invalid_endpoint",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConsoleInputError(
      `endpointUrl must be http or https, got ${parsed.protocol}`,
      "invalid_endpoint",
    );
  }
  return endpointUrl;
}

function parseRegisterBody(value: unknown): {
  agentId: string;
  endpointUrl: string;
  displayName?: string;
  credential?: AgentCredential;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleInputError("body must be a JSON object", "invalid_body");
  }
  const body = value as Record<string, unknown>;

  const agentId = str(body, "agentId");
  if (!agentId) {
    throw new ConsoleInputError("agentId is required", "invalid_body");
  }
  const endpointUrl = str(body, "endpointUrl");
  if (!endpointUrl) {
    throw new ConsoleInputError("endpointUrl is required", "invalid_body");
  }
  assertEndpointUrl(endpointUrl);

  const displayName = str(body, "displayName");
  const credential = parseCredential(body.credential);
  return {
    agentId,
    endpointUrl,
    ...(displayName ? { displayName } : {}),
    ...(credential ? { credential } : {}),
  };
}

/**
 * A patch says what changes; anything absent stays as it is. `credential` is
 * the one field where absent and empty differ: `null` clears the secret the
 * gateway calls this agent with, while leaving it out must not disturb it.
 */
function parsePatchBody(value: unknown): {
  displayName?: string;
  endpointUrl?: string;
  credential?: AgentCredential | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleInputError("body must be a JSON object", "invalid_body");
  }
  const body = value as Record<string, unknown>;
  const changes: {
    displayName?: string;
    endpointUrl?: string;
    credential?: AgentCredential | null;
  } = {};

  const displayName = str(body, "displayName");
  if (displayName) changes.displayName = displayName;

  const endpointUrl = str(body, "endpointUrl");
  if (endpointUrl) changes.endpointUrl = assertEndpointUrl(endpointUrl);

  if ("credential" in body) {
    changes.credential = body.credential === null ? null : (parseCredential(body.credential) ?? null);
  }

  if (Object.keys(changes).length === 0) {
    throw new ConsoleInputError(
      "nothing to change: send displayName, endpointUrl or credential",
      "no_changes",
    );
  }
  return changes;
}

/** The card is tenant-controlled and can be large; the console shows the
 *  parts it renders and leaves the rest in the registry. */
function agentView(agent: GatewayAgentRecord) {
  return {
    agentId: agent.agentId,
    displayName: agent.displayName,
    endpointUrl: agent.endpointUrl,
    health: agent.health,
    skills: (agent.card.skills ?? []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      // What a caller has to send. Captured at registration, and the reason
      // the detail page can describe a skill without asking the agent.
      inputSchema: skill.inputSchema ?? null,
    })),
    cardFetchedAt: agent.cardFetchedAt,
    lastSeenAt: agent.lastSeenAt,
  };
}

/**
 * A message is `{ skillId, parts }` — A2A's own shape, kept rather than
 * flattened so a caller can send data and text together. `text` and `data`
 * are sugar for the one-part case the form actually sends.
 */
function parseMessageBody(value: unknown): { skillId: string; parts: A2APart[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsoleInputError("body must be a JSON object", "invalid_body");
  }
  const body = value as Record<string, unknown>;
  const skillId = str(body, "skillId");
  if (!skillId) {
    throw new ConsoleInputError("skillId is required", "invalid_body");
  }

  let parts: A2APart[];
  if (body.parts !== undefined) {
    if (!Array.isArray(body.parts) || body.parts.length === 0) {
      throw new ConsoleInputError("parts must be a non-empty array", "invalid_body");
    }
    parts = body.parts.map((part, i) => {
      const p = part as Record<string, unknown> | null;
      if (p && p.kind === "text" && typeof p.text === "string") {
        return { kind: "text", text: p.text };
      }
      if (p && p.kind === "data" && "data" in p) {
        return { kind: "data", data: p.data };
      }
      if (p && p.kind === "file" && typeof p.uri === "string") {
        return {
          kind: "file",
          uri: p.uri,
          ...(typeof p.mediaType === "string" ? { mediaType: p.mediaType } : {}),
        };
      }
      throw new ConsoleInputError(
        `parts[${i}] must be a text, data or file part`,
        "invalid_body",
      );
    });
  } else if (body.data !== undefined) {
    parts = [{ kind: "data", data: body.data }];
  } else {
    const text = str(body, "text");
    if (!text) {
      throw new ConsoleInputError(
        "send parts, data or text",
        "invalid_body",
      );
    }
    parts = [{ kind: "text", text }];
  }

  return { skillId, parts };
}

/** A task as the dashboard polls it. `result` is the agent's own payload and
 *  is passed through untouched. */
function taskView(task: FleetTaskRecord) {
  return {
    id: task.id,
    upstreamTaskId: task.upstreamTaskId,
    callerAgentId: task.callerAgentId,
    targetAgentId: task.targetAgentId,
    skillId: task.skillId,
    state: task.state,
    result: task.result,
    deadlineAt: task.deadlineAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * A run, as the console reads it. `awaitingTaskId` is deliberately included
 * where the gateway's view drops it: "which step is this sitting on" is the
 * first question the run page has to answer.
 */
function runView(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    workflowId: run.workflowId,
    state: run.state,
    status: run.status,
    reason: run.reason,
    vars: run.vars,
    sourceType: run.sourceType,
    sourceRef: run.sourceRef,
    awaitingTaskId: run.awaitingTaskId,
    updatedAt: run.updatedAt ?? null,
  };
}

/** A definition body, checked far enough that `validateDefinition` gets an
 *  object rather than a surprise. */
function parseDefinitionBody(body: unknown): WorkflowDefinition {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ConsoleInputError("a workflow definition is required", "invalid_body");
  }
  return body as WorkflowDefinition;
}

function createRateLimiter(opts: { limit: number; windowMs: number }) {
  const hits = new Map<string, number[]>();
  return function allow(key: string, now = Date.now()): boolean {
    const recent = (hits.get(key) ?? []).filter((at) => now - at < opts.windowMs);
    if (recent.length >= opts.limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

export function createConsoleHandler(deps: ConsoleDeps) {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const allowRegistration = createRateLimiter(
    deps.registrationRateLimit ?? { limit: 10, windowMs: 10 * 60_000 },
  );

  async function readJsonBody(req: IncomingMessage): Promise<unknown> {
    const raw = await readBodyBuffer(req, maxBodyBytes);
    return raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
  }

  /** Every body-parse failure, answered as a client error rather than a 500. */
  function sendInputError(res: ServerResponse, err: unknown): void {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { error: "body_too_large", message: err.message });
      return;
    }
    if (err instanceof ConsoleInputError) {
      sendJson(res, 400, { error: err.code, message: err.message });
      return;
    }
    sendJson(res, 400, { error: "invalid_json" });
  }

  /** Session → user → tenant. The only way a console request gets a tenant. */
  async function resolveCaller(req: IncomingMessage): Promise<Caller | null> {
    const session = await deps.auth.api.getSession({ headers: headersOf(req) });
    if (!session?.user) return null;
    // A user created before the tenant hook existed, or whose hook failed,
    // would otherwise be signed in with nowhere to work.
    const tenant =
      (await deps.store.tenantForUser(session.user.id)) ??
      (await deps.store.ensureTenantForUser(session.user));
    return { user: session.user, tenant };
  }

  /**
   * What the definition would hit on this tenant's actual fleet. Never
   * throws: an advisory check must not be able to fail a publish, so a store
   * that will not answer simply yields no warnings.
   */
  async function callWarnings(
    caller: Caller,
    definition: WorkflowDefinition,
  ): Promise<Array<{ path: string; message: string }>> {
    try {
      const agents = await deps.store.listAgents(caller.tenant.id);
      return checkCallPayloads(definition, skillIndex(agents));
    } catch (err) {
      deps.logger?.error(
        { tenant: caller.tenant.slug, error: err instanceof Error ? err.message : String(err) },
        "could not check call payloads against the fleet",
      );
      return [];
    }
  }

  return async function handleConsole(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", deps.origin);
    if (!url.pathname.startsWith("/api/")) return false;

    try {
      // Better Auth owns its whole subtree: sign-up, sign-in, OAuth
      // callbacks, sign-out, session refresh.
      if (url.pathname.startsWith("/api/auth/")) {
        const response = await deps.auth.handler(
          await toFetchRequest(req, {
            origin: deps.origin,
            maxBodyBytes: deps.maxBodyBytes,
          }),
        );
        await writeFetchResponse(res, response);
        return true;
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        sendJson(res, 200, {
          user: {
            id: caller.user.id,
            email: caller.user.email,
            name: caller.user.name ?? null,
          },
          tenant: {
            slug: caller.tenant.slug,
            displayName: caller.tenant.displayName,
          },
        });
        return true;
      }

      if (url.pathname === "/api/agents") {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }

        if (req.method === "GET") {
          const agents = await deps.store.listAgents(caller.tenant.id);
          sendJson(res, 200, { agents: agents.map(agentView) });
          return true;
        }

        if (req.method === "POST") {
          if (!allowRegistration(caller.user.id)) {
            sendJson(res, 429, {
              error: "rate_limited",
              message: "too many registration attempts; try again shortly",
            });
            return true;
          }

          let input: ReturnType<typeof parseRegisterBody>;
          try {
            input = parseRegisterBody(await readJsonBody(req));
          } catch (err) {
            sendInputError(res, err);
            return true;
          }

          try {
            // The tenant comes from the session and from nowhere else — not
            // the path, not the body (docs §9.3).
            const { agent, token } = await deps.registration.register({
              tenantId: caller.tenant.id,
              ...input,
            });
            // The token is returned here and never again: only its hash is
            // stored (docs §9.4).
            sendJson(res, 201, { agent: agentView(agent), token });
          } catch (err) {
            if (err instanceof RegistrationError) {
              sendJson(res, REGISTRATION_STATUS[err.code] ?? 400, {
                error: err.code,
                message: err.message,
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        sendJson(res, 405, { error: "method_not_allowed" });
        return true;
      }

      // `/api/agents/{id}` and `/api/agents/{id}/token`. The id is the
      // tenant's own, so it is resolved inside the session's tenant and a
      // miss is a 404 either way — a 403 would confirm the id exists
      // somewhere else.
      const agentPath = /^\/api\/agents\/([^/]+)(?:\/(token|messages))?$/.exec(
        url.pathname,
      );
      if (agentPath) {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }

        const agentId = decodeURIComponent(agentPath[1]);
        const agent = await deps.store.getAgent(caller.tenant.id, agentId);
        if (!agent) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }

        if (agentPath[2] === "token") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "method_not_allowed" });
            return true;
          }
          const { token, revoked } = await deps.registration.rotateToken(agent);
          // Same contract as registration: this is the only time the value
          // exists outside the agent's own config (docs §9.4).
          sendJson(res, 200, { agentId: agent.agentId, token, revoked });
          return true;
        }

        if (agentPath[2] === "messages") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "method_not_allowed" });
            return true;
          }
          let message: ReturnType<typeof parseMessageBody>;
          try {
            message = parseMessageBody(await readJsonBody(req));
          } catch (err) {
            sendInputError(res, err);
            return true;
          }

          try {
            const task = await deps.messenger.send({
              tenantId: caller.tenant.id,
              userId: caller.user.id,
              target: agent,
              skillId: message.skillId,
              parts: message.parts,
            });
            // 202: the agent has taken it, and finishing may be hours away.
            // The page polls `/api/tasks/{id}` because a browser is not a
            // push target (docs §8).
            sendJson(res, 202, { task: taskView(task) });
          } catch (err) {
            if (err instanceof ConsoleDispatchError) {
              // The sender's own mistake (a skill that is not offered, a
              // payload the skill does not accept) against the agent being
              // unreachable — the first two are fixable in the form that
              // produced them, so they must not read as an upstream failure.
              const senderError =
                err.code === "unknown_skill" || err.code === "invalid_payload";
              sendJson(res, senderError ? 400 : 502, {
                error: err.code,
                message: err.message,
                ...(err.issues.length > 0 ? { issues: err.issues } : {}),
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        if (req.method === "GET") {
          sendJson(res, 200, { agent: agentView(agent) });
          return true;
        }

        if (req.method === "DELETE") {
          // The tasks this agent ran stay: they name it by text, and the
          // record of what happened is not the registry's to erase.
          const removed = await deps.store.deleteAgent(caller.tenant.id, agent.agentId);
          sendJson(res, 200, { agentId: agent.agentId, removed });
          return true;
        }

        if (req.method === "PATCH") {
          let changes: ReturnType<typeof parsePatchBody>;
          try {
            changes = parsePatchBody(await readJsonBody(req));
          } catch (err) {
            sendInputError(res, err);
            return true;
          }

          // Only a move costs an outbound request, so only a move is metered.
          if (changes.endpointUrl && !allowRegistration(caller.user.id)) {
            sendJson(res, 429, {
              error: "rate_limited",
              message: "too many endpoint changes; try again shortly",
            });
            return true;
          }

          try {
            const updated = await deps.registration.update(agent, changes);
            sendJson(res, 200, { agent: agentView(updated) });
          } catch (err) {
            if (err instanceof RegistrationError) {
              sendJson(res, REGISTRATION_STATUS[err.code] ?? 400, {
                error: err.code,
                message: err.message,
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        sendJson(res, 405, { error: "method_not_allowed" });
        return true;
      }

      const taskPath = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
      if (taskPath) {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return true;
        }
        const task = await deps.store.getTask(Number(taskPath[1]));
        // Another tenant's task is not found, not forbidden — the same rule
        // the gateway applies to agent ids.
        if (!task || task.tenantId !== caller.tenant.id) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }
        sendJson(res, 200, { task: taskView(task) });
        return true;
      }

      // ---- composition layer (docs §5, §7, §8) ----

      // `POST /api/workflows/validate` before the `:name` routes, so a
      // workflow can never be named "validate" out from under the editor.
      if (url.pathname === "/api/workflows/validate") {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return true;
        }
        let definition: WorkflowDefinition;
        try {
          definition = parseDefinitionBody(await readJsonBody(req));
        } catch (err) {
          sendInputError(res, err);
          return true;
        }
        // 200 with issues, not 400: the editor asked a question and got an
        // answer. An invalid draft is the normal case while typing.
        const issues = validateDefinition(definition);
        sendJson(res, 200, {
          valid: issues.length === 0,
          issues,
          // Checked against the fleet rather than against the definition:
          // whether anything offers each skill, and whether the payload
          // matches what that skill says it accepts. Advisory, because a
          // definition may be written before its agent is connected.
          warnings: await callWarnings(caller, definition),
        });
        return true;
      }

      if (url.pathname === "/api/workflows") {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return true;
        }
        if (!deps.workflows) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }
        sendJson(res, 200, {
          workflows: await deps.workflows.listDefinitions(caller.tenant.id),
        });
        return true;
      }

      // `/api/workflows/{name}/{version|latest}` and `/api/workflows/{name}/runs`.
      const workflowPath = /^\/api\/workflows\/([^/]+)\/(\d+|latest|runs)$/.exec(
        url.pathname,
      );
      if (workflowPath) {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        const name = decodeURIComponent(workflowPath[1]);
        const tail = workflowPath[2];

        if (tail === "runs") {
          if (req.method !== "POST") {
            sendJson(res, 405, { error: "method_not_allowed" });
            return true;
          }
          if (!deps.workflowStarter) {
            sendJson(res, 404, { error: "not_found" });
            return true;
          }
          let body: Record<string, unknown>;
          try {
            body = (await readJsonBody(req)) as Record<string, unknown>;
          } catch (err) {
            sendInputError(res, err);
            return true;
          }
          const version = body.version === undefined ? undefined : Number(body.version);
          if (version !== undefined && !Number.isInteger(version)) {
            sendJson(res, 400, {
              error: "invalid_body",
              message: "version must be an integer",
            });
            return true;
          }
          try {
            const started = await deps.workflowStarter.start({
              tenantId: caller.tenant.id,
              workflowName: name,
              ...(version === undefined ? {} : { version }),
              payload: (body.payload as Record<string, unknown>) ?? {},
              // The same `user:{id}` the messenger stamps on a person's
              // message (docs §8), so "who started this" stays one readable
              // kind of value across the ledger.
              createdBy: `user:${caller.user.id}`,
              sourceType: "console",
              // The page sends a ref per submission, so a double-click lands
              // on the run the first click opened rather than a second one.
              sourceRef: str(body, "sourceRef") ?? randomUUID(),
            });
            sendJson(res, started.deduplicated ? 200 : 201, {
              run: runView(started.run),
              deduplicated: started.deduplicated,
            });
          } catch (err) {
            // Starting before publishing, or with a payload the definition's
            // required vars are not satisfied by, is an ordinary mistake made
            // from a form — not a server fault. Reporting it as a 500 would
            // tell the one person who can fix it nothing about what to fix.
            if (err instanceof WorkflowDriverError) {
              sendJson(res, 404, { error: "unknown_workflow", message: err.message });
              return true;
            }
            if (err instanceof WorkflowError) {
              sendJson(res, 400, { error: "invalid_payload", message: err.message });
              return true;
            }
            // No agent offers the first step's skill, or several do and the
            // definition names none of them. Neither can succeed on a retry,
            // so the driver has already ended the run — the id is returned
            // because that run is in the list and this is its explanation.
            if (err instanceof WorkflowRunFailed) {
              sendJson(res, 409, {
                error: err.code,
                message: err.message,
                runId: err.runId,
                runState: "failed",
              });
              return true;
            }
            // The agent was unreachable, which is worth another try. Nothing
            // retries a *first* step though — there is no task row yet — so
            // this run is created and then stays where it is.
            if (err instanceof WorkflowDispatchError) {
              sendJson(res, 502, {
                error: err.code,
                message: err.message,
                strandedRun: true,
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        if (!deps.workflows) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }
        const version = tail === "latest" ? undefined : Number(tail);

        if (req.method === "GET") {
          const found = await deps.workflows.findDefinition(
            caller.tenant.id,
            name,
            version,
          );
          if (!found) {
            sendJson(res, 404, { error: "not_found" });
            return true;
          }
          sendJson(res, 200, {
            id: found.id,
            name,
            version: version ?? null,
            definition: found.definition,
          });
          return true;
        }

        // `latest` is a read alias: publishing always names its version, so
        // two editors cannot silently write the same one thinking otherwise.
        if (version === undefined) {
          sendJson(res, 405, { error: "method_not_allowed" });
          return true;
        }

        if (req.method === "PUT") {
          let definition: WorkflowDefinition;
          try {
            definition = parseDefinitionBody(await readJsonBody(req));
          } catch (err) {
            sendInputError(res, err);
            return true;
          }
          // Publishing is the gate. The editor validates as you type, but a
          // definition that reaches the store has to be one that can run:
          // the alternative breaks hours into real work (docs §7).
          const issues = validateDefinition(definition);
          if (issues.length > 0) {
            sendJson(res, 400, { error: "invalid_definition", issues });
            return true;
          }
          // Gathered before the write, so a publish reports the fleet as it
          // stood when the decision was made.
          const warnings = await callWarnings(caller, definition);
          const saved = await deps.workflows.putDefinition({
            tenantId: caller.tenant.id,
            name,
            version,
            definition,
          });
          sendJson(res, 200, { id: saved.id, name, version, warnings });
          return true;
        }

        sendJson(res, 405, { error: "method_not_allowed" });
        return true;
      }

      // `/api/runs`, `/api/runs/{id}` and `/api/runs/{id}/events` — where the
      // standalone viewer's job moves to, without its "paste an agent token"
      // compromise (docs §4).
      const runsPath = /^\/api\/runs(?:\/(\d+)(?:\/(events))?)?$/.exec(url.pathname);
      if (runsPath) {
        const caller = await resolveCaller(req);
        if (!caller) {
          sendJson(res, 401, { error: "unauthenticated" });
          return true;
        }
        if (req.method !== "GET") {
          sendJson(res, 405, { error: "method_not_allowed" });
          return true;
        }
        if (!deps.workflows) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }

        if (!runsPath[1]) {
          const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 200);
          const runs = await deps.workflows.listRuns(caller.tenant.id, limit);
          sendJson(res, 200, { runs: runs.map(runView) });
          return true;
        }

        const runId = Number(runsPath[1]);
        // Resolved inside the session's tenant, so another tenant's run is
        // not found rather than forbidden — same rule as agent ids (§9.3).
        const run = await deps.workflows.getRun(caller.tenant.id, runId);
        if (!run) {
          sendJson(res, 404, { error: "not_found" });
          return true;
        }
        if (runsPath[2] === "events") {
          sendJson(res, 200, {
            events: await deps.workflows.listRunEvents(caller.tenant.id, runId),
          });
          return true;
        }
        sendJson(res, 200, { run: runView(run) });
        return true;
      }

      sendJson(res, 404, { error: "not_found" });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.logger?.error(
        { path: url.pathname, method: req.method, error },
        "console request failed",
      );
      sendJson(res, 500, { error: "internal_error" });
      return true;
    }
  };
}
