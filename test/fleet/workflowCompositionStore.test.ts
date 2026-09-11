import { readdir, readFile } from "node:fs/promises";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GatewayStore } from "../../src/fleet/site/gatewayStore.js";
import type { WorkflowStore } from "../../src/fleet/workflow/workflowStore.js";
import type { WorkflowDefinition } from "../../src/fleet/workflow/engine.js";
import type { A2AAgentCard } from "../../src/fleet/protocol/a2a.js";

const EXTERNAL_URL = process.env.FLEET_TEST_DATABASE_URL?.trim();

let container: StartedTestContainer | undefined;
let store: GatewayStore;
let workflows: WorkflowStore;
let tenantId = 0;

const definition = {
  workflow: "demo",
  version: 1,
  start: [{ goto: "a" }],
  states: { a: { call: { skill: "s.one" }, next: [{ goto: "completed" }] } },
} as WorkflowDefinition;

function card(): A2AAgentCard {
  return {
    name: "Agent",
    description: "d",
    version: "1.0.0",
    skills: [{ id: "s.one", name: "One", description: "One." }],
  };
}

beforeAll(async () => {
  let connectionString = EXTERNAL_URL;
  if (!connectionString) {
    container = await new GenericContainer("postgres:16")
      .withEnvironment({
        POSTGRES_USER: "admin",
        POSTGRES_PASSWORD: "admin",
        POSTGRES_DB: "fleet_test",
      })
      .withExposedPorts(5432)
      .start();
    connectionString = `postgres://admin:admin@${container.getHost()}:${container.getMappedPort(
      5432,
    )}/fleet_test?sslmode=disable`;
  }

  store = new GatewayStore({ connectionString, insecureSsl: !EXTERNAL_URL });
  for (const file of (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await store.migrate(await readFile(`migrations/${file}`, "utf8"));
  }
  workflows = store.workflows();
}, 120_000);

afterAll(async () => {
  await store?.close();
  await container?.stop();
});

beforeEach(async () => {
  await store.truncateAll();
  await store.migrate("TRUNCATE fleet_workflows, fleet_workflow_runs, fleet_workflow_run_events RESTART IDENTITY CASCADE");
  const tenant = await store.ensureTenant({ slug: "acme", displayName: "Acme" });
  tenantId = tenant.id;
  await store.registerAgent({
    tenantId,
    agentId: "worker",
    displayName: "worker",
    endpointUrl: "https://worker.example/",
    card: card(),
  });
});

async function makeRun(sourceRef = "ref-1") {
  const def = await workflows.putDefinition({
    tenantId,
    name: "demo",
    version: 1,
    definition,
  });
  return workflows.createRun({
    tenantId,
    workflowId: def.id,
    state: "queued",
    status: "queued",
    vars: { a: 1 },
    sourceType: "a2a",
    sourceRef,
    createdBy: "junwen",
  });
}

async function makeTask(opts: {
  workflowRunId?: number | null;
  fromState?: string | null;
  callbackUrl?: string | null;
  upstreamTaskId?: string;
}) {
  return store.createTask({
    tenantId,
    upstreamTaskId: opts.upstreamTaskId ?? `up-${Math.random()}`,
    callerAgentId: "caller",
    callerCallbackUrl: opts.callbackUrl ?? null,
    targetAgentId: "worker",
    skillId: "s.one",
    deadlineAt: new Date(Date.now() + 3_600_000),
    workflowRunId: opts.workflowRunId ?? null,
    workflowFromState: opts.fromState ?? null,
  });
}

describe("definitions", () => {
  it("returns the latest version unless one is named", async () => {
    await workflows.putDefinition({ tenantId, name: "demo", version: 1, definition });
    const v2 = await workflows.putDefinition({
      tenantId,
      name: "demo",
      version: 2,
      definition: { ...definition, version: 2 },
    });

    expect((await workflows.findDefinition(tenantId, "demo"))?.id).toBe(v2.id);
    expect((await workflows.findDefinition(tenantId, "demo", 1))?.definition.version).toBe(1);
    expect(await workflows.findDefinition(tenantId, "nope")).toBeNull();
  });

  it("does not leak definitions across tenants", async () => {
    const other = await store.ensureTenant({ slug: "globex", displayName: "Globex" });
    await workflows.putDefinition({ tenantId, name: "demo", version: 1, definition });
    expect(await workflows.findDefinition(other.id, "demo")).toBeNull();
  });
});

describe("runs", () => {
  it("refuses a second run for the same source, which is how replay is stopped", async () => {
    await makeRun("ref-same");
    await expect(makeRun("ref-same")).rejects.toThrow();
    expect((await workflows.getRunBySource(tenantId, "a2a", "ref-same"))).not.toBeNull();
  });

  it("leaves awaitingTaskId alone when the patch omits it", async () => {
    const run = await makeRun();
    await workflows.updateRun(run.id, {
      state: "a",
      status: "a",
      vars: {},
      awaitingTaskId: 77,
    });
    // A dispatch that fails writes the state but must not clear the task the
    // run is still waiting on — otherwise the retry looks stale and is
    // silently dropped.
    await workflows.updateRun(run.id, { state: "a", status: "a", vars: {} });
    expect((await workflows.getRun(tenantId, run.id))?.awaitingTaskId).toBe(77);

    await workflows.updateRun(run.id, {
      state: "a",
      status: "a",
      vars: {},
      awaitingTaskId: null,
    });
    expect((await workflows.getRun(tenantId, run.id))?.awaitingTaskId).toBeNull();
  });

  it("keeps run events in order for the run viewer", async () => {
    const run = await makeRun();
    for (const eventType of ["created", "developing", "pr_opened"]) {
      await workflows.appendRunEvent({ tenantId, runId: run.id, eventType, payload: {} });
    }
    expect(
      (await workflows.listRunEvents(tenantId, run.id)).map((e) => e.eventType),
    ).toEqual(["created", "developing", "pr_opened"]);
  });
});

describe("the two claim queues are disjoint", () => {
  it("gives a workflow-owned step to the driver and not to the notifier", async () => {
    const run = await makeRun();
    const task = await makeTask({
      workflowRunId: run.id,
      fromState: "a",
      // Even with a callback URL present, a workflow step belongs to the
      // driver; handling it twice would advance the run and POST a webhook.
      callbackUrl: "https://caller.example/hook",
    });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-1",
      callbackTokenHash: `h-${task.id}`,
    });
    await store.recordDownstreamResult(task.id, { ok: true });

    expect((await store.claimDueNotifications(new Date(), 10)).map((t) => t.id)).toEqual([]);

    const claimed = await workflows.claimWorkflowAdvances(new Date(), 10);
    expect(claimed.map((t) => t.id)).toEqual([task.id]);
    expect(claimed[0].fromState).toBe("a");
    expect(claimed[0].workflowRunId).toBe(run.id);
  });

  it("gives an ordinary caller notification to the notifier and not to the driver", async () => {
    const task = await makeTask({ callbackUrl: "https://caller.example/hook" });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-2",
      callbackTokenHash: `h-${task.id}`,
    });
    await store.recordDownstreamResult(task.id, { ok: true });

    expect(await workflows.claimWorkflowAdvances(new Date(), 10)).toEqual([]);
    expect((await store.claimDueNotifications(new Date(), 10)).map((t) => t.id)).toEqual([
      task.id,
    ]);
  });

  it("stops reclaiming a step once it is marked handled", async () => {
    const run = await makeRun();
    const task = await makeTask({ workflowRunId: run.id, fromState: "a" });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-3",
      callbackTokenHash: `h-${task.id}`,
    });
    await store.recordDownstreamResult(task.id, { ok: true });

    expect(await workflows.claimWorkflowAdvances(new Date(), 10)).toHaveLength(1);
    await workflows.markNotified(task.id);
    expect(await workflows.claimWorkflowAdvances(new Date(), 10)).toEqual([]);
  });

  it("holds a step back until its retry time", async () => {
    const run = await makeRun();
    const task = await makeTask({ workflowRunId: run.id, fromState: "a" });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-4",
      callbackTokenHash: `h-${task.id}`,
    });
    await store.recordDownstreamResult(task.id, { ok: true });
    await workflows.recordNotifyFailure(task.id, new Date(Date.now() + 60_000));

    expect(await workflows.claimWorkflowAdvances(new Date(), 10)).toEqual([]);
    expect(
      await workflows.claimWorkflowAdvances(new Date(Date.now() + 120_000), 10),
    ).toHaveLength(1);
  });

  it("counts attempts so the driver can give up", async () => {
    const run = await makeRun();
    const task = await makeTask({ workflowRunId: run.id, fromState: "a" });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-5",
      callbackTokenHash: `h-${task.id}`,
    });
    await store.recordDownstreamResult(task.id, { ok: true });

    expect((await workflows.claimWorkflowAdvances(new Date(), 10))[0].attempt).toBe(1);
    expect((await workflows.claimWorkflowAdvances(new Date(), 10))[0].attempt).toBe(2);
  });

  it("also claims a step that timed out, so the run is not stranded", async () => {
    const run = await makeRun();
    const task = await makeTask({ workflowRunId: run.id, fromState: "a" });
    await store.attachDownstream(task.id, {
      downstreamTaskId: "down-6",
      callbackTokenHash: `h-${task.id}`,
    });
    await store.claimExpired(new Date(Date.now() + 7_200_000), 10);

    const claimed = await workflows.claimWorkflowAdvances(new Date(), 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].state).toBe("timed_out");
  });
});

describe("row level security covers the new tables", () => {
  it("hides another tenant's runs even without a tenant filter", async () => {
    const other = await store.ensureTenant({ slug: "globex", displayName: "Globex" });
    await makeRun("ref-acme");
    const otherDef = await workflows.putDefinition({
      tenantId: other.id,
      name: "demo",
      version: 1,
      definition,
    });
    await workflows.createRun({
      tenantId: other.id,
      workflowId: otherDef.id,
      state: "queued",
      status: "queued",
      vars: {},
      sourceType: "a2a",
      sourceRef: "ref-globex",
      createdBy: "someone",
    });

    const visible = await store.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ source_ref: string }>(
        "SELECT source_ref FROM fleet_workflow_runs",
      );
      return rows.map((r) => r.source_ref);
    });
    expect(visible).toEqual(["ref-acme"]);
  });
});
