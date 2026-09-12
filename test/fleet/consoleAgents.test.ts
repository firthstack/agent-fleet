import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConsoleHandler,
  type ConsoleAuth,
  type ConsoleDeps,
  type ConsoleStore,
} from "../../src/fleet/console/api.js";
import {
  createRegistrationService,
  hashToken,
  type RegistrationStorePort,
} from "../../src/fleet/site/registration.js";
import { createConsoleMessenger } from "../../src/fleet/console/messages.js";
import type {
  FleetTaskRecord,
  GatewayAgentRecord,
  TenantRecord,
} from "../../src/fleet/site/gatewayStore.js";
import type { A2AClient } from "../../src/fleet/site/a2aClient.js";
import type { AgentCredential } from "../../src/fleet/site/a2aClient.js";

/**
 * `POST /api/agents` (docs/fleet-console.md §5).
 *
 * The store and the card fetch are faked; what is real is everything the
 * console itself owns — where the tenant comes from, which failure maps to
 * which status, and the fact that the token leaves exactly once. No
 * container, so this suite runs anywhere.
 */

const CARD = {
  name: "Codex Review Agent",
  description: "Reviews pull requests.",
  version: "1.0.0",
  skills: [{ id: "review.pr", name: "Review PR", description: "Review a PR." }],
};

const TENANTS: Record<string, TenantRecord> = {
  ada: { id: 1, slug: "ada", displayName: "ada", createdAt: "2026-09-11T00:00:00.000Z" },
  bob: { id: 2, slug: "bob", displayName: "bob", createdAt: "2026-09-11T00:00:00.000Z" },
};

function cardResponder(card: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => card,
  })) as unknown as typeof fetch;
}

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

/** One in-memory registry, seen through both ports the console uses. */
function fixture() {
  const agents: GatewayAgentRecord[] = [];
  const tokens: Array<{
    tenantId: number;
    agentId: string;
    hash: string;
    revoked?: boolean;
  }> = [];
  const creds: Array<{ tenantId: number; agentId: string; credential: AgentCredential }> = [];

  const registrationStore: RegistrationStorePort = {
    async getAgent(tenantId, agentId) {
      return agents.find((a) => a.tenantId === tenantId && a.agentId === agentId) ?? null;
    },
    async registerAgent(input) {
      const record: GatewayAgentRecord = {
        tenantId: input.tenantId,
        agentId: input.agentId,
        displayName: input.displayName,
        endpointUrl: input.endpointUrl,
        card: input.card,
        health: input.health ?? "healthy",
        cardFetchedAt: "2026-09-11T00:00:00.000Z",
        lastSeenAt: null,
      };
      const i = agents.findIndex(
        (a) => a.tenantId === input.tenantId && a.agentId === input.agentId,
      );
      if (i >= 0) agents[i] = record;
      else agents.push(record);
      return record;
    },
    async issueAgentToken(tenantId, agentId, hash) {
      tokens.push({ tenantId, agentId, hash });
    },
    async putAgentCredential(tenantId, agentId, credential) {
      creds.push({ tenantId, agentId, credential });
    },
    async deleteAgentCredential(tenantId, agentId) {
      for (let i = creds.length - 1; i >= 0; i -= 1) {
        const c = creds[i];
        if (c.tenantId === tenantId && c.agentId === agentId) creds.splice(i, 1);
      }
    },
    async rotateAgentToken(tenantId, agentId, hash) {
      let revoked = 0;
      for (const t of tokens) {
        if (t.tenantId === tenantId && t.agentId === agentId && !t.revoked) {
          t.revoked = true;
          revoked += 1;
        }
      }
      tokens.push({ tenantId, agentId, hash });
      return { revoked };
    },
  };

  const tasks: FleetTaskRecord[] = [];
  const events: Array<{ taskId: number; eventType: string; payload: unknown }> = [];

  const messageStore = {
    async getAgentCredential(tenantId: number, agentId: string) {
      return (
        creds.find((c) => c.tenantId === tenantId && c.agentId === agentId)?.credential ??
        null
      );
    },
    async createTask(input: {
      tenantId: number;
      upstreamTaskId: string;
      callerAgentId: string;
      targetAgentId: string;
      skillId: string;
      deadlineAt: Date;
    }) {
      const task: FleetTaskRecord = {
        id: tasks.length + 1,
        tenantId: input.tenantId,
        upstreamTaskId: input.upstreamTaskId,
        callerAgentId: input.callerAgentId,
        callerCallbackUrl: null,
        callerCallbackAuth: null,
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
      tasks.push(task);
      return task;
    },
    async attachDownstream(taskId: number, input: { downstreamTaskId: string }) {
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        task.downstreamTaskId = input.downstreamTaskId;
        task.state = "running";
      }
    },
    async failTask(taskId: number, result: unknown) {
      const task = tasks.find((t) => t.id === taskId);
      if (task) {
        task.state = "failed";
        task.result = result;
      }
    },
    async appendTaskEvent(input: { taskId: number; eventType: string; payload: unknown }) {
      events.push(input);
    },
  };

  const consoleStore: ConsoleStore = {
    async tenantForUser(userId) {
      return TENANTS[userId] ?? null;
    },
    async ensureTenantForUser(user) {
      return TENANTS[user.id] ?? TENANTS.ada;
    },
    async listAgents(tenantId) {
      return agents.filter((a) => a.tenantId === tenantId);
    },
    async getAgent(tenantId, agentId) {
      return agents.find((a) => a.tenantId === tenantId && a.agentId === agentId) ?? null;
    },
    async agentTaskStats(tenantId, agentId) {
      const stats = new Map<
        string,
        { totalRuns: number; succeeded: number; failed: number; running: number; runningSince: string | null }
      >();
      for (const task of tasks) {
        if (task.tenantId !== tenantId) continue;
        if (agentId !== undefined && task.targetAgentId !== agentId) continue;
        const entry = stats.get(task.targetAgentId) ?? {
          totalRuns: 0,
          succeeded: 0,
          failed: 0,
          running: 0,
          runningSince: null as string | null,
        };
        entry.totalRuns += 1;
        if (task.state === "done" || task.state === "done_pending_notify") entry.succeeded += 1;
        else if (task.state === "failed" || task.state === "timed_out") entry.failed += 1;
        else if (task.state === "dispatching" || task.state === "running") {
          entry.running += 1;
          if (entry.runningSince === null || task.createdAt < entry.runningSince) {
            entry.runningSince = task.createdAt;
          }
        }
        stats.set(task.targetAgentId, entry);
      }
      return stats;
    },
    async deleteAgent(tenantId, agentId) {
      const i = agents.findIndex((a) => a.tenantId === tenantId && a.agentId === agentId);
      if (i < 0) return false;
      agents.splice(i, 1);
      // What the real schema does through ON DELETE CASCADE.
      for (const list of [tokens, creds]) {
        for (let j = list.length - 1; j >= 0; j -= 1) {
          const row = list[j] as { tenantId: number; agentId: string };
          if (row.tenantId === tenantId && row.agentId === agentId) list.splice(j, 1);
        }
      }
      return true;
    },
    async getTask(taskId) {
      return tasks.find((t) => t.id === taskId) ?? null;
    },
  };

  return { agents, tokens, creds, tasks, events, registrationStore, consoleStore, messageStore };
}

/** A session cookie of `user=ada` stands in for Better Auth's own. */
const auth: ConsoleAuth = {
  async handler() {
    return new Response("unused");
  },
  api: {
    async getSession({ headers }) {
      const match = /(?:^|;\s*)user=([a-z]+)/.exec(headers.get("cookie") ?? "");
      const id = match?.[1];
      if (!id || !TENANTS[id]) return null;
      return { user: { id, email: `${id}@example.com` } };
    },
  },
};

/** Bodies are asserted field by field here, so they are read loosely rather
 *  than restated as types the server already owns. */
type JsonBody = Record<string, any>;

const running: Server[] = [];
afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

/** An agent that accepts the message, or refuses to be reached. */
function fakeA2AClient(opts: { sendFails?: string } = {}): A2AClient {
  return {
    async fetchAgentCard() {
      throw new Error("unused");
    },
    async sendMessage() {
      if (opts.sendFails) throw new Error(opts.sendFails);
      return { taskId: "downstream-1", state: "submitted" };
    },
  };
}

async function harness(
  opts: {
    cardStatus?: number;
    card?: unknown;
    rateLimit?: ConsoleDeps["registrationRateLimit"];
    sendFails?: string;
  } = {},
) {
  const f = fixture();
  const handler = createConsoleHandler({
    auth,
    store: f.consoleStore,
    registration: createRegistrationService({
      store: f.registrationStore,
      fetchImpl: cardResponder(opts.card ?? CARD, opts.cardStatus ?? 200),
      lookup: publicLookup,
      mintToken: () => "fleet_test_token",
    }),
    messenger: createConsoleMessenger({
      store: f.messageStore,
      client: fakeA2AClient(opts.sendFails ? { sendFails: opts.sendFails } : {}),
      publicBaseUrl: "https://fleet.example",
      newUpstreamTaskId: () => "upstream-1",
      newCallbackToken: () => "callback-1",
      hashToken,
    }),
    origin: "http://127.0.0.1",
    ...(opts.rateLimit ? { registrationRateLimit: opts.rateLimit } : {}),
  });

  const server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  running.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as JsonBody };
  }

  const register = (body: unknown, cookie = "user=ada") =>
    call("/api/agents", { method: "POST", headers: { cookie }, body: JSON.stringify(body) });

  const list = (cookie = "user=ada") => call("/api/agents", { headers: { cookie } });

  const rotate = (agentId: string, cookie = "user=ada") =>
    call(`/api/agents/${agentId}/token`, { method: "POST", headers: { cookie } });

  const remove = (agentId: string, cookie = "user=ada") =>
    call(`/api/agents/${agentId}`, { method: "DELETE", headers: { cookie } });

  const message = (agentId: string, body: unknown, cookie = "user=ada") =>
    call(`/api/agents/${agentId}/messages`, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify(body),
    });

  const task = (id: number, cookie = "user=ada") =>
    call(`/api/tasks/${id}`, { headers: { cookie } });

  const patch = (agentId: string, body: unknown, cookie = "user=ada") =>
    call(`/api/agents/${agentId}`, {
      method: "PATCH",
      headers: { cookie },
      body: JSON.stringify(body),
    });

  return { ...f, call, register, list, rotate, patch, remove, message, task };
}

const valid = {
  agentId: "review-agent",
  endpointUrl: "https://review.acme.example/",
};

describe("POST /api/agents", () => {
  it("registers the agent and returns its token exactly once", async () => {
    const h = await harness();

    const created = await h.register(valid);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      agent: {
        agentId: "review-agent",
        // Taken from the card when the form leaves it blank.
        displayName: "Codex Review Agent",
        health: "healthy",
        skills: [{ id: "review.pr" }],
      },
      token: "fleet_test_token",
    });

    // Only the hash is kept, so the listing cannot hand it back.
    expect(h.tokens[0].hash).toBe(hashToken("fleet_test_token"));
    const listed = await h.list();
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("fleet_test_token");
    expect(listed.body).toMatchObject({ agents: [{ agentId: "review-agent" }] });
  });

  it("seals the outbound credential instead of echoing it back", async () => {
    const h = await harness();
    const res = await h.register({
      ...valid,
      credential: { scheme: "bearer", secret: "s3cret-to-the-agent" },
    });

    expect(res.status).toBe(201);
    expect(h.creds).toEqual([
      { tenantId: 1, agentId: "review-agent", credential: { scheme: "bearer", secret: "s3cret-to-the-agent" } },
    ]);
    expect(JSON.stringify(res.body)).not.toContain("s3cret-to-the-agent");
  });

  it("takes the tenant from the session and ignores one in the body", async () => {
    const h = await harness();
    // A body-supplied tenant is the whole attack in §9.3, so it must not even
    // be read — ada's session must place this in tenant 1 regardless.
    await h.register({ ...valid, tenantId: TENANTS.bob.id });

    expect(h.agents).toHaveLength(1);
    expect(h.agents[0].tenantId).toBe(TENANTS.ada.id);
    expect((await h.list("user=bob")).body).toEqual({ agents: [] });
  });

  it("lets two tenants use the same agent id", async () => {
    const h = await harness();
    expect((await h.register(valid, "user=ada")).status).toBe(201);
    expect((await h.register(valid, "user=bob")).status).toBe(201);
    expect(h.agents.map((a) => a.tenantId)).toEqual([1, 2]);
  });

  it("refuses an anonymous caller without touching the registry", async () => {
    const h = await harness();
    const res = await h.call("/api/agents", {
      method: "POST",
      body: JSON.stringify(valid),
    });

    expect(res.status).toBe(401);
    expect(h.agents).toEqual([]);
    // A registration makes the gateway fetch a URL of the caller's choosing;
    // an unauthenticated one would be an open proxy.
    expect((await h.call("/api/agents")).status).toBe(401);
  });
});

describe("GET /api/agents — run stats on the card", () => {
  it("defaults to all zeros when the agent has never run", async () => {
    const h = await harness();
    await h.register(valid);

    const res = await h.list();
    expect(res.body).toMatchObject({
      agents: [
        {
          agentId: "review-agent",
          stats: { totalRuns: 0, succeeded: 0, failed: 0, running: 0, runningSince: null },
        },
      ],
    });
  });

  it("counts runs by outcome and reports how long the oldest active one has been running", async () => {
    const h = await harness();
    await h.register(valid);

    const base: FleetTaskRecord = {
      id: 0,
      tenantId: TENANTS.ada.id,
      upstreamTaskId: "",
      callerAgentId: "user:ada",
      callerCallbackUrl: null,
      callerCallbackAuth: null,
      targetAgentId: "review-agent",
      skillId: "review.pr",
      downstreamTaskId: null,
      state: "done",
      attempt: 0,
      nextRetryAt: null,
      deadlineAt: "2026-09-11T01:00:00.000Z",
      result: null,
      notifiedAt: null,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    };
    h.tasks.push(
      { ...base, id: 1, upstreamTaskId: "u1", state: "done" },
      { ...base, id: 2, upstreamTaskId: "u2", state: "failed" },
      { ...base, id: 3, upstreamTaskId: "u3", state: "timed_out" },
      { ...base, id: 4, upstreamTaskId: "u4", state: "running", createdAt: "2026-09-11T00:05:00.000Z" },
      { ...base, id: 5, upstreamTaskId: "u5", state: "dispatching", createdAt: "2026-09-11T00:01:00.000Z" },
    );

    const res = await h.list();
    expect(res.body).toMatchObject({
      agents: [
        {
          agentId: "review-agent",
          stats: {
            totalRuns: 5,
            succeeded: 1,
            failed: 2,
            running: 2,
            runningSince: "2026-09-11T00:01:00.000Z",
          },
        },
      ],
    });
  });

  it("scopes stats to the tenant that owns the agent", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");
    h.tasks.push({
      id: 1,
      tenantId: TENANTS.bob.id,
      upstreamTaskId: "u1",
      callerAgentId: "user:bob",
      callerCallbackUrl: null,
      callerCallbackAuth: null,
      targetAgentId: "review-agent",
      skillId: "review.pr",
      downstreamTaskId: null,
      state: "done",
      attempt: 0,
      nextRetryAt: null,
      deadlineAt: "2026-09-11T01:00:00.000Z",
      result: null,
      notifiedAt: null,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    });

    const res = await h.list();
    expect(res.body).toMatchObject({
      agents: [{ agentId: "review-agent", stats: { totalRuns: 0 } }],
    });
  });
});

describe("POST /api/agents rejects bad input with a usable status", () => {
  it("answers 400 for an agent id that would break routing", async () => {
    const h = await harness();
    const res = await h.register({ ...valid, agentId: "Review Agent" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_agent_id" });
  });

  it("answers 400 for a URL that is not a URL, rather than failing internally", async () => {
    const h = await harness();
    // registration.ts resolves the card path against this string, so a value
    // that is not a URL at all would surface as a bare 500 if unchecked.
    const res = await h.register({ ...valid, endpointUrl: "review.acme.example" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_endpoint" });
  });

  it("answers 400 for a non-http scheme", async () => {
    const h = await harness();
    const res = await h.register({ ...valid, endpointUrl: "file:///etc/passwd" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_endpoint" });
  });

  it("answers 400 for a missing field and 400 for malformed JSON", async () => {
    const h = await harness();
    expect((await h.register({ endpointUrl: valid.endpointUrl })).status).toBe(400);

    const res = await h.call("/api/agents", {
      method: "POST",
      headers: { cookie: "user=ada" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_json" });
  });

  it("answers 409 when the id is already taken in this tenant", async () => {
    const h = await harness();
    await h.register(valid);
    const again = await h.register(valid);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "agent_id_taken" });
  });

  it("answers 502 when the agent serves no card", async () => {
    const h = await harness({ cardStatus: 404 });
    const res = await h.register(valid);
    // The caller's input was fine; the agent is the thing that failed.
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "unreachable" });
  });

  it("answers 400 when the card has no skills", async () => {
    const h = await harness({ card: { ...CARD, skills: [] } });
    const res = await h.register(valid);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_card" });
  });

  it("rate-limits registration per user", async () => {
    const h = await harness({ rateLimit: { limit: 1, windowMs: 60_000 } });
    expect((await h.register(valid)).status).toBe(201);

    const second = await h.register({ ...valid, agentId: "other-agent" });
    expect(second.status).toBe(429);
    // The limit is per user, so it must not lock out a different one.
    expect((await h.register(valid, "user=bob")).status).toBe(201);
  });

  it("answers 405 for a method the collection does not have", async () => {
    const h = await harness();
    const res = await h.call("/api/agents", {
      method: "PUT",
      headers: { cookie: "user=ada" },
      body: JSON.stringify(valid),
    });
    expect(res.status).toBe(405);
  });
});

describe("POST /api/agents/:id/token", () => {
  it("issues a new token and retires every earlier one", async () => {
    const h = await harness();
    await h.register(valid);
    expect(h.tokens).toHaveLength(1);

    const res = await h.rotate("review-agent");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: "review-agent", revoked: 1 });

    // The old hash stays on file marked revoked rather than vanishing, so the
    // gateway's own lookup (revoked_at IS NULL) is what turns it away.
    expect(h.tokens.map((t) => t.revoked ?? false)).toEqual([true, false]);
    expect(h.tokens[1].hash).toBe(hashToken("fleet_test_token"));
  });

  it("answers 404 for another tenant's agent rather than 403", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");

    // A 403 would confirm that this id exists in someone else's tenant.
    const res = await h.rotate("review-agent", "user=bob");
    expect(res.status).toBe(404);
    expect(h.tokens).toHaveLength(1);
  });

  it("answers 404 for an unknown agent and 401 with no session", async () => {
    const h = await harness();
    expect((await h.rotate("nope")).status).toBe(404);

    const anon = await h.call("/api/agents/review-agent/token", { method: "POST" });
    expect(anon.status).toBe(401);
  });

  it("answers 405 for a method the sub-resource does not have", async () => {
    const h = await harness();
    await h.register(valid);
    const res = await h.call("/api/agents/review-agent/token", {
      headers: { cookie: "user=ada" },
    });
    expect(res.status).toBe(405);
  });
});

describe("PATCH /api/agents/:id", () => {
  it("replaces the outbound credential without touching the card", async () => {
    const h = await harness();
    await h.register({ ...valid, credential: { scheme: "bearer", secret: "old" } });

    const res = await h.patch("review-agent", {
      credential: { scheme: "bearer", secret: "new" },
    });
    expect(res.status).toBe(200);
    expect(h.creds.at(-1)).toMatchObject({ credential: { secret: "new" } });
    expect(JSON.stringify(res.body)).not.toContain("new");
    expect(h.agents[0].card).toMatchObject({ name: "Codex Review Agent" });
  });

  it("clears the credential on an explicit null and keeps it when absent", async () => {
    const h = await harness();
    await h.register({ ...valid, credential: { scheme: "bearer", secret: "keep-me" } });

    // A display-name edit must not drop the secret the gateway calls with.
    expect((await h.patch("review-agent", { displayName: "Review" })).status).toBe(200);
    expect(h.creds).toHaveLength(1);
    expect(h.agents[0].displayName).toBe("Review");

    expect((await h.patch("review-agent", { credential: null })).status).toBe(200);
    expect(h.creds).toEqual([]);
  });

  it("re-fetches the card when the endpoint moves", async () => {
    const h = await harness();
    await h.register(valid);

    const res = await h.patch("review-agent", {
      endpointUrl: "https://review-2.acme.example/",
    });
    expect(res.status).toBe(200);
    expect(h.agents[0].endpointUrl).toBe("https://review-2.acme.example/");
    // Stored because it answered there, not because it was submitted.
    expect(h.agents[0].health).toBe("healthy");
    expect(h.agents[0].cardFetchedAt).not.toBeNull();
  });

  it("keeps the old row when the new endpoint serves no card", async () => {
    const h = await harness({ cardStatus: 500 });
    // Seed past the card fetch by registering against a responder that works,
    // then move to one that does not.
    h.agents.push({
      tenantId: 1,
      agentId: "review-agent",
      displayName: "Codex Review Agent",
      endpointUrl: "https://review.acme.example/",
      card: CARD,
      health: "healthy",
      cardFetchedAt: "2026-09-11T00:00:00.000Z",
      lastSeenAt: null,
    });

    const res = await h.patch("review-agent", { endpointUrl: "https://gone.example/" });
    expect(res.status).toBe(502);
    expect(h.agents[0].endpointUrl).toBe("https://review.acme.example/");
  });

  it("rejects a patch that changes nothing", async () => {
    const h = await harness();
    await h.register(valid);
    const res = await h.patch("review-agent", {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "no_changes" });
  });

  it("rejects an endpoint that is not a URL", async () => {
    const h = await harness();
    await h.register(valid);
    const res = await h.patch("review-agent", { endpointUrl: "review-2.acme.example" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_endpoint" });
  });

  it("meters an endpoint change but not a credential change", async () => {
    const h = await harness({ rateLimit: { limit: 1, windowMs: 60_000 } });
    // The registration itself spends the one allowed outbound request.
    expect((await h.register(valid)).status).toBe(201);

    const moved = await h.patch("review-agent", {
      endpointUrl: "https://review-2.acme.example/",
    });
    expect(moved.status).toBe(429);

    // No outbound request, so no reason to meter it.
    const cred = await h.patch("review-agent", {
      credential: { scheme: "bearer", secret: "s" },
    });
    expect(cred.status).toBe(200);
  });

  it("answers 404 for another tenant's agent", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");
    const res = await h.patch("review-agent", { displayName: "theirs" }, "user=bob");
    expect(res.status).toBe(404);
    expect(h.agents[0].displayName).toBe("Codex Review Agent");
  });
});

describe("GET /api/agents/:id", () => {
  it("returns the agent with the schema each skill was registered with", async () => {
    const h = await harness({
      card: {
        ...CARD,
        skills: [
          {
            id: "review.pr",
            name: "Review PR",
            description: "Review a PR.",
            inputSchema: { type: "object", properties: { pr: { type: "number" } } },
          },
        ],
      },
    });
    await h.register(valid);

    const res = await h.call("/api/agents/review-agent", { headers: { cookie: "user=ada" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      agent: {
        agentId: "review-agent",
        skills: [{ id: "review.pr", inputSchema: { type: "object" } }],
      },
    });
  });

  it("includes run stats scoped to just this agent", async () => {
    const h = await harness();
    await h.register(valid);
    await h.register({ agentId: "other-agent", endpointUrl: "https://other.example/" });
    h.tasks.push(
      {
        id: 1,
        tenantId: TENANTS.ada.id,
        upstreamTaskId: "u1",
        callerAgentId: "user:ada",
        callerCallbackUrl: null,
        callerCallbackAuth: null,
        targetAgentId: "review-agent",
        skillId: "review.pr",
        downstreamTaskId: null,
        state: "done",
        attempt: 0,
        nextRetryAt: null,
        deadlineAt: "2026-09-11T01:00:00.000Z",
        result: null,
        notifiedAt: null,
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
      {
        id: 2,
        tenantId: TENANTS.ada.id,
        upstreamTaskId: "u2",
        callerAgentId: "user:ada",
        callerCallbackUrl: null,
        callerCallbackAuth: null,
        targetAgentId: "other-agent",
        skillId: "x",
        downstreamTaskId: null,
        state: "failed",
        attempt: 0,
        nextRetryAt: null,
        deadlineAt: "2026-09-11T01:00:00.000Z",
        result: null,
        notifiedAt: null,
        createdAt: "2026-09-11T00:00:00.000Z",
        updatedAt: "2026-09-11T00:00:00.000Z",
      },
    );

    const res = await h.call("/api/agents/review-agent", { headers: { cookie: "user=ada" } });
    expect(res.body).toMatchObject({
      agent: { agentId: "review-agent", stats: { totalRuns: 1, succeeded: 1, failed: 0 } },
    });
  });

  it("answers 404 for another tenant's agent", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");
    const res = await h.call("/api/agents/review-agent", { headers: { cookie: "user=bob" } });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/agents/:id", () => {
  it("removes the agent along with its tokens and credential", async () => {
    const h = await harness();
    await h.register({ ...valid, credential: { scheme: "bearer", secret: "s" } });

    const res = await h.remove("review-agent");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ agentId: "review-agent", removed: true });
    expect(h.agents).toEqual([]);
    expect(h.tokens).toEqual([]);
    expect(h.creds).toEqual([]);
    expect((await h.list()).body).toEqual({ agents: [] });
  });

  it("keeps the tasks the agent already ran", async () => {
    const h = await harness();
    await h.register(valid);
    const sent = await h.message("review-agent", { skillId: "review.pr", text: "go" });
    expect(sent.status).toBe(202);

    await h.remove("review-agent");
    // The ledger of what happened is not the registry's to erase, and the row
    // names the agent by text so nothing cascades into it.
    expect(h.tasks).toHaveLength(1);
    expect((await h.task(1)).status).toBe(200);
  });

  it("answers 404 for another tenant's agent and leaves it alone", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");
    expect((await h.remove("review-agent", "user=bob")).status).toBe(404);
    expect(h.agents).toHaveLength(1);
  });
});

describe("POST /api/agents/:id/messages", () => {
  it("dispatches with the user as the caller and no caller webhook", async () => {
    const h = await harness();
    await h.register(valid);

    const res = await h.message("review-agent", { skillId: "review.pr", text: "review #9" });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      task: {
        // `user:<id>`, the same shape the composition layer uses for a run.
        // Registering a fake agent for the console would have put it in the
        // catalog and made it dispatchable by a workflow.
        callerAgentId: "user:ada",
        targetAgentId: "review-agent",
        skillId: "review.pr",
      },
    });
    // A browser is not a push target, so nothing is notified on completion.
    expect(h.tasks[0].callerCallbackUrl).toBeNull();
    expect(h.tasks[0].downstreamTaskId).toBe("downstream-1");
    expect(h.events.map((e) => e.eventType)).toEqual(["dispatched"]);
  });

  it("refuses a skill the card does not offer", async () => {
    const h = await harness();
    await h.register(valid);

    const res = await h.message("review-agent", { skillId: "deploy.prod", data: {} });
    // Caught here rather than minutes later at the agent, and the message
    // names what the card does offer.
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "unknown_skill" });
    expect((res.body as { message: string }).message).toContain("review.pr");
    expect(h.tasks).toEqual([]);
  });

  it("closes the task out when the agent cannot be reached", async () => {
    const h = await harness({ sendFails: "connect ECONNREFUSED" });
    await h.register(valid);

    const res = await h.message("review-agent", { skillId: "review.pr", text: "go" });
    expect(res.status).toBe(502);
    // Left failed, not dangling: the deadline sweep must not resurrect a task
    // that never left the process.
    expect(h.tasks[0].state).toBe("failed");
    expect(h.events.map((e) => e.eventType)).toEqual(["dispatch_failed"]);
  });

  it("takes A2A parts as they are and sugar for the single-part case", async () => {
    const h = await harness();
    await h.register(valid);

    expect(
      (await h.message("review-agent", {
        skillId: "review.pr",
        parts: [{ kind: "text", text: "look" }, { kind: "data", data: { pr: 9 } }],
      })).status,
    ).toBe(202);
    expect((await h.message("review-agent", { skillId: "review.pr", data: { pr: 9 } })).status).toBe(202);
    expect((await h.message("review-agent", { skillId: "review.pr" })).status).toBe(400);
    expect(
      (await h.message("review-agent", { skillId: "review.pr", parts: [{ kind: "nope" }] })).status,
    ).toBe(400);
  });

  it("refuses an anonymous caller and another tenant's agent", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");

    const anon = await h.call("/api/agents/review-agent/messages", {
      method: "POST",
      body: JSON.stringify({ skillId: "review.pr", text: "go" }),
    });
    expect(anon.status).toBe(401);
    expect((await h.message("review-agent", { skillId: "review.pr", text: "go" }, "user=bob")).status).toBe(404);
    expect(h.tasks).toEqual([]);
  });
});

describe("POST /api/agents/:id/messages — the skill's inputSchema", () => {
  /** A card whose skill says what it accepts. */
  const schemaCard = {
    ...CARD,
    skills: [
      {
        id: "review.pr",
        name: "Review PR",
        description: "Review a PR.",
        inputSchema: {
          type: "object",
          properties: { pr: { type: "number" }, note: { type: "string" } },
          required: ["pr"],
          additionalProperties: false,
        },
      },
    ],
  };

  it("dispatches a payload that matches", async () => {
    const h = await harness({ card: schemaCard });
    await h.register(valid);

    const res = await h.message("review-agent", { skillId: "review.pr", data: { pr: 9 } });
    expect(res.status).toBe(202);
    expect(h.tasks).toHaveLength(1);
  });

  it("refuses a payload the skill does not accept, naming every field", async () => {
    const h = await harness({ card: schemaCard });
    await h.register(valid);

    const res = await h.message("review-agent", {
      skillId: "review.pr",
      data: { note: 5, typo: true },
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        { path: "pr", message: "required, but missing" },
        { path: "note", message: "must be string" },
        { path: "typo", message: "not declared by this skill" },
      ]),
    );
  });

  it("writes no task row for a payload it refuses", async () => {
    const h = await harness({ card: schemaCard });
    await h.register(valid);
    await h.message("review-agent", { skillId: "review.pr", data: {} });
    // The check runs before the ledger is touched, so a rejected message
    // leaves nothing behind to explain later.
    expect(h.tasks).toHaveLength(0);
    expect(h.events).toEqual([]);
  });

  it("refuses text alone when the skill requires structured input", async () => {
    const h = await harness({ card: schemaCard });
    await h.register(valid);

    const res = await h.message("review-agent", { skillId: "review.pr", text: "review #9" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(res.body.message).toContain("structured input");
  });

  it("still takes text for a skill that declares nothing", async () => {
    // `inputSchema` is optional on the card; an agent without one accepts
    // whatever it accepts, and we are not the ones to start guessing.
    const h = await harness();
    await h.register(valid);
    const res = await h.message("review-agent", { skillId: "review.pr", text: "review #9" });
    expect(res.status).toBe(202);
  });

  it("still takes text for a skill whose schema requires nothing", async () => {
    const h = await harness({
      card: {
        ...CARD,
        skills: [
          {
            id: "review.pr",
            name: "Review PR",
            description: "Review a PR.",
            inputSchema: { type: "object", properties: { pr: { type: "number" } } },
          },
        ],
      },
    });
    await h.register(valid);
    const res = await h.message("review-agent", { skillId: "review.pr", text: "review #9" });
    expect(res.status).toBe(202);
  });
});

describe("GET /api/tasks/:id", () => {
  it("returns the task the page polls", async () => {
    const h = await harness();
    await h.register(valid);
    await h.message("review-agent", { skillId: "review.pr", text: "go" });

    const res = await h.task(1);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ task: { id: 1, state: "running", result: null } });
  });

  it("answers 404 for another tenant's task", async () => {
    const h = await harness();
    await h.register(valid, "user=ada");
    await h.message("review-agent", { skillId: "review.pr", text: "go" });

    expect((await h.task(1, "user=bob")).status).toBe(404);
    expect((await h.task(9999)).status).toBe(404);
  });
});
