import type { A2AAgentCard, A2APart, FleetTaskState, PushNotificationConfig } from "../protocol/a2a.js";
import type { A2AClient, AgentCredential } from "./a2aClient.js";
import { validateDefinition, type WorkflowDefinition } from "../workflow/engine.js";
import type { WorkflowRunRecord } from "../workflow/driver.js";
import type { FleetTaskRecord, GatewayAgentRecord, TenantRecord } from "./gatewayStore.js";

/**
 * The gateway's *server* half (docs §2): what callers talk to. Both ends see
 * ordinary A2A — the caller never learns a target's real address, and the
 * target never learns who the caller was.
 */

/** Only what dispatch needs, so tests can supply a fake without a database. */
export interface GatewayStorePort {
  getTenantBySlug(slug: string): Promise<TenantRecord | null>;
  resolveAgentToken(
    tokenHash: string,
  ): Promise<{ tenantId: number; agentId: string } | null>;
  getAgent(tenantId: number, agentId: string): Promise<GatewayAgentRecord | null>;
  listAgents(tenantId: number): Promise<GatewayAgentRecord[]>;
  findAgentsBySkill(
    tenantId: number,
    skillId: string,
  ): Promise<GatewayAgentRecord[]>;
  createTask(input: {
    tenantId: number;
    upstreamTaskId: string;
    callerAgentId: string;
    callerCallbackUrl?: string | null;
    callerCallbackAuth?: PushNotificationConfig["authentication"] | null;
    targetAgentId: string;
    skillId: string;
    deadlineAt: Date;
  }): Promise<FleetTaskRecord>;
  attachDownstream(
    taskId: number,
    input: { downstreamTaskId: string; callbackTokenHash: string },
  ): Promise<void>;
  failTask(taskId: number, result: unknown): Promise<void>;
  getTaskByUpstreamId(
    tenantId: number,
    upstreamTaskId: string,
  ): Promise<FleetTaskRecord | null>;
  appendTaskEvent(input: {
    tenantId: number;
    taskId: number;
    eventType: string;
    payload: unknown;
  }): Promise<void>;
}

export interface CredentialResolver {
  (tenantId: number, agentId: string): Promise<AgentCredential | null>;
}

/** The composition layer, when the site has one wired in. */
export interface GatewayWorkflowsPort {
  putDefinition(input: {
    tenantId: number;
    name: string;
    version: number;
    definition: WorkflowDefinition;
  }): Promise<{ id: number }>;
  listDefinitions(
    tenantId: number,
  ): Promise<Array<{ id: number; name: string; version: number }>>;
  getRun(tenantId: number, runId: number): Promise<WorkflowRunRecord | null>;
  listRuns(tenantId: number, limit?: number): Promise<WorkflowRunRecord[]>;
  listRunEvents(
    tenantId: number,
    runId: number,
  ): Promise<Array<{ eventType: string; payload: unknown; createdAt: string }>>;
}

export interface GatewayWorkflowStarter {
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

export interface GatewayDeps {
  store: GatewayStorePort;
  workflows?: GatewayWorkflowsPort;
  workflowStarter?: GatewayWorkflowStarter;
  client: A2AClient;
  credentials: CredentialResolver;
  /** Public base URL of this site, e.g. `https://fleet.example.com`. */
  publicBaseUrl: string;
  newUpstreamTaskId(): string;
  newCallbackToken(): string;
  hashToken(token: string): string;
  now?(): Date;
  /** Used when the caller does not supply a deadline. */
  defaultTaskTtlMs?: number;
}

export interface GatewayRequest {
  method: string;
  path: string;
  bearerToken: string | null;
  body?: unknown;
}

export interface GatewayResponse {
  status: number;
  body: unknown;
}

const DEFAULT_TASK_TTL_MS = 6 * 60 * 60 * 1000;

/** Internal ledger state → the state name A2A callers expect. */
export function a2aTaskState(state: FleetTaskState): string {
  switch (state) {
    case "dispatching":
      return "submitted";
    case "running":
      return "working";
    case "done_pending_notify":
    case "done":
      return "completed";
    case "cancelled":
      return "canceled";
    case "failed":
    case "timed_out":
      return "failed";
  }
}

function jsonRpcError(id: unknown, code: number, message: string): GatewayResponse {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

function jsonRpcResult(id: unknown, result: unknown): GatewayResponse {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, result } };
}

/**
 * Cross-tenant and unknown look identical from outside: a `403` would confirm
 * that some other tenant owns that agent id, which is exactly the enumeration
 * we are preventing (docs §9.2).
 */
const NOT_FOUND: GatewayResponse = { status: 404, body: { error: "not_found" } };
const UNAUTHORIZED: GatewayResponse = { status: 401, body: { error: "unauthorized" } };

const AGENT_PATH = /^\/a2a\/t\/([^/]+)\/agents\/([^/]+)$/;
const WORKFLOWS_PATH = /^\/a2a\/t\/([^/]+)\/workflows$/;
const WORKFLOW_DEF_PATH = /^\/a2a\/t\/([^/]+)\/workflows\/([^/]+)\/(\d+)$/;
const WORKFLOW_RUNS_PATH = /^\/a2a\/t\/([^/]+)\/workflows\/([^/]+)\/runs$/;
const WORKFLOW_RUN_LIST_PATH = /^\/a2a\/t\/([^/]+)\/workflows\/runs$/;
const WORKFLOW_RUN_PATH = /^\/a2a\/t\/([^/]+)\/workflows\/runs\/(\d+)$/;
const WORKFLOW_RUN_EVENTS_PATH = /^\/a2a\/t\/([^/]+)\/workflows\/runs\/(\d+)\/events$/;
const CARD_PATH = /^\/a2a\/t\/([^/]+)\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/;
const CATALOG_PATH = /^\/a2a\/t\/([^/]+)\/catalog$/;

export function gatewayAgentUrl(
  publicBaseUrl: string,
  tenantSlug: string,
  agentId: string,
): string {
  return new URL(
    `/a2a/t/${encodeURIComponent(tenantSlug)}/agents/${encodeURIComponent(agentId)}`,
    publicBaseUrl,
  ).toString();
}

/**
 * The card a caller sees. The real `url` is replaced with the gateway's, and
 * streaming is stripped: the gateway forwards `message/send` only, so
 * advertising streaming would invite a call it will not relay (docs §12).
 */
export function rewriteCard(
  card: A2AAgentCard,
  publicBaseUrl: string,
  tenantSlug: string,
  agentId: string,
): A2AAgentCard {
  const { securitySchemes: _ignored, ...rest } = card;
  return {
    ...rest,
    url: gatewayAgentUrl(publicBaseUrl, tenantSlug, agentId),
    capabilities: {
      ...(card.capabilities ?? {}),
      streaming: false,
      pushNotifications: true,
    },
  };
}


function runJson(run: WorkflowRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    workflowId: run.workflowId,
    state: run.state,
    status: run.status,
    reason: run.reason,
    vars: run.vars,
    sourceType: run.sourceType,
    sourceRef: run.sourceRef,
    /** `null` while the run waits for one of the tenant's concurrency slots. */
    admittedAt: run.admittedAt ?? null,
    updatedAt: run.updatedAt ?? null,
  };
}

interface Caller {
  tenant: TenantRecord;
  agentId: string;
}

export function createGateway(deps: GatewayDeps) {
  const now = deps.now ?? (() => new Date());
  const ttl = deps.defaultTaskTtlMs ?? DEFAULT_TASK_TTL_MS;

  /**
   * Resolve the caller. The token is authoritative; the tenant in the path is
   * only a legibility aid and must agree with it (docs §3.1).
   */
  async function authenticate(
    req: GatewayRequest,
    tenantSlug: string,
  ): Promise<Caller | null> {
    if (!req.bearerToken) return null;
    const identity = await deps.store.resolveAgentToken(
      deps.hashToken(req.bearerToken),
    );
    if (!identity) return null;
    const tenant = await deps.store.getTenantBySlug(tenantSlug);
    if (!tenant || tenant.id !== identity.tenantId) return null;
    return { tenant, agentId: identity.agentId };
  }

  async function dispatch(
    caller: Caller,
    target: GatewayAgentRecord,
    tenantSlug: string,
    params: {
      id: unknown;
      parts: A2APart[];
      skillId: string;
      callerPush: PushNotificationConfig | null;
      deadlineAt: Date;
    },
  ): Promise<GatewayResponse> {
    const upstreamTaskId = deps.newUpstreamTaskId();

    // ① The caller's request is durable before anything leaves this process.
    const task = await deps.store.createTask({
      tenantId: caller.tenant.id,
      upstreamTaskId,
      callerAgentId: caller.agentId,
      callerCallbackUrl: params.callerPush?.url ?? null,
      callerCallbackAuth: params.callerPush?.authentication ?? null,
      targetAgentId: target.agentId,
      skillId: params.skillId,
      deadlineAt: params.deadlineAt,
    });

    // ② Arm the callback, then hand the work down.
    const callbackToken = deps.newCallbackToken();
    const credential = await deps.credentials(caller.tenant.id, target.agentId);
    try {
      const sent = await deps.client.sendMessage({
        endpointUrl: target.endpointUrl,
        credential,
        parts: params.parts,
        skillId: params.skillId,
        deadlineAt: params.deadlineAt,
        contextId: upstreamTaskId,
        pushNotificationConfig: {
          url: new URL(
            `/a2a/callbacks/${callbackToken}`,
            deps.publicBaseUrl,
          ).toString(),
          token: callbackToken,
        },
      });
      await deps.store.attachDownstream(task.id, {
        downstreamTaskId: sent.taskId,
        callbackTokenHash: deps.hashToken(callbackToken),
      });
      await deps.store.appendTaskEvent({
        tenantId: caller.tenant.id,
        taskId: task.id,
        eventType: "dispatched",
        payload: { targetAgentId: target.agentId, downstreamTaskId: sent.taskId },
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await deps.store.failTask(task.id, { error });
      await deps.store.appendTaskEvent({
        tenantId: caller.tenant.id,
        taskId: task.id,
        eventType: "dispatch_failed",
        payload: { error },
      });
      return jsonRpcError(params.id, -32603, `dispatch failed: ${error}`);
    }

    return jsonRpcResult(params.id, {
      id: upstreamTaskId,
      contextId: upstreamTaskId,
      status: { state: "submitted", timestamp: now().toISOString() },
      metadata: { deadlineAt: params.deadlineAt.toISOString() },
    });
  }

  async function handleJsonRpc(
    req: GatewayRequest,
    caller: Caller,
    tenantSlug: string,
    target: GatewayAgentRecord,
  ): Promise<GatewayResponse> {
    const body = req.body as
      | { id?: unknown; method?: string; params?: Record<string, unknown> }
      | undefined;
    if (!body || typeof body.method !== "string") {
      return jsonRpcError(body?.id, -32600, "invalid request");
    }

    switch (body.method) {
      case "message/send": {
        const params = (body.params ?? {}) as {
          message?: { parts?: A2APart[] };
          configuration?: { pushNotificationConfig?: PushNotificationConfig };
          metadata?: { skillId?: string; deadlineAt?: string };
        };
        const parts = params.message?.parts;
        if (!Array.isArray(parts) || parts.length === 0) {
          return jsonRpcError(body.id, -32602, "params.message.parts is required");
        }

        // A2A carries no skill id in the envelope. Take it from metadata, and
        // fall back only when the target advertises exactly one skill.
        const skills = target.card.skills ?? [];
        const skillId =
          params.metadata?.skillId ?? (skills.length === 1 ? skills[0].id : undefined);
        if (!skillId) {
          return jsonRpcError(body.id, -32602, "params.metadata.skillId is required");
        }
        if (!skills.some((s) => s.id === skillId)) {
          return jsonRpcError(body.id, -32602, `unknown skill: ${skillId}`);
        }

        const deadlineAt = params.metadata?.deadlineAt
          ? new Date(params.metadata.deadlineAt)
          : new Date(now().getTime() + ttl);
        if (Number.isNaN(deadlineAt.getTime())) {
          return jsonRpcError(body.id, -32602, "params.metadata.deadlineAt is invalid");
        }

        return dispatch(caller, target, tenantSlug, {
          id: body.id,
          parts,
          skillId,
          callerPush: params.configuration?.pushNotificationConfig ?? null,
          deadlineAt,
        });
      }

      case "tasks/get": {
        const params = (body.params ?? {}) as { id?: string };
        if (!params.id) return jsonRpcError(body.id, -32602, "params.id is required");
        const task = await deps.store.getTaskByUpstreamId(
          caller.tenant.id,
          params.id,
        );
        // A task belongs to the agent that created it.
        if (!task || task.callerAgentId !== caller.agentId) {
          return jsonRpcError(body.id, -32001, "task not found");
        }
        return jsonRpcResult(body.id, {
          id: task.upstreamTaskId,
          contextId: task.upstreamTaskId,
          status: { state: a2aTaskState(task.state), timestamp: task.updatedAt },
          ...(task.result ? { artifacts: [{ parts: [{ kind: "data", data: task.result }] }] } : {}),
          metadata: { deadlineAt: task.deadlineAt, attempt: task.attempt },
        });
      }

      default:
        return jsonRpcError(body.id, -32601, `unsupported method: ${body.method}`);
    }
  }

  return async function handle(req: GatewayRequest): Promise<GatewayResponse> {
    const cardMatch = CARD_PATH.exec(req.path);
    if (cardMatch && req.method === "GET") {
      const [, tenantSlug, agentId] = cardMatch.map(decodeURIComponent);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      const agent = await deps.store.getAgent(caller.tenant.id, agentId);
      if (!agent) return NOT_FOUND;
      return {
        status: 200,
        body: rewriteCard(agent.card, deps.publicBaseUrl, tenantSlug, agentId),
      };
    }

    const catalogMatch = CATALOG_PATH.exec(req.path);
    if (catalogMatch && req.method === "GET") {
      const tenantSlug = decodeURIComponent(catalogMatch[1]);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      const agents = await deps.store.listAgents(caller.tenant.id);
      return {
        status: 200,
        body: {
          agents: agents.map((a) => ({
            agentId: a.agentId,
            url: gatewayAgentUrl(deps.publicBaseUrl, tenantSlug, a.agentId),
            health: a.health,
            card: rewriteCard(a.card, deps.publicBaseUrl, tenantSlug, a.agentId),
          })),
        },
      };
    }

    // ---- composition layer ----

    const defMatch = WORKFLOW_DEF_PATH.exec(req.path);
    if (defMatch && req.method === "PUT") {
      const [, tenantSlug, name, version] = defMatch.map(decodeURIComponent);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      if (!deps.workflows) return NOT_FOUND;

      const definition = req.body as WorkflowDefinition | undefined;
      if (!definition || typeof definition !== "object") {
        return { status: 400, body: { error: "a workflow definition is required" } };
      }
      // Publish-time validation. A definition that breaks mid-run would do so
      // hours into real work (docs §2).
      const issues = validateDefinition(definition);
      if (issues.length > 0) {
        return { status: 400, body: { error: "invalid_definition", issues } };
      }
      const saved = await deps.workflows.putDefinition({
        tenantId: caller.tenant.id,
        name,
        version: Number(version),
        definition,
      });
      return { status: 200, body: { id: saved.id, name, version: Number(version) } };
    }

    const workflowsMatch = WORKFLOWS_PATH.exec(req.path);
    if (workflowsMatch && req.method === "GET") {
      const tenantSlug = decodeURIComponent(workflowsMatch[1]);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      if (!deps.workflows) return NOT_FOUND;
      return {
        status: 200,
        body: { workflows: await deps.workflows.listDefinitions(caller.tenant.id) },
      };
    }

    const runsMatch = WORKFLOW_RUNS_PATH.exec(req.path);
    if (runsMatch && req.method === "POST") {
      const [, tenantSlug, name] = runsMatch.map(decodeURIComponent);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      if (!deps.workflowStarter) return NOT_FOUND;

      const body = (req.body ?? {}) as {
        payload?: Record<string, unknown>;
        version?: number;
        sourceRef?: string;
      };
      const stamp = deps.newUpstreamTaskId();
      const started = await deps.workflowStarter.start({
        tenantId: caller.tenant.id,
        workflowName: name,
        version: body.version,
        payload: body.payload ?? {},
        createdBy: caller.agentId,
        sourceType: "a2a",
        // Without a stable ref from the caller, each request is its own run;
        // supplying one is how a retrying caller gets deduplication.
        sourceRef: body.sourceRef ?? stamp,
      });
      return {
        status: started.deduplicated ? 200 : 201,
        body: { run: runJson(started.run), deduplicated: started.deduplicated },
      };
    }

    const runEventsMatch = WORKFLOW_RUN_EVENTS_PATH.exec(req.path);
    if (runEventsMatch && req.method === "GET") {
      const [, tenantSlug, runId] = runEventsMatch.map(decodeURIComponent);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      if (!deps.workflows) return NOT_FOUND;
      const run = await deps.workflows.getRun(caller.tenant.id, Number(runId));
      if (!run) return NOT_FOUND;
      return {
        status: 200,
        body: {
          events: await deps.workflows.listRunEvents(caller.tenant.id, Number(runId)),
        },
      };
    }

    const runListMatch = WORKFLOW_RUN_LIST_PATH.exec(req.path);
    if (runListMatch && req.method === "GET") {
      const tenantSlug = decodeURIComponent(runListMatch[1]);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      if (!deps.workflows) return NOT_FOUND;
      const runs = await deps.workflows.listRuns(caller.tenant.id, 100);
      return { status: 200, body: { runs: runs.map(runJson) } };
    }

    const runMatch = WORKFLOW_RUN_PATH.exec(req.path);
    if (runMatch && req.method === "GET") {
      const [, tenantSlug, runId] = runMatch.map(decodeURIComponent);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      if (!deps.workflows) return NOT_FOUND;
      const run = await deps.workflows.getRun(caller.tenant.id, Number(runId));
      if (!run) return NOT_FOUND;
      return { status: 200, body: { run: runJson(run) } };
    }

    const agentMatch = AGENT_PATH.exec(req.path);
    if (agentMatch && req.method === "POST") {
      const [, tenantSlug, agentId] = agentMatch.map(decodeURIComponent);
      const caller = await authenticate(req, tenantSlug);
      if (!caller) return UNAUTHORIZED;
      // Resolution happens strictly inside the caller's tenant, so another
      // tenant's same-named agent is simply not in the search set (docs §9).
      const target = await deps.store.getAgent(caller.tenant.id, agentId);
      if (!target) return NOT_FOUND;
      return handleJsonRpc(req, caller, tenantSlug, target);
    }

    return NOT_FOUND;
  };
}
