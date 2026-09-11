import type { FleetTaskRecord } from "./gatewayStore.js";
import { a2aTaskState, type GatewayResponse } from "./gateway.js";

/**
 * Steps ③ and ④ of the dispatch chain (docs §7): the downstream reports in,
 * and the gateway relays that to the original caller.
 *
 * Push replaces what the old lease-based mailbox gave away for free. A lease
 * that expired put the message back in the queue; a webhook that misses its
 * target is simply lost unless we persist and retry (docs §8). Everything in
 * this file exists to pay that bill.
 */

export interface CallbackStorePort {
  resolveCallbackToken(tokenHash: string): Promise<FleetTaskRecord | null>;
  recordDownstreamResult(taskId: number, result: unknown): Promise<void>;
  markNotified(taskId: number): Promise<void>;
  claimDueNotifications(now: Date, limit: number): Promise<FleetTaskRecord[]>;
  recordNotifyFailure(taskId: number, nextRetryAt: Date): Promise<void>;
  abandonNotification(taskId: number): Promise<void>;
  claimExpired(now: Date, limit: number): Promise<FleetTaskRecord[]>;
  appendTaskEvent(input: {
    tenantId: number;
    taskId: number;
    eventType: string;
    payload: unknown;
  }): Promise<void>;
}

const CALLBACK_PATH = /^\/a2a\/callbacks\/([^/]+)$/;

/**
 * `/a2a/callbacks/{token}` is a sessionless endpoint anyone can POST to. A
 * forged success here is not cosmetic: it tells the gateway "the work is
 * done, the PR is at <url>", and a downstream reviewer will go read that URL.
 * So: the token must match a live task, and the body's task id must be the
 * one we actually dispatched (docs §4).
 */
export function createCallbackHandler(deps: {
  store: CallbackStorePort;
  hashToken(token: string): string;
}) {
  return async function handleCallback(req: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<GatewayResponse | null> {
    const match = CALLBACK_PATH.exec(req.path);
    if (!match || req.method !== "POST") return null;

    const task = await deps.store.resolveCallbackToken(
      deps.hashToken(decodeURIComponent(match[1])),
    );
    // Unknown token, or a token whose task already finished — a replayed
    // callback must not reopen anything.
    if (!task) return { status: 404, body: { error: "not_found" } };

    const body = (req.body ?? {}) as {
      taskId?: string;
      id?: string;
      status?: { state?: string };
      result?: unknown;
      error?: unknown;
    };
    const reportedId = body.taskId ?? body.id;
    if (reportedId && reportedId !== task.downstreamTaskId) {
      await deps.store.appendTaskEvent({
        tenantId: task.tenantId,
        taskId: task.id,
        eventType: "callback_rejected",
        payload: { reason: "task_id_mismatch", reportedId },
      });
      return { status: 404, body: { error: "not_found" } };
    }

    await deps.store.recordDownstreamResult(task.id, {
      state: body.status?.state ?? "completed",
      result: body.result ?? null,
      error: body.error ?? null,
    });
    await deps.store.appendTaskEvent({
      tenantId: task.tenantId,
      taskId: task.id,
      eventType: "callback_received",
      payload: { state: body.status?.state ?? "completed" },
    });

    return { status: 200, body: { ok: true } };
  };
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  maxAttempts?: number;
}

const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 30_000,
  maxMs: 30 * 60 * 1000,
  maxAttempts: 8,
};

/** Exponential with full jitter, so a fleet of retries does not sync up. */
export function backoffDelayMs(
  attempt: number,
  opts: BackoffOptions = {},
  random: () => number = Math.random,
): number {
  const { baseMs, maxMs } = { ...DEFAULT_BACKOFF, ...opts };
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(ceiling * (0.5 + 0.5 * random()));
}

export interface NotifierDeps {
  store: CallbackStorePort;
  fetchImpl?: typeof fetch;
  now?(): Date;
  random?(): number;
  backoff?: BackoffOptions;
  batchSize?: number;
  logger?: { warn?(data: Record<string, unknown>, msg?: string): void };
}

/**
 * Step ④. Delivery is best-effort with a budget; `tasks/get` is what makes
 * the system eventually consistent when delivery loses (docs §8).
 */
export function createNotifier(deps: NotifierDeps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const backoff = { ...DEFAULT_BACKOFF, ...deps.backoff };

  async function deliver(task: FleetTaskRecord): Promise<boolean> {
    if (!task.callerCallbackUrl) return false;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const credentials = task.callerCallbackAuth?.credentials;
    if (credentials) headers.authorization = `Bearer ${credentials}`;

    const res = await doFetch(task.callerCallbackUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskId: task.upstreamTaskId,
        status: { state: a2aTaskState(task.state) },
        result: task.result,
      }),
    });
    return res.ok;
  }

  return async function runOnce(): Promise<{ delivered: number; retried: number }> {
    const due = await deps.store.claimDueNotifications(
      now(),
      deps.batchSize ?? 20,
    );
    let delivered = 0;
    let retried = 0;

    for (const task of due) {
      let ok = false;
      let error: string | undefined;
      try {
        ok = await deliver(task);
        if (!ok) error = "caller returned a non-2xx status";
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }

      if (ok) {
        await deps.store.markNotified(task.id);
        await deps.store.appendTaskEvent({
          tenantId: task.tenantId,
          taskId: task.id,
          eventType: "caller_notified",
          payload: { attempt: task.attempt },
        });
        delivered += 1;
        continue;
      }

      if (task.attempt >= backoff.maxAttempts) {
        await deps.store.abandonNotification(task.id);
        await deps.store.appendTaskEvent({
          tenantId: task.tenantId,
          taskId: task.id,
          eventType: "notify_abandoned",
          payload: { attempt: task.attempt, error },
        });
        deps.logger?.warn?.(
          { taskId: task.id, attempt: task.attempt, error },
          "fleet gateway gave up notifying caller",
        );
        continue;
      }

      const delay = backoffDelayMs(task.attempt, backoff, random);
      await deps.store.recordNotifyFailure(
        task.id,
        new Date(now().getTime() + delay),
      );
      await deps.store.appendTaskEvent({
        tenantId: task.tenantId,
        taskId: task.id,
        eventType: "notify_retry_scheduled",
        payload: { attempt: task.attempt, delayMs: delay, error },
      });
      retried += 1;
    }

    return { delivered, retried };
  };
}

/**
 * Downstream agents that never call back. Without this a task sits in
 * `running` forever and the caller waits on a reply that is never coming.
 */
export function createSweeper(deps: {
  store: CallbackStorePort;
  now?(): Date;
  batchSize?: number;
}) {
  const now = deps.now ?? (() => new Date());

  return async function runOnce(): Promise<{ timedOut: number }> {
    const expired = await deps.store.claimExpired(now(), deps.batchSize ?? 20);
    for (const task of expired) {
      await deps.store.appendTaskEvent({
        tenantId: task.tenantId,
        taskId: task.id,
        eventType: "timed_out",
        payload: { deadlineAt: task.deadlineAt, targetAgentId: task.targetAgentId },
      });
    }
    return { timedOut: expired.length };
  };
}
