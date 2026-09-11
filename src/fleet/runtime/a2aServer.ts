import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  A2AAgentCard,
  A2APart,
  PushNotificationConfig,
} from "../protocol/a2a.js";

/**
 * The A2A *server* half every fleet agent needs (docs §2). dev, review and
 * pr-merge are pure servers; workflow-agent is this plus an A2A client.
 *
 * Shape of the contract: `message/send` accepts the work and returns a task
 * id immediately — it never holds the connection while the work runs, because
 * the work is hours long (docs §8). Completion travels back over the
 * `pushNotificationConfig` the caller supplied.
 */

export interface A2AServerLogger {
  info(data: Record<string, unknown>, message?: string): void;
  warn?(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
}

export type SkillHandler = (input: {
  parts: A2APart[];
  taskId: string;
  deadlineAt: Date | null;
  signal: AbortSignal;
}) => Promise<unknown>;

export type AgentTaskState = "submitted" | "working" | "completed" | "failed";

export interface AgentTask {
  id: string;
  skillId: string;
  state: AgentTaskState;
  result: unknown | null;
  error: string | null;
  push: PushNotificationConfig | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory task registry.
 *
 * A restart loses in-flight tasks, unlike the old lease model where an
 * expiring lease returned the message to the queue. The system still degrades
 * correctly rather than hanging: the gateway's `deadline_at` sweep marks the
 * task `timed_out` and tells the caller (docs §8). Swap in a durable
 * implementation here if an agent needs restart-survival.
 */
export class InMemoryTaskStore {
  private readonly tasks = new Map<string, AgentTask>();

  create(input: {
    skillId: string;
    push: PushNotificationConfig | null;
  }): AgentTask {
    const now = new Date().toISOString();
    const task: AgentTask = {
      id: randomUUID(),
      skillId: input.skillId,
      state: "submitted",
      result: null,
      error: null,
      push: input.push,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(id: string): AgentTask | null {
    return this.tasks.get(id) ?? null;
  }

  update(id: string, patch: Partial<AgentTask>): AgentTask | null {
    const task = this.tasks.get(id);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    return task;
  }
}

export interface A2AServerResponse {
  status: number;
  body: unknown;
}

export interface A2AServerRequest {
  method: string;
  path: string;
  bearerToken: string | null;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface A2AServerOptions {
  card: A2AAgentCard;
  /** One handler per skill id advertised in the card. */
  skills: Record<string, SkillHandler>;
  /**
   * Verifies the caller is our gateway. Compare in constant time; an agent
   * that skips this will run work for anyone who can reach it.
   */
  authenticate(req: A2AServerRequest): boolean;
  store?: InMemoryTaskStore;
  fetchImpl?: typeof fetch;
  logger?: A2AServerLogger;
  /** Retries for the completion callback, mirroring the gateway's own. */
  notifyAttempts?: number;
  notifyBaseDelayMs?: number;
  sleep?(ms: number): Promise<void>;
}

function rpcError(id: unknown, code: number, message: string): A2AServerResponse {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
  };
}

function rpcResult(id: unknown, result: unknown): A2AServerResponse {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, result } };
}

function taskToA2A(task: AgentTask): Record<string, unknown> {
  return {
    id: task.id,
    contextId: task.id,
    status: { state: task.state, timestamp: task.updatedAt },
    ...(task.result === null
      ? {}
      : { artifacts: [{ parts: [{ kind: "data", data: task.result }] }] }),
    ...(task.error ? { metadata: { error: task.error } } : {}),
  };
}

export function createA2AServer(opts: A2AServerOptions) {
  const store = opts.store ?? new InMemoryTaskStore();
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts = opts.notifyAttempts ?? 5;
  const baseDelay = opts.notifyBaseDelayMs ?? 2_000;

  /**
   * Report completion to whoever asked. Retried, because the gateway may be
   * rolling when we finish — and if every attempt fails the gateway's own
   * deadline sweep is the backstop.
   */
  async function notify(task: AgentTask): Promise<void> {
    if (!task.push) return;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (task.push.token) headers.authorization = `Bearer ${task.push.token}`;
    const payload = JSON.stringify({
      taskId: task.id,
      status: { state: task.state },
      ...(task.result === null ? {} : { result: task.result }),
      ...(task.error ? { error: task.error } : {}),
    });

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const res = await doFetch(task.push.url, {
          method: "POST",
          headers,
          body: payload,
        });
        if (res.ok) return;
        opts.logger?.warn?.(
          { taskId: task.id, attempt, status: res.status },
          "a2a completion callback rejected",
        );
      } catch (err) {
        opts.logger?.warn?.(
          {
            taskId: task.id,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          },
          "a2a completion callback failed",
        );
      }
      if (attempt < attempts) await sleep(baseDelay * 2 ** (attempt - 1));
    }

    opts.logger?.error(
      { taskId: task.id, skillId: task.skillId },
      "a2a completion callback exhausted its retries",
    );
  }

  async function run(task: AgentTask, input: {
    parts: A2APart[];
    deadlineAt: Date | null;
  }): Promise<void> {
    const handler = opts.skills[task.skillId];
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;

    if (input.deadlineAt && input.deadlineAt.getTime() <= Date.now()) {
      // Already out of time. Starting the handler would burn an hour of
      // Codex/Claude budget on a result nobody is waiting for any more.
      store.update(task.id, {
        state: "failed",
        error: "deadline had already passed when the task was received",
      });
      const expired = store.get(task.id);
      if (expired) await notify(expired);
      return;
    }
    if (input.deadlineAt) {
      timer = setTimeout(
        () => controller.abort(),
        input.deadlineAt.getTime() - Date.now(),
      );
      timer.unref?.();
    }

    store.update(task.id, { state: "working" });
    try {
      const result = await handler({
        parts: input.parts,
        taskId: task.id,
        deadlineAt: input.deadlineAt,
        signal: controller.signal,
      });
      store.update(task.id, { state: "completed", result });
      opts.logger?.info(
        { taskId: task.id, skillId: task.skillId },
        "a2a task completed",
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      store.update(task.id, { state: "failed", error });
      opts.logger?.error(
        { taskId: task.id, skillId: task.skillId, error },
        "a2a task failed",
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const finished = store.get(task.id);
    if (finished) await notify(finished);
  }

  /** Resolves once every background task settles. Tests use this. */
  const inFlight = new Set<Promise<void>>();
  async function drain(): Promise<void> {
    while (inFlight.size > 0) {
      await Promise.all([...inFlight]);
    }
  }

  async function handle(req: A2AServerRequest): Promise<A2AServerResponse> {
    if (req.method === "GET" && req.path === "/.well-known/agent-card.json") {
      // The card is public by design: it is how the gateway discovers us.
      return { status: 200, body: opts.card };
    }
    if (req.method === "GET" && req.path === "/healthz") {
      return { status: 200, body: { ok: true } };
    }
    if (req.method !== "POST" || req.path !== "/") {
      return { status: 404, body: { error: "not_found" } };
    }
    if (!opts.authenticate(req)) {
      return { status: 401, body: { error: "unauthorized" } };
    }

    const body = req.body as
      | { id?: unknown; method?: string; params?: Record<string, unknown> }
      | undefined;
    if (!body || typeof body.method !== "string") {
      return rpcError(body?.id, -32600, "invalid request");
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
          return rpcError(body.id, -32602, "params.message.parts is required");
        }

        const skillIds = Object.keys(opts.skills);
        const skillId =
          params.metadata?.skillId ?? (skillIds.length === 1 ? skillIds[0] : undefined);
        if (!skillId || !opts.skills[skillId]) {
          return rpcError(
            body.id,
            -32602,
            skillId ? `unknown skill: ${skillId}` : "params.metadata.skillId is required",
          );
        }

        const deadlineAt = params.metadata?.deadlineAt
          ? new Date(params.metadata.deadlineAt)
          : null;
        if (deadlineAt && Number.isNaN(deadlineAt.getTime())) {
          return rpcError(body.id, -32602, "params.metadata.deadlineAt is invalid");
        }

        const task = store.create({
          skillId,
          push: params.configuration?.pushNotificationConfig ?? null,
        });
        // Snapshot before starting: `run` mutates the stored task, so reading
        // it afterwards would report `working` to a caller that has not been
        // told the task was even accepted yet.
        const accepted = taskToA2A(task);

        // Accept now, work later: holding the connection for an hours-long
        // job is exactly what this design set out to avoid.
        const promise = run(task, { parts, deadlineAt }).finally(() => {
          inFlight.delete(promise);
        });
        inFlight.add(promise);

        return rpcResult(body.id, accepted);
      }

      case "tasks/get": {
        const params = (body.params ?? {}) as { id?: string };
        if (!params.id) return rpcError(body.id, -32602, "params.id is required");
        const task = store.get(params.id);
        if (!task) return rpcError(body.id, -32001, "task not found");
        return rpcResult(body.id, taskToA2A(task));
      }

      default:
        return rpcError(body.id, -32601, `unsupported method: ${body.method}`);
    }
  }

  return { handle, drain, store };
}

/**
 * Node HTTP adapter. An A2A agent is an ordinary HTTP server: the card on
 * `/.well-known/agent-card.json`, JSON-RPC on `/`.
 */
export function createA2AAgentHttpServer(opts: {
  server: ReturnType<typeof createA2AServer>;
  logger?: A2AServerLogger;
  maxBodyBytes?: number;
}): Server {
  const maxBytes = opts.maxBodyBytes ?? 1024 * 1024;

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://agent.local");
      const method = req.method ?? "GET";
      let status = 500;
      let payload: unknown = { error: "internal_error" };

      try {
        let body: unknown;
        if (method === "POST") {
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            total += buf.length;
            if (total > maxBytes) throw new Error("payload_too_large");
            chunks.push(buf);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw);
            } catch {
              res.statusCode = 400;
              res.setHeader("content-type", "application/json; charset=utf-8");
              res.end(JSON.stringify({ error: "invalid_json" }));
              return;
            }
          }
        }

        const auth = req.headers.authorization;
        const bearerToken =
          auth && auth.toLowerCase().startsWith("bearer ")
            ? auth.slice(7).trim() || null
            : null;

        const out = await opts.server.handle({
          method,
          path: url.pathname,
          bearerToken,
          body,
        });
        status = out.status;
        payload = out.body;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "payload_too_large") {
          status = 413;
          payload = { error: "payload_too_large" };
        } else {
          opts.logger?.error(
            { path: url.pathname, method, error: message },
            "a2a agent request failed",
          );
        }
      }

      const text = JSON.stringify(payload ?? {});
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("content-length", Buffer.byteLength(text));
      res.end(text);
    })();
  });
}

/** Constant-time bearer check for the gateway's inbound credential. */
export function bearerAuthenticator(expected: string) {
  const expectedBuf = Buffer.from(expected);
  return (req: A2AServerRequest): boolean => {
    if (!req.bearerToken) return false;
    const actual = Buffer.from(req.bearerToken);
    return (
      actual.length === expectedBuf.length && timingSafeEqual(actual, expectedBuf)
    );
  };
}
