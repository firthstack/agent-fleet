import type { Pool, PoolClient } from "pg";
import type {
  WorkflowDriverStore,
  WorkflowRunRecord,
  WorkflowTaskRecord,
} from "./driver.js";
import type { WorkflowDefinition, WorkflowVars } from "./engine.js";

/**
 * Postgres backing for the composition layer (docs §5.2).
 *
 * Tenant-scoped reads go through the gateway store's `withTenant`, so RLS is
 * in force for them. The claim used by the driver loop is deliberately
 * cross-tenant, exactly like the notifier's: the background worker sweeps
 * every tenant and runs as the owner role.
 */

export interface WorkflowStoreDeps {
  pool: Pool;
  /** Runs `fn` with RLS active for this tenant. */
  withTenant<T>(tenantId: number, fn: (client: PoolClient) => Promise<T>): Promise<T>;
}

interface RunRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  state: string;
  status: string;
  reason: string | null;
  vars: WorkflowVars;
  source_type: string;
  source_ref: string;
  awaiting_task_id: string | null;
  admitted_at: Date | null;
  input_payload: Record<string, unknown> | null;
  updated_at: Date;
}

interface TaskRow {
  id: string;
  tenant_id: string;
  workflow_run_id: string | null;
  workflow_from_state: string | null;
  state: string;
  result_json: unknown | null;
  attempt: number;
}

const RUN_COLUMNS = `
  id, tenant_id, workflow_id, state, status, reason, vars,
  source_type, source_ref, awaiting_task_id, admitted_at, input_payload,
  updated_at
`;

function toRun(row: RunRow): WorkflowRunRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    workflowId: Number(row.workflow_id),
    state: row.state,
    status: row.status,
    reason: row.reason,
    vars: row.vars ?? {},
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    awaitingTaskId: row.awaiting_task_id === null ? null : Number(row.awaiting_task_id),
    admittedAt: row.admitted_at === null ? null : row.admitted_at.toISOString(),
    inputPayload: row.input_payload ?? {},
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTask(row: TaskRow): WorkflowTaskRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    workflowRunId: row.workflow_run_id === null ? null : Number(row.workflow_run_id),
    // A task dispatched before this column existed has no provenance; the
    // driver would then advance from the run's state, so default to that.
    fromState: row.workflow_from_state ?? "",
    state: row.state,
    result: row.result_json,
    attempt: row.attempt,
  };
}

/** Terminal states, as a SQL literal list. Kept beside the queries that use
 *  it so the two cannot drift. */
const TERMINAL_STATE_LIST = "'completed', 'failed', 'cancelled', 'needs_human'";

/** Advisory-lock namespace for "one tenant's concurrency slots". */
const RUN_SLOT_LOCK = 0x5f1ee7;

export class WorkflowStore implements WorkflowDriverStore {
  constructor(private readonly deps: WorkflowStoreDeps) {}

  // ------------------------------------------------------------ definitions

  /** Publish a definition. A new version never disturbs runs already in flight. */
  async putDefinition(input: {
    tenantId: number;
    name: string;
    version: number;
    definition: WorkflowDefinition;
  }): Promise<{ id: number; definition: WorkflowDefinition }> {
    return this.deps.withTenant(input.tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; definition: WorkflowDefinition }>(
        `INSERT INTO fleet_workflows (tenant_id, name, version, definition)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, name, version) DO UPDATE SET
           definition = EXCLUDED.definition,
           updated_at = now()
         RETURNING id, definition`,
        [input.tenantId, input.name, input.version, JSON.stringify(input.definition)],
      );
      return { id: Number(rows[0].id), definition: rows[0].definition };
    });
  }

  async getDefinition(
    tenantId: number,
    workflowId: number,
  ): Promise<{ id: number; definition: WorkflowDefinition } | null> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; definition: WorkflowDefinition }>(
        `SELECT id, definition FROM fleet_workflows
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, workflowId],
      );
      return rows.length > 0
        ? { id: Number(rows[0].id), definition: rows[0].definition }
        : null;
    });
  }

  /** Latest version unless one is named. */
  async findDefinition(
    tenantId: number,
    name: string,
    version?: number,
  ): Promise<{ id: number; definition: WorkflowDefinition } | null> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; definition: WorkflowDefinition }>(
        version === undefined
          ? `SELECT id, definition FROM fleet_workflows
             WHERE tenant_id = $1 AND name = $2
             ORDER BY version DESC LIMIT 1`
          : `SELECT id, definition FROM fleet_workflows
             WHERE tenant_id = $1 AND name = $2 AND version = $3`,
        version === undefined ? [tenantId, name] : [tenantId, name, version],
      );
      return rows.length > 0
        ? { id: Number(rows[0].id), definition: rows[0].definition }
        : null;
    });
  }

  async listDefinitions(
    tenantId: number,
  ): Promise<Array<{ id: number; name: string; version: number }>> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ id: string; name: string; version: number }>(
        `SELECT id, name, version FROM fleet_workflows
         WHERE tenant_id = $1 ORDER BY name, version DESC`,
        [tenantId],
      );
      return rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        version: r.version,
      }));
    });
  }

  // ------------------------------------------------------------------- runs

  async getRun(tenantId: number, runId: number): Promise<WorkflowRunRecord | null> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM fleet_workflow_runs
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, runId],
      );
      return rows.length > 0 ? toRun(rows[0]) : null;
    });
  }

  async getRunBySource(
    tenantId: number,
    sourceType: string,
    sourceRef: string,
  ): Promise<WorkflowRunRecord | null> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM fleet_workflow_runs
         WHERE tenant_id = $1 AND source_type = $2 AND source_ref = $3`,
        [tenantId, sourceType, sourceRef],
      );
      return rows.length > 0 ? toRun(rows[0]) : null;
    });
  }

  async createRun(input: {
    tenantId: number;
    workflowId: number;
    state: string;
    status: string;
    vars: WorkflowVars;
    sourceType: string;
    sourceRef: string;
    createdBy: string;
    /** What the run was started with, kept so a queued run can compute the
     *  same opening decision later that it would have computed now. */
    inputPayload?: Record<string, unknown>;
  }): Promise<WorkflowRunRecord> {
    return this.deps.withTenant(input.tenantId, async (client) => {
      const { rows } = await client.query<RunRow>(
        `INSERT INTO fleet_workflow_runs
           (tenant_id, workflow_id, state, status, vars,
            source_type, source_ref, created_by, input_payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${RUN_COLUMNS}`,
        [
          input.tenantId,
          input.workflowId,
          input.state,
          input.status,
          JSON.stringify(input.vars),
          input.sourceType,
          input.sourceRef,
          input.createdBy,
          JSON.stringify(input.inputPayload ?? {}),
        ],
      );
      return toRun(rows[0]);
    });
  }

  /**
   * Take one of the tenant's concurrency slots, if there is a free one.
   *
   * The count and the write happen under an advisory lock keyed on the tenant,
   * so two gateways admitting at the same moment cannot both read "4 live" and
   * both go to 5. The lock is transaction-scoped and held only across two
   * cheap statements — never across a dispatch.
   */
  async admitRun(
    tenantId: number,
    runId: number,
    maxConcurrent: number,
  ): Promise<boolean> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
        RUN_SLOT_LOCK,
        tenantId,
      ]);
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM fleet_workflow_runs
         WHERE tenant_id = $1 AND admitted_at IS NOT NULL
           AND state NOT IN (${TERMINAL_STATE_LIST})`,
        [tenantId],
      );
      if (Number(rows[0].n) >= maxConcurrent) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `UPDATE fleet_workflow_runs SET admitted_at = now(), updated_at = now()
         WHERE id = $1 AND tenant_id = $2 AND admitted_at IS NULL`,
        [runId, tenantId],
      );
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Runs the driver should start now: ones that have just been given a slot,
   * plus any that hold a slot but never got dispatched.
   *
   * That second group is the crash window. `admitted_at` is written before the
   * dispatch, so a process that dies in between leaves a run holding a slot
   * with nothing driving it — the same shape of stranding this whole feature
   * exists to avoid. Re-driving them is what makes the admission durable
   * rather than merely optimistic.
   */
  async claimRunsToStart(
    maxConcurrent: number,
    batchSize: number,
  ): Promise<WorkflowRunRecord[]> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");

      // Already holding a slot and still sitting in `queued`.
      const stalled = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM fleet_workflow_runs
         WHERE state = 'queued' AND admitted_at IS NOT NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );

      const claimed = stalled.rows.map(toRun);
      if (claimed.length >= batchSize) {
        await client.query("COMMIT");
        return claimed;
      }

      // Tenants with something waiting, and how much of their limit is free.
      const { rows: tenants } = await client.query<{ tenant_id: string; live: string }>(
        `SELECT q.tenant_id,
                (SELECT count(*) FROM fleet_workflow_runs a
                  WHERE a.tenant_id = q.tenant_id
                    AND a.admitted_at IS NOT NULL
                    AND a.state NOT IN (${TERMINAL_STATE_LIST}))::text AS live
         FROM (SELECT DISTINCT tenant_id FROM fleet_workflow_runs
               WHERE admitted_at IS NULL) q`,
      );

      for (const row of tenants) {
        const tenantId = Number(row.tenant_id);
        const free = Math.min(
          maxConcurrent - Number(row.live),
          batchSize - claimed.length,
        );
        if (free <= 0) continue;
        const { rows: waiting } = await client.query<RunRow>(
          `UPDATE fleet_workflow_runs SET admitted_at = now(), updated_at = now()
           WHERE id IN (
             SELECT id FROM fleet_workflow_runs
             WHERE tenant_id = $1 AND admitted_at IS NULL
             ORDER BY id
             LIMIT $2
             FOR UPDATE SKIP LOCKED
           )
           RETURNING ${RUN_COLUMNS}`,
          [tenantId, free],
        );
        claimed.push(...waiting.map(toRun));
        if (claimed.length >= batchSize) break;
      }

      await client.query("COMMIT");
      return claimed;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateRun(
    runId: number,
    patch: {
      state: string;
      status: string;
      reason?: string | null;
      vars: WorkflowVars;
      awaitingTaskId?: number | null;
    },
  ): Promise<void> {
    // Omitting awaitingTaskId means "leave it alone", not "clear it" — that
    // distinction is what keeps a failed dispatch retryable (docs §4 of the
    // driver's own notes).
    await this.deps.pool.query(
      `UPDATE fleet_workflow_runs
       SET state = $2, status = $3, reason = $4, vars = $5,
           awaiting_task_id = CASE WHEN $7 THEN $6 ELSE awaiting_task_id END,
           updated_at = now()
       WHERE id = $1`,
      [
        runId,
        patch.state,
        patch.status,
        patch.reason ?? null,
        JSON.stringify(patch.vars),
        patch.awaitingTaskId ?? null,
        patch.awaitingTaskId !== undefined,
      ],
    );
  }

  async appendRunEvent(input: {
    tenantId: number;
    runId: number;
    eventType: string;
    payload: unknown;
  }): Promise<void> {
    await this.deps.pool.query(
      `INSERT INTO fleet_workflow_run_events (tenant_id, run_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [input.tenantId, input.runId, input.eventType, JSON.stringify(input.payload)],
    );
  }

  async listRunEvents(
    tenantId: number,
    runId: number,
  ): Promise<Array<{ eventType: string; payload: unknown; createdAt: string }>> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        event_type: string;
        payload: unknown;
        created_at: Date;
      }>(
        `SELECT event_type, payload, created_at FROM fleet_workflow_run_events
         WHERE tenant_id = $1 AND run_id = $2 ORDER BY id`,
        [tenantId, runId],
      );
      return rows.map((r) => ({
        eventType: r.event_type,
        payload: r.payload,
        createdAt: r.created_at.toISOString(),
      }));
    });
  }

  async listRuns(
    tenantId: number,
    limit = 50,
  ): Promise<WorkflowRunRecord[]> {
    return this.deps.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM fleet_workflow_runs
         WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2`,
        [tenantId, limit],
      );
      return rows.map(toRun);
    });
  }

  // ------------------------------------------------------------ driver loop

  /**
   * Claim finished workflow steps. Same shape as the notifier's claim, and
   * deliberately cross-tenant: the background worker sweeps every tenant.
   */
  async claimWorkflowAdvances(
    now: Date,
    limit: number,
  ): Promise<WorkflowTaskRecord[]> {
    const client = await this.deps.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM fleet_tasks
         WHERE workflow_run_id IS NOT NULL
           AND notified_at IS NULL
           AND state IN ('done_pending_notify', 'timed_out', 'failed')
           AND (next_retry_at IS NULL OR next_retry_at <= $1)
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (rows.length === 0) {
        await client.query("COMMIT");
        return [];
      }
      const updated = await client.query<TaskRow>(
        `UPDATE fleet_tasks
         SET attempt = attempt + 1, next_retry_at = NULL, updated_at = now()
         WHERE id = ANY($1::bigint[])
         RETURNING id, tenant_id, workflow_run_id, workflow_from_state,
                   state, result_json, attempt`,
        [rows.map((r) => r.id)],
      );
      await client.query("COMMIT");
      return updated.rows.map(toTask);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markNotified(taskId: number): Promise<void> {
    await this.deps.pool.query(
      `UPDATE fleet_tasks
       SET notified_at = now(), next_retry_at = NULL, updated_at = now()
       WHERE id = $1 AND notified_at IS NULL`,
      [taskId],
    );
  }

  async recordNotifyFailure(taskId: number, nextRetryAt: Date): Promise<void> {
    await this.deps.pool.query(
      `UPDATE fleet_tasks SET next_retry_at = $2, updated_at = now()
       WHERE id = $1 AND notified_at IS NULL`,
      [taskId, nextRetryAt],
    );
  }

  async abandonNotification(taskId: number): Promise<void> {
    await this.deps.pool.query(
      `UPDATE fleet_tasks
       SET notified_at = now(), next_retry_at = NULL, updated_at = now()
       WHERE id = $1 AND notified_at IS NULL`,
      [taskId],
    );
  }
}
