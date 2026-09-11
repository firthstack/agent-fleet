import { describe, expect, it, vi } from "vitest";
import {
  createWorkflowDispatcher,
  WorkflowDispatchError,
  type WorkflowDispatchStore,
} from "../../src/fleet/workflow/dispatcher.js";
import {
  createGateway,
  type GatewayStorePort,
  type GatewayWorkflowsPort,
  type GatewayWorkflowStarter,
} from "../../src/fleet/site/gateway.js";
import type { A2AClient } from "../../src/fleet/site/a2aClient.js";
import type { WorkflowRunRecord } from "../../src/fleet/workflow/driver.js";
import type {
  FleetTaskRecord,
  GatewayAgentRecord,
  TenantRecord,
} from "../../src/fleet/site/gatewayStore.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";
import type { WorkflowDefinition } from "../../src/fleet/workflow/engine.js";

const ACME: TenantRecord = {
  id: 1,
  slug: "acme",
  displayName: "Acme",
  createdAt: "2026-09-11T00:00:00.000Z",
};

function card(skills: string[]): A2AAgentCard {
  return {
    name: "Agent",
    description: "d",
    version: "1.0.0",
    skills: skills.map((id) => ({ id, name: id, description: id })),
  };
}

function agent(agentId: string, skills: string[]): GatewayAgentRecord {
  return {
    tenantId: ACME.id,
    agentId,
    displayName: agentId,
    endpointUrl: `https://${agentId}.internal.example/`,
    card: card(skills),
    health: "healthy",
    cardFetchedAt: null,
    lastSeenAt: null,
  };
}

// ---------------------------------------------------------------- dispatcher

function dispatchHarness(opts: {
  agents?: GatewayAgentRecord[];
  sendFails?: boolean;
}) {
  const agents = opts.agents ?? [agent("dev-agent", ["develop.issue"])];
  const created: Array<Record<string, unknown>> = [];
  const attached: Array<{ taskId: number; downstreamTaskId: string }> = [];
  const failed: number[] = [];
  const events: string[] = [];
  let nextId = 500;

  const store: WorkflowDispatchStore = {
    async findAgentsBySkill(_tenantId, skillId) {
      return agents.filter((a) => a.card.skills.some((s) => s.id === skillId));
    },
    async getAgentCredential() {
      return { scheme: "bearer", secret: "target-secret" };
    },
    async createTask(input) {
      created.push(input as unknown as Record<string, unknown>);
      return { id: nextId++ } as FleetTaskRecord;
    },
    async attachDownstream(taskId, input) {
      attached.push({ taskId, downstreamTaskId: input.downstreamTaskId });
    },
    async failTask(taskId) {
      failed.push(taskId);
    },
    async appendTaskEvent(input) {
      events.push(input.eventType);
    },
  };

  const client: A2AClient = {
    async fetchAgentCard() {
      return card([]);
    },
    async sendMessage() {
      if (opts.sendFails) throw new Error("connection refused");
      return { taskId: "down-1", state: "submitted" };
    },
  };

  const dispatcher = createWorkflowDispatcher({
    store,
    client,
    publicBaseUrl: "https://fleet.example.com",
    newUpstreamTaskId: () => "up-1",
    newCallbackToken: () => "cbtok",
    hashToken: (t) => `hash:${t}`,
  });

  return { dispatcher, created, attached, failed, events };
}

const step = {
  tenantId: ACME.id,
  workflowRunId: 9,
  fromState: "developing",
  skillId: "develop.issue",
  payload: { requirement: "x" },
  deadlineAt: new Date("2026-09-11T06:00:00.000Z"),
};

describe("workflow dispatcher", () => {
  it("records the run and the state the step came from", async () => {
    const h = dispatchHarness({});
    const { taskId } = await h.dispatcher.dispatch(step);

    expect(h.created[0]).toMatchObject({
      workflowRunId: 9,
      // Without this, a retry after a failed dispatch would advance from the
      // run's state, which is already one ahead.
      workflowFromState: "developing",
      targetAgentId: "dev-agent",
      // The run is the caller; there is no agent webhook to notify.
      callerAgentId: "workflow:9",
    });
    expect(h.created[0].callerCallbackUrl).toBeUndefined();
    expect(h.attached).toEqual([{ taskId, downstreamTaskId: "down-1" }]);
  });

  it("refuses when no agent offers the skill", async () => {
    const h = dispatchHarness({ agents: [] });
    await expect(h.dispatcher.dispatch(step)).rejects.toMatchObject({
      code: "no_agent",
    });
  });

  it("refuses to guess when several agents offer the skill", async () => {
    // The gateway never picks on the caller's behalf (docs §6.1); silently
    // routing to the wrong one is the bug that rule prevents.
    const h = dispatchHarness({
      agents: [
        agent("dev-agent", ["develop.issue"]),
        agent("dev-agent-canary", ["develop.issue"]),
      ],
    });
    await expect(h.dispatcher.dispatch(step)).rejects.toMatchObject({
      code: "ambiguous_agent",
    });
  });

  it("closes out the task when the downstream refuses the send", async () => {
    const h = dispatchHarness({ sendFails: true });
    await expect(h.dispatcher.dispatch(step)).rejects.toBeInstanceOf(
      WorkflowDispatchError,
    );
    // Left open, the deadline sweep would later resurrect a task that never
    // reached anyone.
    expect(h.failed).toHaveLength(1);
    expect(h.attached).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ gateway

const TOKEN = "wf-token";

const validDefinition: WorkflowDefinition = {
  workflow: "demo",
  version: 1,
  start: [{ goto: "a" }],
  states: { a: { call: { skill: "s.one" }, next: [{ goto: "completed" }] } },
};

function run(id = 5): WorkflowRunRecord {
  return {
    id,
    tenantId: ACME.id,
    workflowId: 7,
    state: "developing",
    status: "developing",
    reason: null,
    vars: { requirement: "x" },
    sourceType: "a2a",
    sourceRef: "ref-1",
    awaitingTaskId: 100,
    updatedAt: "2026-09-11T00:00:05.000Z",
  };
}

function gatewayHarness(opts: { wired?: boolean } = { wired: true }) {
  const published: Array<{ name: string; version: number }> = [];
  const started: Array<Record<string, unknown>> = [];

  const store = {
    async getTenantBySlug(slug: string) {
      return slug === "acme" ? ACME : null;
    },
    async resolveAgentToken(hash: string) {
      return hash === `hash:${TOKEN}` ? { tenantId: ACME.id, agentId: "caller" } : null;
    },
    async getAgent() {
      return null;
    },
    async listAgents() {
      return [];
    },
    async findAgentsBySkill() {
      return [];
    },
    async createTask() {
      throw new Error("not used");
    },
    async attachDownstream() {},
    async failTask() {},
    async getTaskByUpstreamId() {
      return null;
    },
    async appendTaskEvent() {},
  } as unknown as GatewayStorePort;

  const workflows: GatewayWorkflowsPort = {
    async putDefinition(input) {
      published.push({ name: input.name, version: input.version });
      return { id: 7 };
    },
    async listDefinitions() {
      return [{ id: 7, name: "demo", version: 1 }];
    },
    async getRun(_tenantId, runId) {
      return runId === 5 ? run() : null;
    },
    async listRuns() {
      return [run()];
    },
    async listRunEvents() {
      return [
        { eventType: "created", payload: {}, createdAt: "2026-09-11T00:00:00.000Z" },
        { eventType: "developing", payload: {}, createdAt: "2026-09-11T00:00:01.000Z" },
      ];
    },
  };

  const starter: GatewayWorkflowStarter = {
    async start(input) {
      started.push(input as unknown as Record<string, unknown>);
      return { run: run(), deduplicated: input.sourceRef === "dup" };
    },
  };

  const handle = createGateway({
    store,
    workflows: opts.wired ? workflows : undefined,
    workflowStarter: opts.wired ? starter : undefined,
    client: {} as A2AClient,
    credentials: async () => null,
    publicBaseUrl: "https://fleet.example.com",
    newUpstreamTaskId: () => "generated-ref",
    newCallbackToken: () => "cbtok",
    hashToken: (t) => `hash:${t}`,
  });

  return { handle, published, started };
}

function req(method: string, path: string, body?: unknown, token = TOKEN) {
  return { method, path, bearerToken: token, body };
}

describe("workflow endpoints", () => {
  it("publishes a definition after validating it", async () => {
    const h = gatewayHarness();
    const res = await h.handle(
      req("PUT", "/a2a/t/acme/workflows/demo/1", validDefinition),
    );
    expect(res.status).toBe(200);
    expect(h.published).toEqual([{ name: "demo", version: 1 }]);
  });

  it("rejects a definition that would break mid-run", async () => {
    const h = gatewayHarness();
    const res = await h.handle(
      req("PUT", "/a2a/t/acme/workflows/demo/1", {
        ...validDefinition,
        start: [{ goto: "nowhere" }],
      }),
    );
    // Catching this at publish time instead of hours into real work is the
    // whole point of validating here.
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_definition");
    expect(h.published).toHaveLength(0);
  });

  it("starts a run and reports it as created", async () => {
    const h = gatewayHarness();
    const res = await h.handle(
      req("POST", "/a2a/t/acme/workflows/demo/runs", {
        payload: { requirement: "Add the thing" },
        sourceRef: "issue-9",
      }),
    );
    expect(res.status).toBe(201);
    expect(h.started[0]).toMatchObject({
      workflowName: "demo",
      sourceRef: "issue-9",
      createdBy: "caller",
    });
  });

  it("reports a deduplicated start as 200, not 201", async () => {
    const h = gatewayHarness();
    const res = await h.handle(
      req("POST", "/a2a/t/acme/workflows/demo/runs", { payload: {}, sourceRef: "dup" }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { deduplicated: boolean }).deduplicated).toBe(true);
  });

  it("gives each request its own run when no sourceRef is supplied", async () => {
    const h = gatewayHarness();
    await h.handle(req("POST", "/a2a/t/acme/workflows/demo/runs", { payload: {} }));
    expect(h.started[0].sourceRef).toBe("generated-ref");
  });

  it("returns a run and its event timeline", async () => {
    const h = gatewayHarness();
    const runRes = await h.handle(req("GET", "/a2a/t/acme/workflows/runs/5"));
    expect((runRes.body as { run: { status: string } }).run.status).toBe("developing");

    const events = await h.handle(req("GET", "/a2a/t/acme/workflows/runs/5/events"));
    // This is the data the run viewer is built from.
    expect(
      (events.body as { events: Array<{ eventType: string }> }).events.map(
        (e) => e.eventType,
      ),
    ).toEqual(["created", "developing"]);
  });

  it("lists runs for the run viewer", async () => {
    const h = gatewayHarness();
    const res = await h.handle(req("GET", "/a2a/t/acme/workflows/runs"));
    expect(res.status).toBe(200);
    const runs = (res.body as { runs: Array<{ id: number; updatedAt: unknown }> }).runs;
    expect(runs[0].id).toBe(5);
    // The viewer leads with how long a run has sat in its current state, so
    // the timestamp has to come through.
    expect(runs[0]).toHaveProperty("updatedAt");
  });

  it("lists published definitions", async () => {
    const h = gatewayHarness();
    const res = await h.handle(req("GET", "/a2a/t/acme/workflows"));
    expect((res.body as { workflows: unknown[] }).workflows).toHaveLength(1);
  });

  it("answers 404 for a run that does not exist", async () => {
    const h = gatewayHarness();
    expect((await h.handle(req("GET", "/a2a/t/acme/workflows/runs/999"))).status).toBe(
      404,
    );
  });

  it("requires a token, and refuses one from another tenant", async () => {
    const h = gatewayHarness();
    expect((await h.handle(req("GET", "/a2a/t/acme/workflows", undefined, ""))).status).toBe(
      401,
    );
    expect(
      (await h.handle(req("GET", "/a2a/t/globex/workflows", undefined, TOKEN))).status,
    ).toBe(401);
  });

  it("answers 404 when no composition layer is wired in", async () => {
    const h = gatewayHarness({ wired: false });
    expect((await h.handle(req("GET", "/a2a/t/acme/workflows"))).status).toBe(404);
    expect(
      (await h.handle(req("POST", "/a2a/t/acme/workflows/demo/runs", { payload: {} })))
        .status,
    ).toBe(404);
  });

  it("does not shadow the agent routes", async () => {
    const h = gatewayHarness();
    // `/workflows/...` and `/agents/...` share a prefix; a greedy pattern
    // would swallow one of them.
    const res = await h.handle(req("GET", "/a2a/t/acme/catalog"));
    expect(res.status).toBe(200);
  });
});
