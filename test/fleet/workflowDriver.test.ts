import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WorkflowDispatchError,
  WorkflowDriverError,
  WorkflowRunFailed,
  createWorkflowDriver,
  stepResult,
  type WorkflowDriverStore,
  type WorkflowRunRecord,
  type WorkflowTaskRecord,
} from "../../src/fleet/workflow/driver.js";
import type { WorkflowDefinition } from "../../src/fleet/workflow/engine.js";

/**
 * End-to-end drive of the real develop → review → merge definition: the
 * driver dispatches a step, an agent "answers", the completed task goes back
 * through the same claim queue an ordinary notification uses, and the state
 * machine moves on. No database and no network — the whole composition layer
 * is deterministic.
 */
const definition = JSON.parse(
  readFileSync("workflows/develop-review-merge.json", "utf8"),
) as WorkflowDefinition;

const TENANT = 1;
const PR = "https://github.com/o/r/pull/7";
const PR2 = "https://github.com/o/r/pull/8";

interface Dispatched {
  taskId: number;
  skillId: string;
  payload: Record<string, unknown>;
  deadlineAt: Date;
  workflowRunId: number;
}

function harness(
  opts: {
    dispatchFails?: number;
    failFrom?: number;
    /** Injected failures carry this code instead of being a generic error. */
    dispatchCode?: "no_agent" | "ambiguous_agent" | "dispatch_failed";
  } = {},
) {
  const runs = new Map<number, WorkflowRunRecord>();
  const tasks = new Map<number, WorkflowTaskRecord>();
  const events: Array<{ runId: number; eventType: string }> = [];
  const dispatched: Dispatched[] = [];
  const notified: number[] = [];
  const retries: Array<{ taskId: number; at: Date }> = [];
  const abandoned: number[] = [];
  let nextRunId = 1;
  let nextTaskId = 100;
  let dispatchFailuresLeft = opts.dispatchFails ?? 0;
  // Dispatch number at which injected failures begin, so a test can let the
  // opening step succeed and break a later one.
  const failFrom = opts.failFrom ?? 0;
  let dispatchCount = 0;
  let clock = new Date("2026-09-11T00:00:00.000Z");

  const store: WorkflowDriverStore = {
    async getDefinition(_tenantId, workflowId) {
      return workflowId === 7 ? { id: 7, definition } : null;
    },
    async findDefinition(_tenantId, name) {
      return name === "develop-review-merge" ? { id: 7, definition } : null;
    },
    async getRun(_tenantId, runId) {
      return runs.get(runId) ?? null;
    },
    async getRunBySource(tenantId, sourceType, sourceRef) {
      return (
        [...runs.values()].find(
          (r) =>
            r.tenantId === tenantId &&
            r.sourceType === sourceType &&
            r.sourceRef === sourceRef,
        ) ?? null
      );
    },
    async createRun(input) {
      const run: WorkflowRunRecord = {
        id: nextRunId++,
        tenantId: input.tenantId,
        workflowId: input.workflowId,
        state: input.state,
        status: input.status,
        reason: null,
        vars: input.vars,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        awaitingTaskId: null,
      };
      runs.set(run.id, run);
      return run;
    },
    async updateRun(runId, patch) {
      const run = runs.get(runId);
      if (!run) throw new Error(`no run ${runId}`);
      runs.set(runId, {
        ...run,
        ...patch,
        reason: patch.reason ?? null,
        // Omitting the field means "leave it", not "clear it" — that
        // distinction is what keeps a failed dispatch retryable.
        awaitingTaskId:
          patch.awaitingTaskId === undefined ? run.awaitingTaskId : patch.awaitingTaskId,
      });
    },
    async appendRunEvent(input) {
      events.push({ runId: input.runId, eventType: input.eventType });
    },
    async claimWorkflowAdvances() {
      const due = [...tasks.values()].filter(
        (t) =>
          t.workflowRunId !== null &&
          ["done_pending_notify", "timed_out", "failed"].includes(t.state) &&
          !notified.includes(t.id) &&
          !abandoned.includes(t.id),
      );
      for (const task of due) task.attempt += 1;
      return due;
    },
    async markNotified(taskId) {
      notified.push(taskId);
    },
    async recordNotifyFailure(taskId, at) {
      retries.push({ taskId, at });
    },
    async abandonNotification(taskId) {
      abandoned.push(taskId);
    },
  };

  const driver = createWorkflowDriver({
    store,
    now: () => clock,
    maxAdvanceAttempts: 2,
    dispatcher: {
      async dispatch(input) {
        dispatchCount += 1;
        if (dispatchFailuresLeft > 0 && dispatchCount > failFrom) {
          dispatchFailuresLeft -= 1;
          const message = `no agent in this tenant offers ${input.skillId}`;
          throw opts.dispatchCode
            ? new WorkflowDispatchError(message, opts.dispatchCode)
            : new Error(message);
        }
        const taskId = nextTaskId++;
        dispatched.push({ taskId, ...input });
        tasks.set(taskId, {
          id: taskId,
          tenantId: input.tenantId,
          workflowRunId: input.workflowRunId,
          fromState: input.fromState,
          state: "running",
          result: null,
          attempt: 0,
        });
        return { taskId };
      },
    },
  });

  /** An agent finishes the most recent step, then the driver picks it up. */
  async function agentReplies(result: unknown, state = "done_pending_notify") {
    const last = dispatched[dispatched.length - 1];
    const task = tasks.get(last.taskId)!;
    task.state = state;
    task.result = state === "timed_out" ? null : { state: "completed", result };
    return driver.runOnce();
  }

  return {
    driver,
    runs,
    tasks,
    events,
    dispatched,
    notified,
    retries,
    abandoned,
    agentReplies,
    last: () => dispatched[dispatched.length - 1],
    advanceClock: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

async function startFeature(h: ReturnType<typeof harness>, sourceRef = "task-1") {
  return h.driver.start({
    tenantId: TENANT,
    workflowName: "develop-review-merge",
    payload: { requirement: "Add fleet composition" },
    createdBy: "junwen",
    sourceType: "a2a",
    sourceRef,
  });
}

describe("driving the real workflow end to end", () => {
  it("runs develop → review → merge to completion", async () => {
    const h = harness();
    const { run } = await startFeature(h);

    // ① the first step is dispatched as soon as the run is created
    expect(h.last().skillId).toBe("develop.issue");
    expect(h.runs.get(run.id)?.status).toBe("developing");

    // ② development reports a PR → the engine walks pr_opened and asks for review
    await h.agentReplies({ ok: true, prUrl: PR });
    expect(h.last().skillId).toBe("review.pr");
    expect(h.last().payload.prUrl).toBe(PR);
    expect(h.runs.get(run.id)?.status).toBe("reviewing");

    // ③ review approves → merge is requested
    await h.agentReplies({ ok: true, verdict: "approved", reviewUrl: "https://r/1" });
    expect(h.last().skillId).toBe("pr.merge");
    expect(h.runs.get(run.id)?.status).toBe("merge_requested");

    // ④ merge request posted → the run finishes
    await h.agentReplies({ ok: true, slackMessageTs: "1.2" });
    expect(h.runs.get(run.id)).toMatchObject({
      state: "completed",
      status: "completed",
    });

    expect(h.dispatched.map((d) => d.skillId)).toEqual([
      "develop.issue",
      "review.pr",
      "pr.merge",
    ]);
    // Every step was marked handled, so nothing is reclaimed on the next pass.
    expect(h.notified).toHaveLength(3);
    expect(await h.driver.runOnce()).toEqual({ advanced: 0, retried: 0, abandoned: 0, failed: 0 });
  });

  it("loops through revision and comes back to review with the new PR", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });

    const findings = [{ title: "Missing auth", detail: "Endpoint is public" }];
    await h.agentReplies({ ok: true, verdict: "request_changes", findings });

    expect(h.last().skillId).toBe("develop.revise");
    expect(h.last().payload).toMatchObject({
      priorPrUrl: PR,
      iteration: 1,
      reviewFindings: findings,
    });
    expect(h.runs.get(run.id)?.status).toBe("revising");

    await h.agentReplies({ ok: true, prUrl: PR2 });
    expect(h.last().skillId).toBe("review.pr");
    expect(h.last().payload).toMatchObject({ prUrl: PR2, iteration: 1 });

    await h.agentReplies({ ok: true, verdict: "approved" });
    await h.agentReplies({ ok: true });
    expect(h.runs.get(run.id)?.state).toBe("completed");
  });

  it("escalates to a human once the iteration budget is spent", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });

    for (let i = 0; i < 20; i += 1) {
      if (h.runs.get(run.id)?.state === "needs_human") break;
      await h.agentReplies({ ok: true, verdict: "request_changes", findings: [] });
      if (h.runs.get(run.id)?.state === "needs_human") break;
      await h.agentReplies({ ok: true, prUrl: PR2 });
    }

    expect(h.runs.get(run.id)).toMatchObject({
      state: "needs_human",
      reason: "max_iterations_exceeded",
    });
    // It stopped dispatching once it escalated.
    const before = h.dispatched.length;
    await h.driver.runOnce();
    expect(h.dispatched).toHaveLength(before);
  });

  it("records the state before dispatching, so a stuck step is visible", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });
    await h.agentReplies({ ok: true, verdict: "approved" });

    // Nobody has answered pr.merge yet. If the status were only written after
    // the reply, an observer would still see "approved" and could not tell
    // that we are waiting on Slack.
    expect(h.runs.get(run.id)?.status).toBe("merge_requested");
    // pr_opened dispatches nothing, but it is a real milestone — the PR
    // exists — so it must still appear in the run's history.
    expect(h.events.map((e) => e.eventType)).toEqual([
      "created",
      "developing",
      "pr_opened",
      "reviewing",
      "requesting_merge",
    ]);
  });
});

describe("failure handling", () => {
  it("fails the run when development never opens a PR", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: false, error: "could not push" });
    expect(h.runs.get(run.id)).toMatchObject({
      state: "failed",
      reason: "develop_failed",
    });
  });

  it("treats a timed-out step as an ordinary failure, with no special casing", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    // The gateway's sweeper marked the task timed_out; the definition's own
    // failure branch should handle it.
    await h.agentReplies(null, "timed_out");
    expect(h.runs.get(run.id)).toMatchObject({
      state: "failed",
      reason: "develop_failed",
    });
  });

  it("escalates a review that only left comments", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });
    await h.agentReplies({ ok: true, verdict: "comment", summary: "thoughts" });
    expect(h.runs.get(run.id)).toMatchObject({
      state: "needs_human",
      reason: "review_comment",
    });
  });
});

describe("the claim queue is shared with notifications", () => {
  it("retries an advance that threw, then gives up within budget", async () => {
    // The second dispatch (review.pr) fails twice: once to trigger a retry,
    // once more to exhaust the budget of 2.
    const h = harness({ dispatchFails: 2, failFrom: 1 });
    await startFeature(h); // develop.issue goes out fine; review.pr is the one that breaks

    const first = await h.agentReplies({ ok: true, prUrl: PR });
    expect(first).toMatchObject({ advanced: 0, retried: 1 });
    expect(h.retries).toHaveLength(1);

    const second = await h.driver.runOnce();
    expect(second).toMatchObject({ advanced: 0, abandoned: 1 });
    expect(h.abandoned).toHaveLength(1);
  });

  it("backs off further on each retry", async () => {
    const h = harness({ dispatchFails: 1, failFrom: 1 });
    await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });
    // attempt 1 → 30s
    expect(h.retries[0].at.getTime() - Date.parse("2026-09-11T00:00:00.000Z")).toBe(
      30_000,
    );
  });
});

describe("replayed completions", () => {
  it("ignores a step completion the run has already moved past", async () => {
    const h = harness();
    await startFeature(h);
    const developTask = h.last().taskId;

    await h.agentReplies({ ok: true, prUrl: PR });
    expect(h.last().skillId).toBe("review.pr");
    const afterFirst = h.dispatched.length;

    // The gateway is at-least-once: the same completion can arrive twice.
    // Advancing again would dispatch a second review for the same PR.
    const task = h.tasks.get(developTask)!;
    task.state = "done_pending_notify";
    await h.driver.advanceForTask(task);
    expect(h.dispatched).toHaveLength(afterFirst);
  });
});

describe("deduplication", () => {
  it("returns the existing run instead of starting a second one", async () => {
    const h = harness();
    const first = await startFeature(h, "task-same");
    const second = await startFeature(h, "task-same");

    expect(second.deduplicated).toBe(true);
    expect(second.run.id).toBe(first.run.id);
    // Crucially, no second develop.issue — that would open two PRs.
    expect(h.dispatched).toHaveLength(1);
    expect(h.events.filter((e) => e.eventType === "deduplicated")).toHaveLength(1);
  });

  it("starts a separate run for a different source ref", async () => {
    const h = harness();
    await startFeature(h, "task-a");
    const second = await startFeature(h, "task-b");
    expect(second.deduplicated).toBe(false);
    expect(h.dispatched).toHaveLength(2);
  });

  it("refuses an unknown workflow name", async () => {
    const h = harness();
    await expect(
      h.driver.start({
        tenantId: TENANT,
        workflowName: "nope",
        payload: { requirement: "x" },
        createdBy: "junwen",
        sourceType: "a2a",
        sourceRef: "r",
      }),
    ).rejects.toThrow(WorkflowDriverError);
  });
});

describe("resume", () => {
  it("picks an interrupted review back up", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });
    const before = h.dispatched.length;

    // Simulate the driver dying mid-review: the row is all that survives,
    // which is the point of having no in-memory saga.
    const resumed = await h.driver.resume(TENANT, run.id);
    expect(resumed?.status).toBe("reviewing");
    expect(h.dispatched).toHaveLength(before + 1);
    expect(h.last().skillId).toBe("review.pr");
  });

  it("reports a finished run as not resumable", async () => {
    const h = harness();
    const { run } = await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: PR });
    await h.agentReplies({ ok: true, verdict: "approved" });
    await h.agentReplies({ ok: true });

    expect(await h.driver.resume(TENANT, run.id)).toBeNull();
  });
});

describe("stepResult", () => {
  const base: WorkflowTaskRecord = {
    id: 1,
    tenantId: 1,
    workflowRunId: 1,
    fromState: "developing",
    state: "done_pending_notify",
    result: null,
    attempt: 0,
  };

  it("unwraps a completed callback", () => {
    expect(
      stepResult({ ...base, result: { state: "completed", result: { ok: true } } }),
    ).toEqual({ ok: true });
  });

  it("turns a timeout into a plain failure the definition can branch on", () => {
    expect(stepResult({ ...base, state: "timed_out" })).toMatchObject({ ok: false });
  });

  it("turns a failed downstream into a plain failure", () => {
    expect(
      stepResult({ ...base, result: { state: "failed", error: "Codex crashed" } }),
    ).toEqual({ ok: false, error: "Codex crashed" });
  });

  it("does not pretend an empty result succeeded", () => {
    expect(stepResult(base)).toMatchObject({ ok: false });
  });
});

describe("a step that can never be dispatched", () => {
  /**
   * The bug this replaces: the run row is written *before* the dispatch, so a
   * failure left the run one state ahead with no task behind it. Retrying
   * rewrote that same state until the attempt cap, then gave up — and because
   * the deadline sweep only looks at `fleet_tasks`, and no task row was ever
   * created, nothing afterwards could move the run again. It sat in a
   * live-looking state forever.
   */

  it("ends the run instead of retrying, and says which skill had nowhere to go", async () => {
    const h = harness({ dispatchFails: 1, dispatchCode: "no_agent" });

    await expect(startFeature(h)).rejects.toBeInstanceOf(WorkflowRunFailed);

    const run = [...h.runs.values()][0];
    expect(run.state).toBe("failed");
    expect(run.status).toBe("failed");
    // The skill is the actionable part: it names the agent to connect.
    expect(run.reason).toContain("develop.issue");
    expect(h.events.filter((e) => e.eventType === "failed")).toHaveLength(1);
  });

  it("carries the run id, because that run is in the list needing an explanation", async () => {
    const h = harness({ dispatchFails: 1, dispatchCode: "no_agent" });
    const err = await startFeature(h).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowRunFailed);
    expect((err as WorkflowRunFailed).runId).toBe([...h.runs.values()][0].id);
    expect((err as WorkflowRunFailed).code).toBe("no_agent");
  });

  it("fails a run that breaks mid-flight, not only one that breaks at the start", async () => {
    // The shape of the real incident: develop and review succeed, then the
    // merge step names a skill nothing offers.
    const h = harness({ dispatchFails: 1, failFrom: 1, dispatchCode: "no_agent" });
    await startFeature(h);

    const result = await h.agentReplies({ ok: true, prUrl: "https://pr/1" });

    const run = [...h.runs.values()][0];
    expect(run.state).toBe("failed");
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);
    expect(result.abandoned).toBe(0);
  });

  it("takes the driving step out of the queue rather than letting it retry", async () => {
    const h = harness({ dispatchFails: 1, failFrom: 1, dispatchCode: "no_agent" });
    await startFeature(h);
    const task = h.last().taskId;

    await h.agentReplies({ ok: true, prUrl: "https://pr/1" });

    // Left in the queue it would be reclaimed and fail the same way until it
    // hit the attempt cap — five rewrites of a state that is already final.
    expect(h.notified).toContain(task);
    expect(h.retries).toEqual([]);
    expect(h.abandoned).toEqual([]);
  });

  it("stays failed when the driver runs again", async () => {
    const h = harness({ dispatchFails: 1, failFrom: 1, dispatchCode: "no_agent" });
    await startFeature(h);
    await h.agentReplies({ ok: true, prUrl: "https://pr/1" });

    h.advanceClock(60 * 60_000);
    const again = await h.driver.runOnce();

    expect(again).toEqual({ advanced: 0, retried: 0, abandoned: 0, failed: 0 });
    expect([...h.runs.values()][0].state).toBe("failed");
  });

  it("treats an ambiguous skill the same way — the definition, not the fleet, is wrong", async () => {
    const h = harness({ dispatchFails: 1, dispatchCode: "ambiguous_agent" });
    await expect(startFeature(h)).rejects.toBeInstanceOf(WorkflowRunFailed);
    expect([...h.runs.values()][0].state).toBe("failed");
  });

  it("still retries an agent that is merely unreachable", async () => {
    // `dispatch_failed` is the agent being down. The same dispatch later may
    // well work, so this must not end the run.
    const h = harness({ dispatchFails: 1, failFrom: 1, dispatchCode: "dispatch_failed" });
    await startFeature(h);

    const result = await h.agentReplies({ ok: true, prUrl: "https://pr/1" });

    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
    expect([...h.runs.values()][0].state).not.toBe("failed");
    expect(h.retries).toHaveLength(1);
  });

  it("still retries a failure that carries no code at all", async () => {
    const h = harness({ dispatchFails: 1, failFrom: 1 });
    await startFeature(h);
    const result = await h.agentReplies({ ok: true, prUrl: "https://pr/1" });
    expect(result.retried).toBe(1);
    expect(result.failed).toBe(0);
  });
});
