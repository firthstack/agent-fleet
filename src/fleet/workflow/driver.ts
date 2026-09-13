import {
  advance,
  resumeRun,
  startRun,
  type Decision,
  type RunSnapshot,
  type WorkflowDefinition,
  type WorkflowVars,
} from "./engine.js";

/**
 * Drives workflow runs forward (docs/fleet-composition-layer.md §5).
 *
 * There is no long-lived saga. A run is a row; a completed step wakes the
 * driver, the engine says what happens next, and the driver dispatches it or
 * finishes the run. A restart loses nothing, because nothing was in memory —
 * which is exactly the defect recorded against the old orchestration in the
 * gateway doc §13.1.
 *
 * Reliability is inherited rather than rebuilt: a workflow-owned task sits in
 * the same claim queue as an ordinary caller notification, so backoff,
 * timeouts, idempotency and SKIP LOCKED concurrency all already apply.
 */

export interface WorkflowRunRecord {
  id: number;
  tenantId: number;
  workflowId: number;
  state: string;
  status: string;
  reason: string | null;
  vars: WorkflowVars;
  sourceType: string;
  sourceRef: string;
  /** Last transition. The viewer uses it to show how long a step has sat. */
  updatedAt?: string;
  /**
   * The step this run is currently waiting on. A completed task whose id is
   * not this one has already been applied (or was superseded), so replaying
   * it must not dispatch the next step a second time.
   */
  awaitingTaskId: number | null;
  /**
   * When the run took one of its tenant's concurrency slots. `null` means it
   * is accepted but waiting for one — recorded, visible, and not yet costing
   * any agent anything.
   */
  admittedAt?: string | null;
  /** What it was started with, so a queued run opens exactly as it would have. */
  inputPayload?: Record<string, unknown>;
}

export interface WorkflowTaskRecord {
  id: number;
  tenantId: number;
  workflowRunId: number | null;
  /**
   * The workflow state this task was dispatched from.
   *
   * Advancing reads this rather than the run's current state. The run row is
   * written before the dispatch (so a stuck step is visible), which means a
   * dispatch that then fails leaves the run one state ahead of the task being
   * retried — resuming from the run would advance from the wrong place.
   */
  fromState: string;
  state: string;
  /** What the callback handler stored: `{ state, result, error }`. */
  result: unknown | null;
  attempt: number;
}

export interface WorkflowDriverStore {
  /**
   * Take one of the tenant's concurrency slots if one is free. Optional: a
   * store without it means no limit, which is what every caller had before.
   */
  admitRun?(tenantId: number, runId: number, maxConcurrent: number): Promise<boolean>;
  /** Runs that now hold a slot and still need their opening step dispatched. */
  claimRunsToStart?(maxConcurrent: number, batchSize: number): Promise<WorkflowRunRecord[]>;
  getDefinition(
    tenantId: number,
    workflowId: number,
  ): Promise<{ id: number; definition: WorkflowDefinition } | null>;
  findDefinition(
    tenantId: number,
    name: string,
    version?: number,
  ): Promise<{ id: number; definition: WorkflowDefinition } | null>;
  getRun(tenantId: number, runId: number): Promise<WorkflowRunRecord | null>;
  getRunBySource(
    tenantId: number,
    sourceType: string,
    sourceRef: string,
  ): Promise<WorkflowRunRecord | null>;
  createRun(input: {
    tenantId: number;
    workflowId: number;
    state: string;
    status: string;
    vars: WorkflowVars;
    sourceType: string;
    sourceRef: string;
    createdBy: string;
    /** Kept so a queued run opens exactly as an immediate one would have. */
    inputPayload?: Record<string, unknown>;
  }): Promise<WorkflowRunRecord>;
  updateRun(
    runId: number,
    patch: {
      state: string;
      status: string;
      reason?: string | null;
      vars: WorkflowVars;
      awaitingTaskId?: number | null;
    },
  ): Promise<void>;
  appendRunEvent(input: {
    tenantId: number;
    runId: number;
    eventType: string;
    payload: unknown;
  }): Promise<void>;

  claimWorkflowAdvances(now: Date, limit: number): Promise<WorkflowTaskRecord[]>;
  markNotified(taskId: number): Promise<void>;
  recordNotifyFailure(taskId: number, nextRetryAt: Date): Promise<void>;
  abandonNotification(taskId: number): Promise<void>;
}

export interface WorkflowDispatcher {
  /**
   * Resolve the skill inside the tenant and dispatch, tagging the task with
   * the run so its completion comes back here.
   */
  dispatch(input: {
    tenantId: number;
    workflowRunId: number;
    /** Recorded on the task so a retry advances from the right place. */
    fromState: string;
    skillId: string;
    payload: Record<string, unknown>;
    deadlineAt: Date;
  }): Promise<{ taskId: number }>;
}

export interface WorkflowDriverLogger {
  info(data: Record<string, unknown>, message?: string): void;
  warn?(data: Record<string, unknown>, message?: string): void;
  error(data: Record<string, unknown>, message?: string): void;
}

export interface WorkflowDriverDeps {
  store: WorkflowDriverStore;
  dispatcher: WorkflowDispatcher;
  logger?: WorkflowDriverLogger;
  now?(): Date;
  /** Per-step budget. Becomes the task's deadline_at. */
  stepTimeoutMs?: number;
  maxAdvanceAttempts?: number;
  backoffMs?(attempt: number): number;
  /**
   * How many runs one tenant may have in flight. Further submissions are
   * accepted and held in `queued`, then started in submission order as slots
   * free up — the behaviour a single workflow agent used to provide by
   * queueing internally, which moving orchestration into the platform lost.
   */
  maxConcurrentRunsPerTenant?: number;
  batchSize?: number;
}

export class WorkflowDriverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDriverError";
  }
}

/**
 * Why a dispatch did not happen. The code is what decides the run's fate:
 * `dispatch_failed` is the agent being unreachable and is worth retrying;
 * the other two are not (see `WorkflowRunFailed`).
 */
export class WorkflowDispatchError extends Error {
  constructor(
    message: string,
    readonly code: "no_agent" | "ambiguous_agent" | "dispatch_failed",
  ) {
    super(message);
    this.name = "WorkflowDispatchError";
  }
}

/**
 * A dispatch that could not have succeeded, and would not succeed on a retry
 * either: nothing in the tenant offers the skill, or several things do and the
 * definition names none of them.
 *
 * Both used to travel the retry path, which is wrong in a way that is easy to
 * miss: the run row is written *before* the dispatch, so a failure left the run
 * one state ahead with no task behind it. Retries rewrote that same state five
 * times over eight minutes and then gave up, and because the deadline sweep
 * only ever looks at `fleet_tasks` — and no task row was created — nothing
 * afterwards could move the run again. It sat in a live-looking state forever.
 *
 * So these end the run instead. The run is `failed` with a reason that names
 * the skill, which is the one thing the person reading it has to know.
 */
export class WorkflowRunFailed extends Error {
  constructor(
    readonly runId: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowRunFailed";
  }
}

/** Retrying changes nothing for these; only the fleet or the definition can. */
function isDeterministic(err: unknown): err is WorkflowDispatchError {
  return (
    err instanceof WorkflowDispatchError &&
    (err.code === "no_agent" || err.code === "ambiguous_agent")
  );
}

const DEFAULT_STEP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * What the engine sees as `result`.
 *
 * A step that timed out or whose dispatch failed has no agent result at all.
 * Presenting `{ ok: false }` lets the definition's ordinary failure branch
 * handle it — no special casing in either the engine or the workflow.
 */
export function stepResult(task: WorkflowTaskRecord): unknown {
  if (task.state === "timed_out") {
    return { ok: false, error: "step timed out" };
  }
  const stored = task.result as
    | { state?: string; result?: unknown; error?: unknown }
    | null;
  if (!stored) return { ok: false, error: "step produced no result" };
  if (stored.state && stored.state !== "completed") {
    return { ok: false, error: stored.error ?? `step ended as ${stored.state}` };
  }
  return stored.result ?? { ok: false, error: "step produced no result" };
}

export function createWorkflowDriver(deps: WorkflowDriverDeps) {
  const now = deps.now ?? (() => new Date());
  const stepTimeout = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxAttempts = deps.maxAdvanceAttempts ?? 5;
  // Per tenant, not per agent and not global: one account's burst must not
  // decide how the platform behaves for everyone else.
  const maxConcurrent = deps.maxConcurrentRunsPerTenant ?? 10;
  const backoff = deps.backoffMs ?? ((attempt: number) => 30_000 * 2 ** (attempt - 1));

  /** Persist a decision, dispatching if it asks for one. */
  async function applyDecision(
    run: WorkflowRunRecord,
    decision: Decision,
  ): Promise<WorkflowRunRecord> {
    if (decision.kind === "terminal") {
      await deps.store.updateRun(run.id, {
        state: decision.state,
        status: decision.status,
        reason: decision.reason ?? null,
        vars: decision.vars,
      });
      // One event per state walked. A pass-through state like `pr_opened`
      // is a real milestone — the PR now exists — and would otherwise never
      // appear in the run's history.
      for (const state of decision.path) {
        await deps.store.appendRunEvent({
          tenantId: run.tenantId,
          runId: run.id,
          eventType: state,
          payload:
            state === decision.state ? { reason: decision.reason ?? null } : {},
        });
      }
      deps.logger?.info(
        { runId: run.id, state: decision.state, reason: decision.reason },
        "workflow run finished",
      );
      return {
        ...run,
        state: decision.state,
        status: decision.status,
        reason: decision.reason ?? null,
        vars: decision.vars,
      };
    }

    // Record the state before dispatching, so an observer sees "waiting on
    // review" while it waits rather than only after the reply lands.
    // `awaitingTaskId` deliberately stays put: if the dispatch below fails,
    // the task being retried must still look current.
    await deps.store.updateRun(run.id, {
      state: decision.state,
      status: decision.status,
      reason: null,
      vars: decision.vars,
    });

    let taskId: number;
    try {
      ({ taskId } = await deps.dispatcher.dispatch({
        tenantId: run.tenantId,
        workflowRunId: run.id,
        fromState: decision.state,
        skillId: decision.skillId,
        payload: decision.payload,
        deadlineAt: new Date(now().getTime() + stepTimeout),
      }));
    } catch (err) {
      // A transient failure (the agent is down, the request timed out) still
      // belongs on the retry path: the same dispatch later may well work.
      if (!isDeterministic(err)) throw err;

      await deps.store.updateRun(run.id, {
        state: "failed",
        status: "failed",
        reason: err.message,
        vars: decision.vars,
      });
      // The states walked to get here, then the failure. The run really did
      // enter them — the row was written above — so a timeline that jumped
      // from the previous step straight to `failed` would hide where it got
      // to. The final one carries the skill but no task id, because no task
      // was created: the dispatcher refuses before it writes one.
      for (const state of decision.path) {
        await deps.store.appendRunEvent({
          tenantId: run.tenantId,
          runId: run.id,
          eventType: state,
          payload: state === decision.state ? { skillId: decision.skillId } : {},
        });
      }
      await deps.store.appendRunEvent({
        tenantId: run.tenantId,
        runId: run.id,
        eventType: "failed",
        payload: {
          error: err.code,
          reason: err.message,
          state: decision.state,
          skillId: decision.skillId,
        },
      });
      deps.logger?.error(
        { runId: run.id, state: decision.state, skillId: decision.skillId, error: err.code },
        "workflow run failed: the step could not be dispatched",
      );
      throw new WorkflowRunFailed(run.id, err.code, err.message);
    }

    // Only now does the run move on to waiting for the new step. This is what
    // makes a replayed completion a no-op instead of a second dispatch.
    await deps.store.updateRun(run.id, {
      state: decision.state,
      status: decision.status,
      reason: null,
      vars: decision.vars,
      awaitingTaskId: taskId,
    });

    for (const state of decision.path) {
      await deps.store.appendRunEvent({
        tenantId: run.tenantId,
        runId: run.id,
        eventType: state,
        payload:
          state === decision.state ? { skillId: decision.skillId, taskId } : {},
      });
    }
    deps.logger?.info(
      { runId: run.id, state: decision.state, skillId: decision.skillId, taskId },
      "workflow step dispatched",
    );

    return {
      ...run,
      state: decision.state,
      status: decision.status,
      reason: null,
      vars: decision.vars,
      awaitingTaskId: taskId,
    };
  }

  function snapshotOf(run: WorkflowRunRecord): RunSnapshot {
    return {
      id: run.id,
      state: run.state,
      status: run.status,
      reason: run.reason,
      vars: run.vars,
    };
  }

  return {
    /** Begin a run, or return the existing one if this dispatch is a replay. */
    async start(input: {
      tenantId: number;
      workflowName: string;
      version?: number;
      payload: Record<string, unknown>;
      createdBy: string;
      sourceType: string;
      sourceRef: string;
    }): Promise<{ run: WorkflowRunRecord; deduplicated: boolean }> {
      const existing = await deps.store.getRunBySource(
        input.tenantId,
        input.sourceType,
        input.sourceRef,
      );
      if (existing) {
        // A redelivered dispatch must not open a second PR for one requirement.
        await deps.store.appendRunEvent({
          tenantId: input.tenantId,
          runId: existing.id,
          eventType: "deduplicated",
          payload: { sourceType: input.sourceType, sourceRef: input.sourceRef },
        });
        return { run: existing, deduplicated: true };
      }

      const found = await deps.store.findDefinition(
        input.tenantId,
        input.workflowName,
        input.version,
      );
      if (!found) {
        throw new WorkflowDriverError(`unknown workflow: ${input.workflowName}`);
      }

      const decision = startRun(found.definition, input.payload);
      const run = await deps.store.createRun({
        tenantId: input.tenantId,
        workflowId: found.id,
        state: "queued",
        status: "queued",
        vars: decision.vars,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        createdBy: input.createdBy,
        inputPayload: input.payload,
      });
      await deps.store.appendRunEvent({
        tenantId: run.tenantId,
        runId: run.id,
        eventType: "created",
        payload: { workflow: input.workflowName, vars: decision.vars },
      });

      // The run is recorded either way. What the slot decides is only whether
      // an agent hears about it now or in a few seconds.
      const admitted = deps.store.admitRun
        ? await deps.store.admitRun(run.tenantId, run.id, maxConcurrent)
        : true;
      if (!admitted) {
        await deps.store.appendRunEvent({
          tenantId: run.tenantId,
          runId: run.id,
          eventType: "queued",
          payload: { reason: "tenant_at_capacity", limit: maxConcurrent },
        });
        deps.logger?.info(
          { runId: run.id, tenantId: run.tenantId, limit: maxConcurrent },
          "workflow run queued: the tenant is at its concurrency limit",
        );
        return { run, deduplicated: false };
      }

      // The record was read before the slot was taken, and `applyDecision`
      // spreads it — without stamping the admission here, a run that is
      // actually dispatching would report itself as still waiting.
      const admittedRun = { ...run, admittedAt: now().toISOString() };
      return {
        run: await applyDecision(admittedRun, decision),
        deduplicated: false,
      };
    },

    /** Push one run forward using the result of the step that just finished. */
    async advanceForTask(task: WorkflowTaskRecord): Promise<WorkflowRunRecord | null> {
      if (task.workflowRunId === null) return null;
      const run = await deps.store.getRun(task.tenantId, task.workflowRunId);
      if (!run) {
        throw new WorkflowDriverError(`workflow run ${task.workflowRunId} not found`);
      }
      const found = await deps.store.getDefinition(run.tenantId, run.workflowId);
      if (!found) {
        throw new WorkflowDriverError(`workflow ${run.workflowId} not found`);
      }

      // Already applied, or superseded by a later dispatch. Replaying it would
      // dispatch the next step twice — two PRs for one requirement.
      if (run.awaitingTaskId !== null && run.awaitingTaskId !== task.id) {
        deps.logger?.info(
          { runId: run.id, taskId: task.id, awaiting: run.awaitingTaskId },
          "workflow ignoring a stale step completion",
        );
        return null;
      }

      const decision = advance(
        found.definition,
        // From the task's own state, not the run's: they differ whenever a
        // dispatch failed after the run row was written ahead of it.
        { ...snapshotOf(run), state: task.fromState },
        stepResult(task),
      );
      return applyDecision(run, decision);
    },

    /** Pick up an interrupted run where its definition says to. */
    async resume(
      tenantId: number,
      runId: number,
    ): Promise<WorkflowRunRecord | null> {
      const run = await deps.store.getRun(tenantId, runId);
      if (!run) throw new WorkflowDriverError(`workflow run ${runId} not found`);
      const found = await deps.store.getDefinition(tenantId, run.workflowId);
      if (!found) throw new WorkflowDriverError(`workflow ${run.workflowId} not found`);

      const decision = resumeRun(found.definition, snapshotOf(run));
      // No rule matched: simply not resumable, rather than a bespoke error.
      if (!decision) return null;
      return applyDecision(run, decision);
    },

    /**
     * One pass of the driver loop. Shares the notify queue's claim, so a
     * crashed driver's tasks come back on the next pass.
     */
    /**
     * Dispatch the opening step of a run that has been holding a slot.
     *
     * The decision is recomputed from the payload the run was created with,
     * not from its stored vars: those are the vars *after* the start
     * transitions ran, so following them again would apply any `set` on the
     * matched transition a second time.
     */
    async startQueuedRun(run: WorkflowRunRecord): Promise<WorkflowRunRecord | null> {
      const found = await deps.store.getDefinition(run.tenantId, run.workflowId);
      if (!found) {
        throw new WorkflowDriverError(`workflow ${run.workflowId} not found`);
      }
      return applyDecision(run, startRun(found.definition, run.inputPayload ?? {}));
    },

    async runOnce(): Promise<{
      advanced: number;
      retried: number;
      abandoned: number;
      /** Runs ended because a step could not be dispatched at all. */
      failed: number;
      /** Queued runs given a slot and started on this pass. */
      started: number;
    }> {
      const due = await deps.store.claimWorkflowAdvances(now(), deps.batchSize ?? 20);
      let advanced = 0;
      let retried = 0;
      let abandoned = 0;
      let failed = 0;
      let started = 0;

      for (const task of due) {
        try {
          await this.advanceForTask(task);
          await deps.store.markNotified(task.id);
          advanced += 1;
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          if (err instanceof WorkflowRunFailed) {
            // The run is already terminal; the step that drove it there has
            // nothing left to do and must leave the queue, or it would be
            // reclaimed and fail the same way until it hit the attempt cap.
            await deps.store.markNotified(task.id);
            failed += 1;
            continue;
          }
          if (task.attempt >= maxAttempts) {
            await deps.store.abandonNotification(task.id);
            abandoned += 1;
            deps.logger?.error(
              { taskId: task.id, runId: task.workflowRunId, error },
              "workflow advance abandoned after repeated failures",
            );
            continue;
          }
          await deps.store.recordNotifyFailure(
            task.id,
            new Date(now().getTime() + backoff(task.attempt)),
          );
          retried += 1;
          deps.logger?.warn?.(
            { taskId: task.id, runId: task.workflowRunId, attempt: task.attempt, error },
            "workflow advance failed; will retry",
          );
        }
      }

      // Draining comes after advancing, so a slot freed by a run finishing in
      // this same pass is handed to whoever is waiting without a tick's delay.
      if (deps.store.claimRunsToStart) {
        const waiting = await deps.store.claimRunsToStart(
          maxConcurrent,
          deps.batchSize ?? 20,
        );
        for (const run of waiting) {
          try {
            await this.startQueuedRun(run);
            started += 1;
          } catch (err) {
            // A queued run whose opening step cannot be dispatched fails the
            // same way an immediate one does — `applyDecision` has already
            // written that. Anything else leaves it holding its slot, and the
            // next pass picks it up again as a stalled admission.
            if (err instanceof WorkflowRunFailed) {
              failed += 1;
              continue;
            }
            deps.logger?.error(
              {
                runId: run.id,
                error: err instanceof Error ? err.message : String(err),
              },
              "could not start a queued workflow run",
            );
          }
        }
      }

      return { advanced, retried, abandoned, failed, started };
    },
  };
}
