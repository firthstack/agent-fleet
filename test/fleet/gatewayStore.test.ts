import { readdir, readFile } from "node:fs/promises";
import type { StartedTestContainer } from "testcontainers";
import { startPostgres } from "./support/postgres.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../../src/fleet/site/gatewayStore.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";

// Prefers an externally supplied Postgres (CI service container, or a local
// scratch database) and falls back to testcontainers. Point it somewhere
// disposable — every test truncates.
const EXTERNAL_URL = process.env.FLEET_TEST_DATABASE_URL?.trim();

let container: StartedTestContainer | undefined;
let store: GatewayStore;

function card(overrides: Partial<A2AAgentCard> = {}): A2AAgentCard {
  return {
    name: "Development Agent",
    description: "Implements requirements and opens pull requests.",
    version: "1.0.0",
    skills: [
      {
        id: "develop.issue",
        name: "Develop Issue",
        description: "Implement a GitHub issue.",
        inputSchema: {
          type: "object",
          required: ["requirement", "issueUrl"],
          properties: { requirement: { type: "string" }, issueUrl: { type: "string" } },
        },
      },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  let connectionString = EXTERNAL_URL;
  if (!connectionString) {
    const started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;
  }

  store = new GatewayStore({
    connectionString,
    insecureSsl: !EXTERNAL_URL,
  });
  // Replay every migration in order, so the tests exercise the same schema
  // the deployed database has.
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await store.migrate(await readFile(`migrations/${file}`, "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await store?.close();
  await container?.stop();
});

beforeEach(async () => {
  await store.truncateAll();
});

describe("GatewayStore tenancy", () => {
  it("lets two tenants each register an agent with the same id", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });

    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "Acme dev",
      endpointUrl: "https://dev.acme.example/",
      card: card(),
    });
    await store.registerAgent({
      tenantId: globex.id,
      agentId: "dev-agent",
      displayName: "Globex dev",
      endpointUrl: "https://dev.globex.example/",
      card: card(),
    });

    expect((await store.getAgent(acme.id, "dev-agent"))?.displayName).toBe("Acme dev");
    expect((await store.getAgent(globex.id, "dev-agent"))?.displayName).toBe("Globex dev");
  });

  it("does not resolve an agent across tenants", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });

    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "Acme dev",
      endpointUrl: "https://dev.acme.example/",
      card: card(),
    });

    // The gateway resolves targets only inside the caller's tenant, so from
    // globex this agent simply does not exist (docs §9).
    expect(await store.getAgent(globex.id, "dev-agent")).toBeNull();
    expect(await store.listAgents(globex.id)).toEqual([]);
  });

  it("scopes skill lookup to one tenant and returns every match", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });

    for (const agentId of ["dev-agent", "dev-agent-canary"]) {
      await store.registerAgent({
        tenantId: acme.id,
        agentId,
        displayName: agentId,
        endpointUrl: `https://${agentId}.acme.example/`,
        card: card(),
      });
    }
    await store.registerAgent({
      tenantId: globex.id,
      agentId: "dev-agent",
      displayName: "Globex dev",
      endpointUrl: "https://dev.globex.example/",
      card: card(),
    });

    const matches = await store.findAgentsBySkill(acme.id, "develop.issue");
    // Never silently pick the first: the caller chooses (docs §6.1).
    expect(matches.map((a) => a.agentId).sort()).toEqual([
      "dev-agent",
      "dev-agent-canary",
    ]);
  });

  it("rebuilds the skill index when a card changes", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "dev",
      endpointUrl: "https://dev.acme.example/",
      card: card(),
    });

    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "dev",
      endpointUrl: "https://dev.acme.example/",
      card: card({
        skills: [{ id: "develop.revise", name: "Revise", description: "Revise a PR." }],
      }),
    });

    expect(await store.findAgentsBySkill(acme.id, "develop.issue")).toEqual([]);
    expect((await store.findAgentsBySkill(acme.id, "develop.revise")).length).toBe(1);
  });

  it("captures each skill's inputSchema", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "dev",
      endpointUrl: "https://dev.acme.example/",
      card: card(),
    });

    const [agent] = await store.findAgentsBySkill(acme.id, "develop.issue");
    const skill = agent.card.skills.find((s) => s.id === "develop.issue");
    expect((skill?.inputSchema as { required?: string[] })?.required).toEqual([
      "requirement",
      "issueUrl",
    ]);
  });
});

describe("GatewayStore agent tokens", () => {
  it("resolves a token to exactly one (tenant, agent) pair", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "dev",
      endpointUrl: "https://dev.acme.example/",
      card: card(),
    });
    await store.issueAgentToken(acme.id, "dev-agent", "hash-a");

    expect(await store.resolveAgentToken("hash-a")).toEqual({
      tenantId: acme.id,
      agentId: "dev-agent",
    });
    expect(await store.resolveAgentToken("hash-unknown")).toBeNull();
  });

  it("stops resolving a revoked token", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    await store.registerAgent({
      tenantId: acme.id,
      agentId: "dev-agent",
      displayName: "dev",
      endpointUrl: "https://dev.acme.example/",
      card: card(),
    });
    await store.issueAgentToken(acme.id, "dev-agent", "hash-a");
    await store.revokeAgentToken("hash-a");

    expect(await store.resolveAgentToken("hash-a")).toBeNull();
  });
});

describe("GatewayStore task mapping", () => {
  async function seed() {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    for (const agentId of ["workflow-agent", "dev-agent"]) {
      await store.registerAgent({
        tenantId: acme.id,
        agentId,
        displayName: agentId,
        endpointUrl: `https://${agentId}.acme.example/`,
        card: card(),
      });
    }
    return acme;
  }

  it("maps an upstream task to its downstream task and back via the callback token", async () => {
    const acme = await seed();

    const task = await store.createTask({
      tenantId: acme.id,
      upstreamTaskId: "up-1",
      callerAgentId: "workflow-agent",
      callerCallbackUrl: "https://workflow.acme.example/hooks/a2a",
      callerCallbackAuth: { schemes: ["bearer"] },
      targetAgentId: "dev-agent",
      skillId: "develop.issue",
      deadlineAt: new Date(Date.now() + 3_600_000),
    });
    expect(task.state).toBe("dispatching");

    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-1",
      callbackTokenHash: "cb-hash",
    });

    const resolved = await store.resolveCallbackToken("cb-hash");
    expect(resolved).not.toBeNull();
    expect(resolved?.tenantId).toBe(acme.id);
    expect(resolved?.upstreamTaskId).toBe("up-1");
    expect(resolved?.callerCallbackUrl).toBe("https://workflow.acme.example/hooks/a2a");
    expect(resolved?.state).toBe("running");
  });

  it("retires the callback token once the task is terminal", async () => {
    const acme = await seed();
    const task = await store.createTask({
      tenantId: acme.id,
      upstreamTaskId: "up-1",
      callerAgentId: "workflow-agent",
      targetAgentId: "dev-agent",
      skillId: "develop.issue",
      deadlineAt: new Date(Date.now() + 3_600_000),
    });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-1",
      callbackTokenHash: "cb-hash",
    });

    await store.recordDownstreamResult(task.id, { ok: true, prUrl: "https://pr" });
    expect((await store.getTask(task.id))?.state).toBe("done_pending_notify");

    await store.markNotified(task.id);
    expect((await store.getTask(task.id))?.state).toBe("done");

    // A replayed callback must not reopen a finished task (docs §4 攻击面).
    expect(await store.resolveCallbackToken("cb-hash")).toBeNull();
  });

  it("keeps upstream task ids unique per tenant but allows reuse across tenants", async () => {
    const acme = await seed();
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });
    for (const agentId of ["workflow-agent", "dev-agent"]) {
      await store.registerAgent({
        tenantId: globex.id,
        agentId,
        displayName: agentId,
        endpointUrl: `https://${agentId}.globex.example/`,
        card: card(),
      });
    }

    const args = {
      upstreamTaskId: "up-1",
      callerAgentId: "workflow-agent",
      targetAgentId: "dev-agent",
      skillId: "develop.issue",
      deadlineAt: new Date(Date.now() + 3_600_000),
    };
    await store.createTask({ tenantId: acme.id, ...args });
    await expect(
      store.createTask({ tenantId: acme.id, ...args }),
    ).rejects.toThrow();
    await expect(
      store.createTask({ tenantId: globex.id, ...args }),
    ).resolves.toBeTruthy();
  });
});

describe("row level security", () => {
  it("blocks a cross-tenant read even when the query forgets its tenant filter", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });

    for (const [tenantId, agentId] of [
      [acme.id, "acme-dev"],
      [globex.id, "globex-dev"],
    ] as const) {
      await store.registerAgent({
        tenantId,
        agentId,
        displayName: agentId,
        endpointUrl: `https://${agentId}.example/`,
        card: card(),
      });
    }

    // Deliberately unscoped — this is the mistake the first five layers of
    // defence are supposed to prevent, and the one RLS exists to survive.
    const leaked = await store.withTenant(acme.id, async (client) => {
      const { rows } = await client.query<{ agent_id: string }>(
        "SELECT agent_id FROM fleet_agents ORDER BY agent_id",
      );
      return rows.map((r) => r.agent_id);
    });

    expect(leaked).toEqual(["acme-dev"]);
    expect(leaked).not.toContain("globex-dev");
  });

  it("returns nothing rather than everything when the tenant is unset", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    await store.registerAgent({
      tenantId: acme.id,
      agentId: "acme-dev",
      displayName: "acme-dev",
      endpointUrl: "https://acme-dev.example/",
      card: card(),
    });

    // Forgetting to set the tenant must fail closed, not open.
    const rows = await store.withTenant(acme.id, async (client) => {
      await client.query("SELECT set_config('app.tenant_id', NULL, true)");
      const out = await client.query("SELECT agent_id FROM fleet_agents");
      return out.rows;
    });
    expect(rows).toEqual([]);
  });

  it("still lets the owner role sweep across tenants for the background workers", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });
    for (const [tenantId, agentId] of [
      [acme.id, "a"],
      [globex.id, "b"],
    ] as const) {
      await store.registerAgent({
        tenantId,
        agentId,
        displayName: agentId,
        endpointUrl: `https://${agentId}.example/`,
        card: card(),
      });
    }

    // The notifier and sweeper scan every tenant by design (docs §8), so the
    // owner role deliberately keeps its bypass.
    expect((await store.listAllAgentIdsUnscoped()).sort()).toEqual(["a", "b"]);
  });

  it("returns full agent records across tenants for the health-check sweep", async () => {
    const acme = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
    const globex = await store.ensureTenant({ slug: "globex", displayName: "Globex" });
    for (const [tenantId, agentId] of [
      [acme.id, "a"],
      [globex.id, "b"],
    ] as const) {
      await store.registerAgent({
        tenantId,
        agentId,
        displayName: agentId,
        endpointUrl: `https://${agentId}.example/`,
        card: card(),
      });
    }

    const all = await store.listAllAgentsUnscoped();
    expect(all.map((a) => a.agentId).sort()).toEqual(["a", "b"]);
    const acmeAgent = all.find((a) => a.agentId === "a");
    expect(acmeAgent?.tenantId).toBe(acme.id);
    expect(acmeAgent?.endpointUrl).toBe("https://a.example/");
  });
});
