import { describe, expect, it } from "vitest";
import {
  backoffDelayMs,
  createCallbackHandler,
  createNotifier,
  createSweeper,
  type CallbackStorePort,
} from "../../src/fleet/site/callbacks.js";
import type { FleetTaskRecord } from "../../src/fleet/site/gatewayStore.js";

function task(overrides: Partial<FleetTaskRecord> = {}): FleetTaskRecord {
  return {
    id: 1,
    tenantId: 1,
    upstreamTaskId: "up-1",
    callerAgentId: "workflow-agent",
    callerCallbackUrl: "https://workflow.acme.example/hooks",
    callerCallbackAuth: { schemes: ["bearer"], credentials: "caller-secret" },
    targetAgentId: "dev-agent",
    skillId: "develop.issue",
    downstreamTaskId: "down-1",
    state: "running",
    attempt: 0,
    nextRetryAt: null,
    deadlineAt: "2026-09-11T06:00:00.000Z",
    result: null,
    notifiedAt: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    updatedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

interface Fake {
  store: CallbackStorePort;
  events: Array<{ eventType: string; payload: unknown }>;
  results: Array<{ taskId: number; result: unknown }>;
  notified: number[];
  retries: Array<{ taskId: number; at: Date }>;
  abandoned: number[];
}

function fakeStore(opts: {
  byToken?: Record<string, FleetTaskRecord>;
  due?: FleetTaskRecord[];
  expired?: FleetTaskRecord[];
}): Fake {
  const events: Fake["events"] = [];
  const results: Fake["results"] = [];
  const notified: number[] = [];
  const retries: Fake["retries"] = [];
  const abandoned: number[] = [];
  let dueServed = false;
  let expiredServed = false;

  const store: CallbackStorePort = {
    async resolveCallbackToken(hash) {
      return opts.byToken?.[hash] ?? null;
    },
    async recordDownstreamResult(taskId, result) {
      results.push({ taskId, result });
    },
    async markNotified(taskId) {
      notified.push(taskId);
    },
    async claimDueNotifications() {
      if (dueServed) return [];
      dueServed = true;
      return opts.due ?? [];
    },
    async recordNotifyFailure(taskId, at) {
      retries.push({ taskId, at });
    },
    async abandonNotification(taskId) {
      abandoned.push(taskId);
    },
    async claimExpired() {
      if (expiredServed) return [];
      expiredServed = true;
      return opts.expired ?? [];
    },
    async appendTaskEvent(input) {
      events.push({ eventType: input.eventType, payload: input.payload });
    },
  };

  return { store, events, results, notified, retries, abandoned };
}

const hashToken = (t: string) => `hash:${t}`;

describe("inbound callback (step ③)", () => {
  it("records the downstream result for a live token", async () => {
    const f = fakeStore({ byToken: { "hash:cbtok": task() } });
    const handle = createCallbackHandler({ store: f.store, hashToken });

    const res = await handle({
      method: "POST",
      path: "/a2a/callbacks/cbtok",
      body: { taskId: "down-1", status: { state: "completed" }, result: { prUrl: "https://pr/1" } },
    });

    expect(res?.status).toBe(200);
    expect(f.results[0].result).toMatchObject({
      state: "completed",
      result: { prUrl: "https://pr/1" },
    });
    expect(f.events.map((e) => e.eventType)).toContain("callback_received");
  });

  it("rejects an unknown token", async () => {
    const f = fakeStore({});
    const handle = createCallbackHandler({ store: f.store, hashToken });
    const res = await handle({
      method: "POST",
      path: "/a2a/callbacks/forged",
      body: { taskId: "down-1" },
    });
    expect(res?.status).toBe(404);
    expect(f.results).toHaveLength(0);
  });

  it("rejects a callback reporting a task id we never dispatched", async () => {
    const f = fakeStore({ byToken: { "hash:cbtok": task() } });
    const handle = createCallbackHandler({ store: f.store, hashToken });

    const res = await handle({
      method: "POST",
      path: "/a2a/callbacks/cbtok",
      body: { taskId: "someone-elses-task", result: { prUrl: "https://evil/1" } },
    });

    expect(res?.status).toBe(404);
    expect(f.results).toHaveLength(0);
    expect(f.events[0]).toMatchObject({
      eventType: "callback_rejected",
      payload: { reason: "task_id_mismatch" },
    });
  });

  it("ignores paths it does not own", async () => {
    const f = fakeStore({});
    const handle = createCallbackHandler({ store: f.store, hashToken });
    expect(await handle({ method: "POST", path: "/a2a/t/acme/catalog" })).toBeNull();
    expect(await handle({ method: "GET", path: "/a2a/callbacks/cbtok" })).toBeNull();
  });
});

describe("notifier (step ④)", () => {
  const frozen = new Date("2026-09-11T01:00:00.000Z");

  it("delivers to the caller's webhook with its registered credentials", async () => {
    const f = fakeStore({ due: [task({ state: "done_pending_notify" })] });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const run = createNotifier({
      store: f.store,
      now: () => frozen,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    expect(await run()).toEqual({ delivered: 1, retried: 0 });
    expect(calls[0].url).toBe("https://workflow.acme.example/hooks");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(
      "Bearer caller-secret",
    );
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
      taskId: "up-1",
      status: { state: "completed" },
    });
    expect(f.notified).toEqual([1]);
  });

  it("reports a timeout to the caller as failed", async () => {
    const f = fakeStore({ due: [task({ state: "timed_out" })] });
    let sent: Record<string, unknown> = {};
    const run = createNotifier({
      store: f.store,
      now: () => frozen,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string);
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });

    await run();
    expect(sent).toMatchObject({ status: { state: "failed" } });
  });

  it("schedules a backoff retry when the caller is down", async () => {
    const f = fakeStore({ due: [task({ state: "done_pending_notify", attempt: 2 })] });
    const run = createNotifier({
      store: f.store,
      now: () => frozen,
      random: () => 1,
      backoff: { baseMs: 1_000, maxMs: 60_000, maxAttempts: 8 },
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(await run()).toEqual({ delivered: 0, retried: 1 });
    expect(f.notified).toEqual([]);
    // attempt 2 → ceiling 1000 * 2^1 = 2000ms, full jitter at random()=1.
    expect(f.retries[0].at.getTime() - frozen.getTime()).toBe(2_000);
    expect(f.events.map((e) => e.eventType)).toContain("notify_retry_scheduled");
  });

  it("treats a non-2xx from the caller as a failure, not a success", async () => {
    const f = fakeStore({ due: [task({ state: "done_pending_notify" })] });
    const run = createNotifier({
      store: f.store,
      now: () => frozen,
      fetchImpl: (async () => ({ ok: false, status: 500 }) as Response) as unknown as typeof fetch,
    });
    expect(await run()).toEqual({ delivered: 0, retried: 1 });
  });

  it("gives up once the retry budget is spent, without rewriting the outcome", async () => {
    const f = fakeStore({
      due: [task({ state: "done_pending_notify", attempt: 8 })],
    });
    const run = createNotifier({
      store: f.store,
      now: () => frozen,
      backoff: { maxAttempts: 8 },
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    expect(await run()).toEqual({ delivered: 0, retried: 0 });
    expect(f.abandoned).toEqual([1]);
    expect(f.events.map((e) => e.eventType)).toContain("notify_abandoned");
  });
});

describe("sweeper", () => {
  it("records an event for every task the downstream abandoned", async () => {
    const f = fakeStore({
      expired: [task({ id: 3, state: "timed_out" }), task({ id: 4, state: "timed_out" })],
    });
    const run = createSweeper({ store: f.store, now: () => new Date() });

    expect(await run()).toEqual({ timedOut: 2 });
    expect(f.events.map((e) => e.eventType)).toEqual(["timed_out", "timed_out"]);
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and stays under the cap", () => {
    const opts = { baseMs: 1_000, maxMs: 8_000 };
    expect(backoffDelayMs(1, opts, () => 1)).toBe(1_000);
    expect(backoffDelayMs(2, opts, () => 1)).toBe(2_000);
    expect(backoffDelayMs(3, opts, () => 1)).toBe(4_000);
    expect(backoffDelayMs(99, opts, () => 1)).toBe(8_000);
  });

  it("jitters down to half the ceiling so retries do not synchronise", () => {
    const opts = { baseMs: 1_000, maxMs: 8_000 };
    expect(backoffDelayMs(3, opts, () => 0)).toBe(2_000);
    expect(backoffDelayMs(3, opts, () => 1)).toBe(4_000);
  });
});
