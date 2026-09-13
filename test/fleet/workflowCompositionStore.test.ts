import { readdir, readFile } from "node:fs/promises";
import type { StartedTestContainer } from "testcontainers";
import { startPostgres } from "./support/postgres.js";
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
    const started = await startPostgres();
    container = started.container;
    connectionString = started.connectionString;
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

describe("每租户的并发名额", () => {
  /** 一个已获名额、仍在跑的 run —— 占着一个名额。 */
  async function liveRun(sourceRef: string) {
    const run = await makeRun(sourceRef);
    expect(await workflows.admitRun(tenantId, run.id, 99)).toBe(true);
    await workflows.updateRun(run.id, {
      state: "a",
      status: "a",
      vars: {},
    });
    return run;
  }

  it("名额没满就放行，满了就不放", async () => {
    const first = await makeRun("cap-1");
    expect(await workflows.admitRun(tenantId, first.id, 1)).toBe(true);
    await workflows.updateRun(first.id, { state: "a", status: "a", vars: {} });

    const second = await makeRun("cap-2");
    expect(await workflows.admitRun(tenantId, second.id, 1)).toBe(false);
    // 被挡住的 run 依然在库里，只是没有 admitted_at。
    expect((await workflows.getRun(tenantId, second.id))?.admittedAt).toBeNull();
  });

  it("跑完的 run 不再占名额", async () => {
    const first = await makeRun("done-1");
    await workflows.admitRun(tenantId, first.id, 1);
    await workflows.updateRun(first.id, {
      state: "completed",
      status: "completed",
      vars: {},
    });

    const second = await makeRun("done-2");
    expect(await workflows.admitRun(tenantId, second.id, 1)).toBe(true);
  });

  it("并发调用不会双双读到同一个空位", async () => {
    // 计数与写入在同一个事务里、由租户维度的 advisory lock 串起来。少了它，
    // 两个网关会同时读到 "0 个在跑" 然后双双放行。
    await makeRun("race-live");
    const a = await makeRun("race-a");
    const b = await makeRun("race-b");

    const [ra, rb] = await Promise.all([
      workflows.admitRun(tenantId, a.id, 1),
      workflows.admitRun(tenantId, b.id, 1),
    ]);

    expect([ra, rb].filter(Boolean)).toHaveLength(1);
  });

  it("一个租户的用量不影响另一个", async () => {
    const other = await store.ensureTenant({ slug: "other-tenant", displayName: "Other" });
    const mine = await makeRun("iso-1");
    await workflows.admitRun(tenantId, mine.id, 1);
    await workflows.updateRun(mine.id, { state: "a", status: "a", vars: {} });

    const def = await workflows.putDefinition({
      tenantId: other.id,
      name: "demo",
      version: 1,
      definition,
    });
    const theirs = await workflows.createRun({
      tenantId: other.id,
      workflowId: def.id,
      state: "queued",
      status: "queued",
      vars: {},
      sourceType: "a2a",
      sourceRef: "iso-other",
      createdBy: "someone",
    });
    expect(await workflows.admitRun(other.id, theirs.id, 1)).toBe(true);
  });

  it("按提交顺序发名额", async () => {
    await liveRun("order-live");
    const b = await makeRun("order-b");
    const c = await makeRun("order-c");

    // 名额上限 2：在跑 1 个，所以只放得下 1 个。
    const claimed = await workflows.claimRunsToStart(2, 10);

    expect(claimed.map((r) => r.id)).toEqual([b.id]);
    expect((await workflows.getRun(tenantId, c.id))?.admittedAt).toBeNull();
  });

  it("名额满了就一个也不放", async () => {
    await liveRun("full-live");
    await makeRun("full-waiting");
    expect(await workflows.claimRunsToStart(1, 10)).toEqual([]);
  });

  it("把已拿名额却没派发出去的 run 也一并认领回来", async () => {
    // 崩溃窗口：admitted_at 先写、派发后做，进程死在中间就留下一个占着名额
    // 但没人驱动的 run。认领它是让"入场"真正可靠、而不只是乐观的关键。
    const stalled = await makeRun("stalled-1");
    await workflows.admitRun(tenantId, stalled.id, 99);

    const claimed = await workflows.claimRunsToStart(99, 10);

    expect(claimed.map((r) => r.id)).toContain(stalled.id);
  });

  it("把启动时的 payload 原样带回来", async () => {
    // 排队的 run 要算出与立即启动**完全相同**的起始决策，而 vars 存的是走完
    // start 转移之后的值，拿它重算会把转移里的 set 应用第二次。
    const def = await workflows.putDefinition({
      tenantId,
      name: "demo",
      version: 1,
      definition,
    });
    const run = await workflows.createRun({
      tenantId,
      workflowId: def.id,
      state: "queued",
      status: "queued",
      vars: { after: "transitions" },
      sourceType: "a2a",
      sourceRef: "payload-1",
      createdBy: "junwen",
      inputPayload: { requirement: "原始输入" },
    });

    const claimed = await workflows.claimRunsToStart(99, 10);
    const mine = claimed.find((r) => r.id === run.id);
    expect(mine?.inputPayload).toEqual({ requirement: "原始输入" });
  });

  it("认领数量不超过给定的批量", async () => {
    for (const ref of ["batch-a", "batch-b", "batch-c"]) await makeRun(ref);
    expect(await workflows.claimRunsToStart(99, 2)).toHaveLength(2);
  });
});
