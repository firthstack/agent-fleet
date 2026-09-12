import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFleetSiteServer,
  fleetPublicBaseUrlFromEnv,
  startFleetWorkers,
  type FleetSiteStore,
} from "../../src/fleet/site/server.js";
import { hashToken } from "../../src/fleet/site/registration.js";
import type { A2AClient } from "../../src/fleet/site/a2aClient.js";
import type {
  FleetTaskRecord,
  GatewayAgentRecord,
  TenantRecord,
} from "../../src/fleet/site/gatewayStore.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";

const ACME: TenantRecord = {
  id: 1,
  slug: "acme",
  displayName: "Acme",
  createdAt: "2026-09-11T00:00:00.000Z",
};

const CARD: A2AAgentCard = {
  name: "Development Agent",
  description: "Implements requirements.",
  version: "1.0.0",
  skills: [{ id: "develop.issue", name: "Develop", description: "Implement." }],
};

const DEV: GatewayAgentRecord = {
  tenantId: 1,
  agentId: "dev-agent",
  displayName: "dev-agent",
  endpointUrl: "https://dev.internal.example/",
  card: CARD,
  health: "healthy",
  cardFetchedAt: null,
  lastSeenAt: null,
};

const AGENT_TOKEN = "wf-token";

function fakeStore() {
  const tasks: FleetTaskRecord[] = [];
  const callbackTokens = new Map<string, FleetTaskRecord>();
  const results: unknown[] = [];
  let nextId = 1;

  const store: FleetSiteStore = {
    async getTenantBySlug(slug) {
      return slug === "acme" ? ACME : null;
    },
    async resolveAgentToken(hash) {
      return hash === hashToken(AGENT_TOKEN)
        ? { tenantId: 1, agentId: "workflow-agent" }
        : null;
    },
    async getAgent(tenantId, agentId) {
      return tenantId === 1 && agentId === "dev-agent" ? DEV : null;
    },
    async listAgents(tenantId) {
      return tenantId === 1 ? [DEV] : [];
    },
    async findAgentsBySkill() {
      return [DEV];
    },
    async createTask(input) {
      const t: FleetTaskRecord = {
        id: nextId++,
        tenantId: input.tenantId,
        upstreamTaskId: input.upstreamTaskId,
        callerAgentId: input.callerAgentId,
        callerCallbackUrl: input.callerCallbackUrl ?? null,
        callerCallbackAuth: input.callerCallbackAuth ?? null,
        targetAgentId: input.targetAgentId,
        skillId: input.skillId,
        downstreamTaskId: null,
        state: "dispatching",
        attempt: 0,
        nextRetryAt: null,
        deadlineAt: input.deadlineAt.toISOString(),
        result: null,
        notifiedAt: null,
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      };
      tasks.push(t);
      return t;
    },
    async attachDownstream(taskId, input) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) return;
      t.downstreamTaskId = input.downstreamTaskId;
      t.state = "running";
      callbackTokens.set(input.callbackTokenHash, t);
    },
    async failTask(taskId) {
      const t = tasks.find((x) => x.id === taskId);
      if (t) t.state = "failed";
    },
    async getTaskByUpstreamId(tenantId, upstreamTaskId) {
      return (
        tasks.find(
          (t) => t.tenantId === tenantId && t.upstreamTaskId === upstreamTaskId,
        ) ?? null
      );
    },
    async appendTaskEvent() {},
    async getAgentCredential() {
      return { scheme: "bearer", secret: "target-secret" };
    },
    async resolveCallbackToken(hash) {
      return callbackTokens.get(hash) ?? null;
    },
    async recordDownstreamResult(taskId, result) {
      results.push(result);
      const t = tasks.find((x) => x.id === taskId);
      if (t) t.state = "done_pending_notify";
    },
    async markNotified() {},
    async claimDueNotifications() {
      return [];
    },
    async recordNotifyFailure() {},
    async abandonNotification() {},
    async claimExpired() {
      return [];
    },
  };

  return { store, tasks, results };
}

const client: A2AClient = {
  async fetchAgentCard() {
    return CARD;
  },
  async sendMessage() {
    return { taskId: "down-1", state: "submitted" };
  },
};

let closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers) close();
  closers = [];
});

async function listen(store: FleetSiteStore, maxBodyBytes?: number) {
  const server = createFleetSiteServer({
    store,
    publicBaseUrl: "https://fleet.example.com",
    a2aClient: client,
    maxBodyBytes,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => server.close());
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("fleet site server", () => {
  it("serves a health check without authentication", async () => {
    const base = await listen(fakeStore().store);
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("runs a dispatch end to end over real HTTP", async () => {
    const f = fakeStore();
    const base = await listen(f.store);

    const res = await fetch(`${base}/a2a/t/acme/agents/dev-agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: { role: "user", parts: [{ kind: "data", data: { requirement: "x" } }] },
          metadata: { skillId: "develop.issue" },
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { id: string } };
    expect(body.result.id).toMatch(/^[0-9a-f]{32}$/);
    expect(f.tasks[0].state).toBe("running");
  });

  it("rejects a request with no bearer token", async () => {
    const base = await listen(fakeStore().store);
    const res = await fetch(`${base}/a2a/t/acme/catalog`);
    expect(res.status).toBe(401);
  });

  it("ignores a non-bearer authorization scheme", async () => {
    const base = await listen(fakeStore().store);
    const res = await fetch(`${base}/a2a/t/acme/catalog`, {
      headers: { authorization: `Basic ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("answers malformed JSON with 400 rather than a 500", async () => {
    const base = await listen(fakeStore().store);
    const res = await fetch(`${base}/a2a/t/acme/agents/dev-agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("caps the request body", async () => {
    // The callback endpoint is unauthenticated, so an unbounded read is a
    // memory-exhaustion lever for anyone who can reach the site.
    const base = await listen(fakeStore().store, 64);
    const res = await fetch(`${base}/a2a/callbacks/anything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(500) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("routes callbacks by path token, not by bearer", async () => {
    const f = fakeStore();
    const base = await listen(f.store);

    await fetch(`${base}/a2a/t/acme/agents/dev-agent`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: {
          message: { role: "user", parts: [{ kind: "data", data: {} }] },
          metadata: { skillId: "develop.issue" },
        },
      }),
    });

    // An unknown callback token is a 404 — never a 401, which would tell a
    // prober that the endpoint exists and just wants credentials.
    const res = await fetch(`${base}/a2a/callbacks/not-a-real-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: "down-1" }),
    });
    expect(res.status).toBe(404);
  });

  it("no longer answers the root with a page that asks for an agent token", async () => {
    // The standalone run viewer is gone (docs/fleet-console.md §4). With no
    // built SPA there is simply nothing at the root: the console reads the
    // same runs out of a session, and a browser prompt for an *agent* token
    // was only ever a stand-in for the identity axis that now exists.
    const base = await listen(fakeStore().store);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("returns 404 for an unknown path", async () => {
    const base = await listen(fakeStore().store);
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("fleet workers", () => {
  it("sweeps before notifying, so a fresh timeout is delivered in the same tick", async () => {
    const order: string[] = [];
    const store = {
      async claimExpired() {
        order.push("sweep");
        return [];
      },
      async claimDueNotifications() {
        order.push("notify");
        return [];
      },
      async appendTaskEvent() {},
      async resolveCallbackToken() {
        return null;
      },
      async recordDownstreamResult() {},
      async markNotified() {},
      async recordNotifyFailure() {},
      async abandonNotification() {},
    };

    const workers = startFleetWorkers({ store, intervalMs: 1_000_000 });
    await workers.runOnce();
    workers.stop();
    expect(order).toEqual(["sweep", "notify"]);
  });

  it("does not run a health sweep when no healthCheck config is given", async () => {
    const store = {
      async claimExpired() { return []; },
      async claimDueNotifications() { return []; },
      async appendTaskEvent() {},
      async resolveCallbackToken() { return null; },
      async recordDownstreamResult() {},
      async markNotified() {},
      async recordNotifyFailure() {},
      async abandonNotification() {},
    };

    const workers = startFleetWorkers({ store, intervalMs: 1_000_000 });
    workers.stop();
    expect(workers.runHealthCheckOnce).toBeUndefined();
  });

  it("refreshes every agent across every tenant on the health-check tick (docs §5 step 5)", async () => {
    const refreshed: string[] = [];
    const store = {
      async claimExpired() { return []; },
      async claimDueNotifications() { return []; },
      async appendTaskEvent() {},
      async resolveCallbackToken() { return null; },
      async recordDownstreamResult() {},
      async markNotified() {},
      async recordNotifyFailure() {},
      async abandonNotification() {},
    };
    const healthStore = {
      async listAllAgentsUnscoped() {
        return [DEV, { ...DEV, tenantId: 2, agentId: "other-agent" }];
      },
    };

    const workers = startFleetWorkers({
      store,
      intervalMs: 1_000_000,
      healthCheck: {
        store: healthStore,
        intervalMs: 1_000_000,
        async refresh(agent) {
          refreshed.push(agent.agentId);
          return { health: "healthy", changed: false };
        },
      },
    });

    const result = await workers.runHealthCheckOnce?.();
    workers.stop();
    expect(result).toEqual({ checked: 2, unreachable: 0 });
    expect(refreshed).toEqual(["dev-agent", "other-agent"]);
  });

  it("does not start a new health sweep while one is still running", async () => {
    const refreshed: string[] = [];
    let releaseFirstProbe: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseFirstProbe = resolve;
    });
    const store = {
      async claimExpired() { return []; },
      async claimDueNotifications() { return []; },
      async appendTaskEvent() {},
      async resolveCallbackToken() { return null; },
      async recordDownstreamResult() {},
      async markNotified() {},
      async recordNotifyFailure() {},
      async abandonNotification() {},
    };
    const healthStore = {
      async listAllAgentsUnscoped() {
        return [DEV, { ...DEV, tenantId: 2, agentId: "other-agent" }];
      },
    };

    const workers = startFleetWorkers({
      store,
      intervalMs: 1_000_000,
      healthCheck: {
        store: healthStore,
        intervalMs: 1_000_000,
        async refresh(agent) {
          refreshed.push(agent.agentId);
          // The first probe stalls here, so the sweep is still in flight
          // (stuck on the first agent) when the overlapping tick fires.
          await gate;
          return { health: "healthy", changed: false };
        },
      },
    });

    const first = workers.runHealthCheckOnce!();
    // Let the stalled sweep reach its first `refresh` call before the
    // overlapping tick below.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const overlapping = await workers.runHealthCheckOnce!();
    expect(overlapping).toEqual({ checked: 0, unreachable: 0 });
    // Only the in-flight sweep's first agent was probed — the overlapping
    // tick did not start a second, concurrent sweep.
    expect(refreshed).toEqual(["dev-agent"]);

    releaseFirstProbe();
    const result = await first;
    expect(result).toEqual({ checked: 2, unreachable: 0 });
    workers.stop();
  });
});

describe("fleetPublicBaseUrlFromEnv", () => {
  it("requires the value and strips a trailing slash", () => {
    expect(
      fleetPublicBaseUrlFromEnv({ FLEET_PUBLIC_BASE_URL: "https://fleet.example.com/" }),
    ).toBe("https://fleet.example.com");
  });

  it("fails loudly rather than handing agents an unreachable callback host", () => {
    expect(() => fleetPublicBaseUrlFromEnv({})).toThrow(/required/);
    expect(() =>
      fleetPublicBaseUrlFromEnv({ FLEET_PUBLIC_BASE_URL: "not a url" }),
    ).toThrow(/not a valid URL/);
  });
});
