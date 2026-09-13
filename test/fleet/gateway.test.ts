import { describe, expect, it } from "vitest";
import {
  a2aTaskState,
  createGateway,
  rewriteCard,
  type GatewayStorePort,
} from "../../src/fleet/site/gateway.js";
import type { A2AClient, SendMessageArgs } from "../../src/fleet/site/a2aClient.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";
import type {
  FleetTaskRecord,
  GatewayAgentRecord,
  TenantRecord,
} from "../../src/fleet/site/gatewayStore.js";

const ACME: TenantRecord = {
  id: 1,
  slug: "acme",
  displayName: "Acme",
  createdAt: "2026-09-11T00:00:00.000Z",
};
const GLOBEX: TenantRecord = {
  id: 2,
  slug: "globex",
  displayName: "Globex",
  createdAt: "2026-09-11T00:00:00.000Z",
};

function card(skills = ["develop.issue"]): A2AAgentCard {
  return {
    name: "Development Agent",
    description: "Implements requirements.",
    version: "1.0.0",
    url: "https://dev.internal.example/",
    capabilities: { streaming: true, pushNotifications: true },
    securitySchemes: { main: { type: "bearer" } },
    skills: skills.map((id) => ({ id, name: id, description: id })),
  };
}

function agent(
  tenantId: number,
  agentId: string,
  skills?: string[],
): GatewayAgentRecord {
  return {
    tenantId,
    agentId,
    displayName: agentId,
    endpointUrl: `https://${agentId}.internal.example/`,
    card: card(skills),
    health: "healthy",
    cardFetchedAt: null,
    lastSeenAt: null,
  };
}

interface Harness {
  handle: ReturnType<typeof createGateway>;
  tasks: FleetTaskRecord[];
  sent: SendMessageArgs[];
  events: Array<{ eventType: string; taskId: number }>;
  failed: Array<{ taskId: number; result: unknown }>;
}

function harness(
  opts: {
    agents?: GatewayAgentRecord[];
    tokens?: Record<string, { tenantId: number; agentId: string }>;
    sendImpl?: (args: SendMessageArgs) => Promise<{ taskId: string; state: string }>;
  } = {},
): Harness {
  const agents = opts.agents ?? [agent(ACME.id, "dev-agent")];
  const tokens = opts.tokens ?? {
    "hash:wf-token": { tenantId: ACME.id, agentId: "workflow-agent" },
  };
  const tenants = [ACME, GLOBEX];

  const tasks: FleetTaskRecord[] = [];
  const sent: SendMessageArgs[] = [];
  const events: Array<{ eventType: string; taskId: number }> = [];
  const failed: Array<{ taskId: number; result: unknown }> = [];
  let nextId = 1;

  const store: GatewayStorePort = {
    async getTenantBySlug(slug) {
      return tenants.find((t) => t.slug === slug) ?? null;
    },
    async resolveAgentToken(hash) {
      return tokens[hash] ?? null;
    },
    async getAgent(tenantId, agentId) {
      return (
        agents.find((a) => a.tenantId === tenantId && a.agentId === agentId) ?? null
      );
    },
    async listAgents(tenantId) {
      return agents.filter((a) => a.tenantId === tenantId);
    },
    async findAgentsBySkill(tenantId, skillId) {
      return agents.filter(
        (a) =>
          a.tenantId === tenantId && a.card.skills.some((s) => s.id === skillId),
      );
    },
    async createTask(input) {
      const task: FleetTaskRecord = {
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
        completedAt: null,
      };
      tasks.push(task);
      return task;
    },
    async attachDownstream(taskId, input) {
      const t = tasks.find((x) => x.id === taskId);
      if (t) {
        t.downstreamTaskId = input.downstreamTaskId;
        t.state = "running";
      }
    },
    async failTask(taskId, result) {
      const t = tasks.find((x) => x.id === taskId);
      if (t) t.state = "failed";
      failed.push({ taskId, result });
    },
    async getTaskByUpstreamId(tenantId, upstreamTaskId) {
      return (
        tasks.find(
          (t) => t.tenantId === tenantId && t.upstreamTaskId === upstreamTaskId,
        ) ?? null
      );
    },
    async appendTaskEvent(input) {
      events.push({ eventType: input.eventType, taskId: input.taskId });
    },
  };

  const client: A2AClient = {
    async fetchAgentCard() {
      return card();
    },
    async sendMessage(args) {
      sent.push(args);
      return opts.sendImpl
        ? opts.sendImpl(args)
        : { taskId: "down-1", state: "submitted" };
    },
  };

  const handle = createGateway({
    store,
    client,
    credentials: async () => ({ scheme: "bearer", secret: "target-secret" }),
    publicBaseUrl: "https://fleet.example.com",
    newUpstreamTaskId: () => "up-1",
    newCallbackToken: () => "cbtok",
    hashToken: (t) => `hash:${t}`,
    now: () => new Date("2026-09-11T00:00:00.000Z"),
  });

  return { handle, tasks, sent, events, failed };
}

function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 7,
    method: "message/send",
    params: {
      message: { role: "user", parts: [{ kind: "data", data: { requirement: "x" } }] },
      metadata: { skillId: "develop.issue" },
      configuration: {
        pushNotificationConfig: {
          url: "https://workflow.acme.example/hooks",
          authentication: { schemes: ["bearer"] },
        },
      },
      ...overrides,
    },
  };
}

describe("gateway dispatch", () => {
  it("records the task before forwarding, and relays the downstream task id", async () => {
    const h = harness();
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody(),
    });

    expect(res.status).toBe(200);
    expect((res.body as { result: { id: string } }).result.id).toBe("up-1");

    expect(h.tasks).toHaveLength(1);
    expect(h.tasks[0]).toMatchObject({
      callerAgentId: "workflow-agent",
      targetAgentId: "dev-agent",
      skillId: "develop.issue",
      downstreamTaskId: "down-1",
      state: "running",
      callerCallbackUrl: "https://workflow.acme.example/hooks",
    });
  });

  it("points the downstream callback at this gateway, not at the caller", async () => {
    const h = harness();
    await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody(),
    });

    // The target reports to us (③); we relay to the caller (④). It must never
    // be handed the caller's own webhook.
    expect(h.sent[0].pushNotificationConfig.url).toBe(
      "https://fleet.example.com/a2a/callbacks/cbtok",
    );
    expect(h.sent[0].endpointUrl).toBe("https://dev-agent.internal.example/");
    expect(h.sent[0].credential?.secret).toBe("target-secret");
  });

  it("marks the task failed when the downstream refuses", async () => {
    const h = harness({
      sendImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody(),
    });

    expect((res.body as { error: { code: number } }).error.code).toBe(-32603);
    expect(h.tasks[0].state).toBe("failed");
    expect(h.events.map((e) => e.eventType)).toContain("dispatch_failed");
  });

  it("requires an explicit skill when the target offers several", async () => {
    const h = harness({
      agents: [agent(ACME.id, "dev-agent", ["develop.issue", "develop.revise"])],
    });
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody({ metadata: {} }),
    });
    expect((res.body as { error: { message: string } }).error.message).toContain(
      "skillId is required",
    );
  });

  it("infers the skill when the target offers exactly one", async () => {
    const h = harness();
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody({ metadata: {} }),
    });
    expect(res.status).toBe(200);
    expect(h.tasks[0].skillId).toBe("develop.issue");
  });

  it("rejects a skill the target does not advertise", async () => {
    const h = harness();
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody({ metadata: { skillId: "review.pr" } }),
    });
    expect((res.body as { error: { message: string } }).error.message).toContain(
      "unknown skill",
    );
  });
});

describe("gateway tenant isolation", () => {
  it("returns 404, not 403, for an agent that belongs to another tenant", async () => {
    const h = harness({
      agents: [agent(GLOBEX.id, "dev-agent")],
    });
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody(),
    });
    // 403 would confirm the agent exists somewhere — that is the enumeration
    // we are preventing.
    expect(res.status).toBe(404);
    expect(h.sent).toHaveLength(0);
  });

  it("rejects a token whose tenant disagrees with the path", async () => {
    const h = harness({ agents: [agent(GLOBEX.id, "dev-agent")] });
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/globex/agents/dev-agent",
      bearerToken: "wf-token", // token belongs to acme
      body: sendBody(),
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown token", async () => {
    const h = harness();
    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "nope",
      body: sendBody(),
    });
    expect(res.status).toBe(401);
  });

  it("lists only the caller's own tenant in the catalog", async () => {
    const h = harness({
      agents: [agent(ACME.id, "dev-agent"), agent(GLOBEX.id, "dev-agent")],
    });
    const res = await h.handle({
      method: "GET",
      path: "/a2a/t/acme/catalog",
      bearerToken: "wf-token",
    });
    const body = res.body as { agents: Array<{ agentId: string; url: string }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].url).toBe(
      "https://fleet.example.com/a2a/t/acme/agents/dev-agent",
    );
  });
});

describe("gateway card rewriting", () => {
  it("replaces the real url, drops securitySchemes, and disables streaming", () => {
    const out = rewriteCard(card(), "https://fleet.example.com", "acme", "dev-agent");
    expect(out.url).toBe("https://fleet.example.com/a2a/t/acme/agents/dev-agent");
    expect(out.securitySchemes).toBeUndefined();
    // The gateway relays message/send only; advertising streaming would invite
    // a call it does not forward.
    expect(out.capabilities?.streaming).toBe(false);
    expect(out.capabilities?.pushNotifications).toBe(true);
  });
});

describe("gateway tasks/get", () => {
  it("returns the task to its own caller", async () => {
    const h = harness();
    await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody(),
    });

    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: { jsonrpc: "2.0", id: 9, method: "tasks/get", params: { id: "up-1" } },
    });
    expect(
      (res.body as { result: { status: { state: string } } }).result.status.state,
    ).toBe("working");
  });

  it("hides a task from an agent that did not create it", async () => {
    const h = harness({
      agents: [agent(ACME.id, "dev-agent")],
      tokens: {
        "hash:wf-token": { tenantId: ACME.id, agentId: "workflow-agent" },
        "hash:other": { tenantId: ACME.id, agentId: "dev-agent" },
      },
    });
    await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "wf-token",
      body: sendBody(),
    });

    const res = await h.handle({
      method: "POST",
      path: "/a2a/t/acme/agents/dev-agent",
      bearerToken: "other",
      body: { jsonrpc: "2.0", id: 9, method: "tasks/get", params: { id: "up-1" } },
    });
    expect((res.body as { error: { code: number } }).error.code).toBe(-32001);
  });
});

describe("a2aTaskState", () => {
  it("maps the ledger's states onto A2A's", () => {
    expect(a2aTaskState("dispatching")).toBe("submitted");
    expect(a2aTaskState("running")).toBe("working");
    expect(a2aTaskState("done_pending_notify")).toBe("completed");
    expect(a2aTaskState("done")).toBe("completed");
    expect(a2aTaskState("timed_out")).toBe("failed");
    expect(a2aTaskState("cancelled")).toBe("canceled");
  });
});
