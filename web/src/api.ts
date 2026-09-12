export interface Me {
  user: { id: string; email: string; name: string | null };
  tenant: { slug: string; displayName: string };
}

/** A single field's complaint, from the skill's own `inputSchema`. */
export interface PayloadIssue {
  /** Dotted path into the payload, e.g. `pr` or `files[0].path`. */
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Present when the server checked a payload against a schema and it
     *  did not match — one entry per field. */
    readonly issues: PayloadIssue[] = [],
    /** Present when a run was created and then ended by the same request. */
    readonly runId?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The console API. Cookies ride along; nothing here handles a token. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
      issues?: PayloadIssue[];
      runId?: number;
    };
    // `message` says what is actually wrong ("agent card request returned
    // 404"); `error` is the machine code behind it. Showing the code alone
    // would turn every failure into a word the user has to guess at.
    throw new ApiError(
      body.message ?? body.error ?? `request failed (${res.status})`,
      res.status,
      body.issues ?? [],
      body.runId,
    );
  }
  return (await res.json()) as T;
}

export const getMe = () => api<Me>("/api/me");

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  /** JSON Schema captured from the card at registration; may be absent. */
  inputSchema: unknown | null;
}

export interface AgentStats {
  totalRuns: number;
  succeeded: number;
  failed: number;
  running: number;
  /** `createdAt` of the oldest still-active run; null when none are active. */
  runningSince: string | null;
}

export interface Agent {
  agentId: string;
  displayName: string;
  endpointUrl: string;
  health: "unknown" | "healthy" | "unreachable" | "stale";
  skills: AgentSkill[];
  cardFetchedAt: string | null;
  lastSeenAt: string | null;
  stats: AgentStats;
}

export interface RegisterAgentInput {
  agentId: string;
  endpointUrl: string;
  displayName?: string;
  /** What the gateway presents when it calls the agent — the other direction
   *  from the token this call returns. */
  credential?: { scheme: "bearer" | "apiKey"; secret: string; headerName?: string };
}

export const listAgents = () => api<{ agents: Agent[] }>("/api/agents");

export const getAgent = (agentId: string) =>
  api<{ agent: Agent }>(`/api/agents/${encodeURIComponent(agentId)}`);

export const deleteAgent = (agentId: string) =>
  api<{ agentId: string; removed: boolean }>(
    `/api/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE" },
  );

/** The token in the reply is shown once and never recoverable. */
export const registerAgent = (input: RegisterAgentInput) =>
  api<{ agent: Agent; token: string }>("/api/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });

/** Issued once, exactly like the one registration returns: rotating retires
 *  every earlier token the moment this resolves. */
export const rotateAgentToken = (agentId: string) =>
  api<{ agentId: string; token: string; revoked: number }>(
    `/api/agents/${encodeURIComponent(agentId)}/token`,
    { method: "POST" },
  );

export interface AgentPatch {
  displayName?: string;
  endpointUrl?: string;
  /** `null` clears the stored credential; omitting it leaves it alone. */
  credential?: RegisterAgentInput["credential"] | null;
}

export const updateAgent = (agentId: string, changes: AgentPatch) =>
  api<{ agent: Agent }>(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: JSON.stringify(changes),
  });

export type TaskState =
  | "dispatching"
  | "running"
  | "done_pending_notify"
  | "done"
  | "cancelled"
  | "failed"
  | "timed_out";

export interface Task {
  id: number;
  upstreamTaskId: string;
  callerAgentId: string;
  targetAgentId: string;
  skillId: string;
  state: TaskState;
  result: unknown;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A person's message to an agent. Accepted, not finished: the reply arrives
 *  by callback hours later, so the page polls `getTask`. */
export const sendAgentMessage = (
  agentId: string,
  body: { skillId: string; text?: string; data?: unknown },
) =>
  api<{ task: Task }>(`/api/agents/${encodeURIComponent(agentId)}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getTask = (id: number) => api<{ task: Task }>(`/api/tasks/${id}`);

// ---- composition layer (docs/fleet-console.md §7, §8) ----

export interface WorkflowSummary {
  id: number;
  name: string;
  version: number;
}

/** Mirrors `WorkflowDefinition` in the engine. Kept structural rather than
 *  exhaustive: the editor edits text, and the server owns the rules. */
export interface WorkflowTransition {
  when?: string;
  set?: Record<string, unknown>;
  goto?: string;
  fail?: string;
  escalate?: string;
}

export interface WorkflowState {
  status?: string;
  call?: { skill: string; payload?: Record<string, unknown> };
  set?: Record<string, unknown>;
  next?: WorkflowTransition[];
}

export interface WorkflowDefinition {
  workflow: string;
  version: number;
  description?: string;
  vars?: Record<string, unknown>;
  limits?: Record<string, number>;
  start: WorkflowTransition[];
  states: Record<string, WorkflowState>;
  resume?: WorkflowTransition[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Two kinds of finding, deliberately separate:
 *
 *   `issues` are the definition against itself — a `goto` with nowhere to go.
 *   They block publishing.
 *
 *   `warnings` are the definition against the fleet it will run on — nothing
 *   offers this skill, this payload is not what that skill accepts. They do
 *   not block: a definition may be written before its agent is connected.
 */

export interface WorkflowRun {
  id: number;
  workflowId: number;
  state: string;
  status: string;
  reason: string | null;
  vars: Record<string, unknown>;
  sourceType: string;
  sourceRef: string;
  /** The step the run is sitting on, or null when nothing is in flight. */
  awaitingTaskId: number | null;
  updatedAt: string | null;
}

export interface RunEvent {
  eventType: string;
  payload: unknown;
  createdAt: string;
}

export const listWorkflows = () => api<{ workflows: WorkflowSummary[] }>("/api/workflows");

/** `version` omitted reads the latest, which is what the editor opens with. */
export const getWorkflow = (name: string, version?: number) =>
  api<{ id: number; name: string; version: number | null; definition: WorkflowDefinition }>(
    `/api/workflows/${encodeURIComponent(name)}/${version ?? "latest"}`,
  );

/** Checks without saving, so the editor can say what is wrong while typing.
 *  An invalid draft answers 200 with issues — it is not a failed request. */
export const validateWorkflow = (definition: unknown) =>
  api<{ valid: boolean; issues: ValidationIssue[]; warnings: ValidationIssue[] }>("/api/workflows/validate", {
    method: "POST",
    body: JSON.stringify(definition),
  });

/** Publishing is a version. In-flight runs stay bound to the version they
 *  started on, which is what makes editing safe. */
export const publishWorkflow = (name: string, version: number, definition: unknown) =>
  api<{ id: number; name: string; version: number; warnings: ValidationIssue[] }>(
    `/api/workflows/${encodeURIComponent(name)}/${version}`,
    { method: "PUT", body: JSON.stringify(definition) },
  );

/** `sourceRef` is what stops a double-click from opening two runs. */
export const startRun = (
  name: string,
  body: { payload?: Record<string, unknown>; version?: number; sourceRef?: string },
) =>
  api<{ run: WorkflowRun; deduplicated: boolean }>(
    `/api/workflows/${encodeURIComponent(name)}/runs`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const listRuns = (limit = 100) =>
  api<{ runs: WorkflowRun[] }>(`/api/runs?limit=${limit}`);

export const getRun = (id: number) => api<{ run: WorkflowRun }>(`/api/runs/${id}`);

export const getRunEvents = (id: number) =>
  api<{ events: RunEvent[] }>(`/api/runs/${id}/events`);
