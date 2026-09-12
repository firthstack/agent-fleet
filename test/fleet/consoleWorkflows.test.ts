import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createConsoleHandler,
  type ConsoleAuth,
  type ConsoleRegistration,
  type ConsoleStore,
  type ConsoleWorkflowStarter,
  type ConsoleWorkflows,
} from "../../src/fleet/console/api.js";
import type { ConsoleMessenger } from "../../src/fleet/console/api.js";
import type { WorkflowRunRecord } from "../../src/fleet/workflow/driver.js";
import { WorkflowDriverError } from "../../src/fleet/workflow/driver.js";
import { WorkflowDispatchError } from "../../src/fleet/workflow/dispatcher.js";
import { WorkflowError } from "../../src/fleet/workflow/engine.js";
import type { WorkflowDefinition } from "../../src/fleet/workflow/engine.js";
import type { GatewayAgentRecord, TenantRecord } from "../../src/fleet/site/gatewayStore.js";

/**
 * The console's half of the composition layer (docs/fleet-console.md §5, §7,
 * §8) — publishing, validating, starting a run, and reading runs back.
 *
 * What is real here is everything the console owns: that the tenant comes
 * from the session and never from the request, that publishing is gated on
 * the same validator the gateway uses, and that a run belonging to someone
 * else is not found rather than forbidden. The store is in memory, so this
 * suite needs no container.
 */

const TENANTS: Record<string, TenantRecord> = {
  ada: { id: 1, slug: "ada", displayName: "ada", createdAt: "2026-09-11T00:00:00.000Z" },
  bob: { id: 2, slug: "bob", displayName: "bob", createdAt: "2026-09-11T00:00:00.000Z" },
};

/** The worked example's shape: a loop back from review to revision, which is
 *  the thing a DAG could not express. */
const VALID: WorkflowDefinition = {
  workflow: "develop-review-merge",
  version: 1,
  start: [{ goto: "developing" }],
  states: {
    developing: {
      call: { skill: "dev.implement", payload: {} },
      next: [{ when: "result.pr", goto: "reviewing" }, { fail: "no PR opened" }],
    },
    reviewing: {
      call: { skill: "review.pr", payload: {} },
      next: [
        { when: "result.approved", goto: "completed" },
        { when: "result.changes", goto: "developing" },
        { escalate: "review only commented" },
      ],
    },
  },
};

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

function fixture() {
  const defs: Array<{
    id: number;
    tenantId: number;
    name: string;
    version: number;
    definition: WorkflowDefinition;
  }> = [];
  const runs: WorkflowRunRecord[] = [];
  const events: Array<{
    tenantId: number;
    runId: number;
    eventType: string;
    payload: unknown;
    createdAt: string;
  }> = [];

  const workflows: ConsoleWorkflows = {
    async putDefinition(input) {
      const existing = defs.find(
        (d) =>
          d.tenantId === input.tenantId &&
          d.name === input.name &&
          d.version === input.version,
      );
      if (existing) {
        existing.definition = input.definition;
        return { id: existing.id };
      }
      const row = { id: defs.length + 1, ...input };
      defs.push(row);
      return { id: row.id };
    },
    async listDefinitions(tenantId) {
      return defs
        .filter((d) => d.tenantId === tenantId)
        .map((d) => ({ id: d.id, name: d.name, version: d.version }));
    },
    async findDefinition(tenantId, name, version) {
      const matches = defs
        .filter((d) => d.tenantId === tenantId && d.name === name)
        .sort((a, b) => b.version - a.version);
      const found =
        version === undefined ? matches[0] : matches.find((d) => d.version === version);
      return found ? { id: found.id, definition: found.definition } : null;
    },
    async getRun(tenantId, runId) {
      return runs.find((r) => r.tenantId === tenantId && r.id === runId) ?? null;
    },
    async listRuns(tenantId, limit = 100) {
      return runs.filter((r) => r.tenantId === tenantId).slice(0, limit);
    },
    async listRunEvents(tenantId, runId) {
      return events
        .filter((e) => e.tenantId === tenantId && e.runId === runId)
        .map((e) => ({ eventType: e.eventType, payload: e.payload, createdAt: e.createdAt }));
    },
  };

  const starts: Array<Parameters<ConsoleWorkflowStarter["start"]>[0]> = [];
  let startThrows: Error | null = null;
  const starter: ConsoleWorkflowStarter = {
    async start(input) {
      starts.push(input);
      if (startThrows) throw startThrows;
      const already = runs.find(
        (r) => r.tenantId === input.tenantId && r.sourceRef === input.sourceRef,
      );
      if (already) return { run: already, deduplicated: true };
      const run: WorkflowRunRecord = {
        id: runs.length + 1,
        tenantId: input.tenantId,
        workflowId: 1,
        state: "developing",
        status: "developing",
        reason: null,
        vars: input.payload,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        awaitingTaskId: 7,
        updatedAt: "2026-09-11T00:00:00.000Z",
      };
      runs.push(run);
      events.push({
        tenantId: input.tenantId,
        runId: run.id,
        eventType: "created",
        payload: { workflow: input.workflowName },
        createdAt: "2026-09-11T00:00:00.000Z",
      });
      return { run, deduplicated: false };
    },
  };

  return {
    defs,
    runs,
    events,
    starts,
    workflows,
    starter,
    throwOnStart(err: Error) {
      startThrows = err;
    },
  };
}

/** Neither surface is exercised here, so both are stubs that throw if used. */
const unusedRegistration = {
  register: () => Promise.reject(new Error("unused")),
  rotateToken: () => Promise.reject(new Error("unused")),
  update: () => Promise.reject(new Error("unused")),
} as unknown as ConsoleRegistration;

const unusedMessenger = {
  send: () => Promise.reject(new Error("unused")),
} as unknown as ConsoleMessenger;

/** The tenant's connected agents, as the payload check reads them. */
function storeWith(agents: GatewayAgentRecord[] = []): ConsoleStore {
  return {
  async tenantForUser(userId) {
    return TENANTS[userId] ?? null;
  },
  async ensureTenantForUser(user) {
    return TENANTS[user.id] ?? TENANTS.ada;
  },
  async listAgents(tenantId) {
    return agents.filter((a) => a.tenantId === tenantId);
  },
  async getAgent() {
    return null;
  },
  async deleteAgent() {
    return false;
  },
  async getTask() {
    return null;
  },
  };
}

/** A dev agent whose card says exactly what its skill accepts. */
const DEV_AGENT = {
  tenantId: TENANTS.ada.id,
  agentId: "dev-agent",
  displayName: "Dev Agent",
  endpointUrl: "https://dev.example.com",
  card: {
    name: "Dev Agent",
    description: "Implements things.",
    version: "1.0.0",
    skills: [
      {
        id: "dev.implement",
        name: "Implement",
        description: "Implement a requirement.",
        inputSchema: {
          type: "object",
          properties: { requirement: { type: "string" }, iteration: { type: "number" } },
          required: ["requirement"],
          additionalProperties: false,
        },
      },
    ],
  },
  health: "healthy",
  cardFetchedAt: "2026-09-11T00:00:00.000Z",
  lastSeenAt: null,
} as unknown as GatewayAgentRecord;

async function harness(opts: { composition?: boolean; agents?: GatewayAgentRecord[] } = {}) {
  const f = fixture();
  const handler = createConsoleHandler({
    auth,
    store: storeWith(opts.agents ?? []),
    registration: unusedRegistration,
    messenger: unusedMessenger,
    // Omitting both is the shape of a gateway with no composition layer
    // wired in — the routes have to answer 404, not 500.
    ...(opts.composition === false
      ? {}
      : { workflows: f.workflows, workflowStarter: f.starter }),
    origin: "http://127.0.0.1",
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

  async function call(
    path: string,
    init: RequestInit & { cookie?: string | null } = {},
  ) {
    const { cookie = "user=ada", ...rest } = init;
    const res = await fetch(`${base}${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(rest.headers ?? {}),
      },
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as JsonBody };
  }

  return { ...f, call };
}

describe("checking a definition against the fleet it will run on", () => {
  /** The worked example's first step, with a payload to match DEV_AGENT. */
  function withCall(payload: unknown): WorkflowDefinition {
    return {
      workflow: "w",
      version: 1,
      start: [{ goto: "developing" }],
      states: {
        developing: {
          call: { skill: "dev.implement", payload },
          next: [{ goto: "completed" }],
        },
      },
    } as unknown as WorkflowDefinition;
  }

  it("warns that nothing offers the skill, without blocking the draft", async () => {
    const { call } = await harness();
    const res = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(withCall({ requirement: "{{vars.r}}" })),
    });

    expect(res.status).toBe(200);
    // The definition itself is fine; the fleet is what is missing.
    expect(res.body.valid).toBe(true);
    expect(res.body.issues).toEqual([]);
    expect(res.body.warnings).toEqual([
      {
        path: "states.developing.call.skill",
        message: "no agent in this tenant offers dev.implement",
      },
    ]);
  });

  it("is quiet when the payload matches the connected agent's schema", async () => {
    const { call } = await harness({ agents: [DEV_AGENT] });
    const res = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(withCall({ requirement: "{{vars.r}}", iteration: 2 })),
    });
    expect(res.body.warnings).toEqual([]);
  });

  it("names the field the skill does not accept", async () => {
    const { call } = await harness({ agents: [DEV_AGENT] });
    const res = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(withCall({ requirment: "{{vars.r}}" })),
    });
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([
        {
          path: "states.developing.call.payload.requirement",
          message: "required, but missing",
        },
        {
          path: "states.developing.call.payload.requirment",
          message: "not declared by this skill",
        },
      ]),
    );
  });

  it("publishes anyway, and says what it is publishing against", async () => {
    const { call, defs } = await harness();
    const res = await call("/api/workflows/w/1", {
      method: "PUT",
      body: JSON.stringify(withCall({ requirement: "{{vars.r}}" })),
    });

    // Advisory, not a gate: a definition may legitimately be written before
    // the agent that serves it is connected.
    expect(res.status).toBe(200);
    expect(defs).toHaveLength(1);
    expect(res.body.warnings[0].message).toContain("no agent in this tenant offers");
  });

  it("only sees its own tenant's agents", async () => {
    const { call } = await harness({ agents: [DEV_AGENT] });
    const res = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(withCall({ requirement: "{{vars.r}}" })),
      cookie: "user=bob",
    });
    // DEV_AGENT belongs to ada, so for bob the skill is simply not offered.
    expect(res.body.warnings[0].message).toContain("no agent in this tenant offers");
  });
});

describe("console workflows", () => {
  it("publishes a definition and lists it back", async () => {
    const { call, defs } = await harness();

    const put = await call("/api/workflows/develop-review-merge/1", {
      method: "PUT",
      body: JSON.stringify(VALID),
    });
    expect(put.status).toBe(200);
    expect(defs[0].tenantId).toBe(TENANTS.ada.id);

    const list = await call("/api/workflows");
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      workflows: [{ id: 1, name: "develop-review-merge", version: 1 }],
    });
  });

  it("refuses a definition that would break mid-run", async () => {
    const { call, defs } = await harness();
    const broken = {
      ...VALID,
      states: {
        developing: {
          call: { skill: "dev.implement" },
          next: [{ goto: "nowhere" }],
        },
      },
    };

    const res = await call("/api/workflows/broken/1", {
      method: "PUT",
      body: JSON.stringify(broken),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_definition");
    expect(res.body.issues.length).toBeGreaterThan(0);
    // Nothing half-published.
    expect(defs).toHaveLength(0);
  });

  it("answers validate with the issues rather than an error status", async () => {
    const { call } = await harness();

    const ok = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(VALID),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ valid: true, issues: [] });

    // A draft mid-edit is the normal case, not a failed request: the editor
    // asked a question and has to get an answer it can render.
    const bad = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify({ workflow: "x" }),
    });
    expect(bad.status).toBe(200);
    expect(bad.body.valid).toBe(false);
    expect(bad.body.issues.length).toBeGreaterThan(0);
  });

  it("never lets `validate` be shadowed by a workflow of that name", async () => {
    const { call } = await harness();
    // The literal route wins, so POSTing it is a validation, not a run start.
    const res = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(VALID),
    });
    expect(res.body).toHaveProperty("valid");
  });

  it("reads the latest version unless one is named", async () => {
    const { call } = await harness();
    for (const version of [1, 2]) {
      await call(`/api/workflows/develop-review-merge/${version}`, {
        method: "PUT",
        body: JSON.stringify({ ...VALID, version }),
      });
    }

    const latest = await call("/api/workflows/develop-review-merge/latest");
    expect(latest.status).toBe(200);
    expect(latest.body.definition.version).toBe(2);

    const pinned = await call("/api/workflows/develop-review-merge/1");
    expect(pinned.body.definition.version).toBe(1);
  });

  it("refuses to publish to `latest`, so a version is always named", async () => {
    const { call } = await harness();
    const res = await call("/api/workflows/develop-review-merge/latest", {
      method: "PUT",
      body: JSON.stringify(VALID),
    });
    expect(res.status).toBe(405);
  });

  it("starts a run as the user, not as an agent", async () => {
    const { call, starts } = await harness();

    const res = await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: { requirement: "Fix login" }, sourceRef: "form-1" }),
    });

    expect(res.status).toBe(201);
    expect(res.body.run.id).toBe(1);
    // `user:{id}`, the same shape the messenger stamps — "who started this"
    // stays one readable kind of value across the ledger (docs §8).
    expect(starts[0].createdBy).toBe("user:ada");
    expect(starts[0].sourceType).toBe("console");
    expect(starts[0].tenantId).toBe(TENANTS.ada.id);
  });

  it("does not open a second run for a repeated submission", async () => {
    const { call, runs } = await harness();
    const body = JSON.stringify({ payload: {}, sourceRef: "form-1" });

    const first = await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body,
    });
    const second = await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.run.id).toBe(first.body.run.id);
    expect(runs).toHaveLength(1);
  });

  it("gives a run its own ref when the caller supplies none", async () => {
    const { call, starts } = await harness();
    await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {} }),
    });
    await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {} }),
    });
    // Without a ref from the caller, each request is its own run.
    expect(starts[0].sourceRef).not.toBe(starts[1].sourceRef);
  });

  it("reads a run and its timeline", async () => {
    const { call } = await harness();
    await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: { requirement: "Fix login" }, sourceRef: "form-1" }),
    });

    const list = await call("/api/runs");
    expect(list.body.runs).toHaveLength(1);
    // The step the run is sitting on is the first question the page asks.
    expect(list.body.runs[0].awaitingTaskId).toBe(7);

    const one = await call("/api/runs/1");
    expect(one.status).toBe(200);
    expect(one.body.run.vars).toEqual({ requirement: "Fix login" });

    const events = await call("/api/runs/1/events");
    expect(events.body.events[0].eventType).toBe("created");
  });

  it("hides another tenant's run behind a 404, not a 403", async () => {
    const { call } = await harness();
    await call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {}, sourceRef: "form-1" }),
    });

    for (const path of ["/api/runs/1", "/api/runs/1/events"]) {
      const res = await call(path, { cookie: "user=bob" });
      // A 403 would confirm the run exists somewhere else (docs §9.3).
      expect(res.status).toBe(404);
    }
    const list = await call("/api/runs", { cookie: "user=bob" });
    expect(list.body.runs).toEqual([]);
  });

  it("takes the tenant from the session and ignores anything in the request", async () => {
    const { call, starts } = await harness();
    await call("/api/workflows/develop-review-merge/runs?tenant=bob", {
      method: "POST",
      body: JSON.stringify({ payload: {}, sourceRef: "form-1", tenantId: TENANTS.bob.id }),
    });
    expect(starts[0].tenantId).toBe(TENANTS.ada.id);
  });

  it("answers 401 with no session, on every route", async () => {
    const { call } = await harness();
    for (const path of ["/api/workflows", "/api/runs", "/api/runs/1", "/api/runs/1/events"]) {
      const res = await call(path, { cookie: null });
      expect(res.status).toBe(401);
    }
    const post = await call("/api/workflows/validate", {
      method: "POST",
      body: JSON.stringify(VALID),
      cookie: null,
    });
    expect(post.status).toBe(401);
  });

  it("answers 404, not 500, when no composition layer is wired in", async () => {
    const { call } = await harness({ composition: false });
    for (const path of ["/api/workflows", "/api/runs", "/api/runs/1"]) {
      expect((await call(path)).status).toBe(404);
    }
    const start = await call("/api/workflows/x/runs", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(404);
  });

  it("refuses a method the route does not have", async () => {
    const { call } = await harness();
    expect((await call("/api/workflows", { method: "POST", body: "{}" })).status).toBe(405);
    expect((await call("/api/runs", { method: "POST", body: "{}" })).status).toBe(405);
    expect(
      (await call("/api/workflows/validate", { method: "GET" })).status,
    ).toBe(405);
  });

  it("reports starting before publishing as a 404, not a server fault", async () => {
    const h = await harness();
    h.throwOnStart(new WorkflowDriverError("unknown workflow: nope"));

    const res = await h.call("/api/workflows/nope/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {} }),
    });

    // Starting from the editor before publishing is an ordinary sequence
    // mistake; a 500 would tell the one person who can fix it nothing.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_workflow");
    expect(res.body.message).toContain("nope");
  });

  it("reports a payload the definition cannot start from as a 400", async () => {
    const h = await harness();
    h.throwOnStart(new WorkflowError("required var missing: requirement"));

    const res = await h.call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {} }),
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_payload");
    expect(res.body.message).toContain("requirement");
  });

  it("names the missing skill when no agent offers the first step", async () => {
    const h = await harness();
    h.throwOnStart(
      new WorkflowDispatchError("no agent in this tenant offers dev.implement", "no_agent"),
    );

    const res = await h.call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {} }),
    });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_agent");
    // The skill id is the actionable part: it says which agent to connect.
    expect(res.body.message).toContain("dev.implement");
    // The run row is already written by the time dispatch fails, so the page
    // has to be told one exists rather than reporting a clean failure.
    expect(res.body.strandedRun).toBe(true);
  });

  it("still reports an unexpected failure as a server error", async () => {
    const h = await harness();
    h.throwOnStart(new Error("the pool is on fire"));

    const res = await h.call("/api/workflows/develop-review-merge/runs", {
      method: "POST",
      body: JSON.stringify({ payload: {} }),
    });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
  });

  it("rejects a body that is not a definition", async () => {
    const { call } = await harness();
    for (const body of ["[]", '"nope"', "null"]) {
      const res = await call("/api/workflows/validate", { method: "POST", body });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
    }
  });
});
