import type { Pool, PoolClient } from "pg";
import { createFleetPool, type FleetDbOptions } from "./db.js";
import type { SecretBox } from "./secretBox.js";
import type { AgentCredential } from "./a2aClient.js";
import { WorkflowStore } from "../workflow/workflowStore.js";
import type {
  A2AAgentCard,
  AgentHealth,
  FleetTaskState,
  PushNotificationConfig,
} from "../protocol/a2a.js";

export interface TenantRecord {
  id: number;
  slug: string;
  displayName: string;
  createdAt: string;
}

export interface GatewayAgentRecord {
  tenantId: number;
  agentId: string;
  displayName: string;
  /** The agent's real address. Never leaves the site (docs §3). */
  endpointUrl: string;
  card: A2AAgentCard;
  health: AgentHealth;
  cardFetchedAt: string | null;
  lastSeenAt: string | null;
}

/** What the agent card on `/app/agents` shows besides the card itself. */
export interface AgentTaskStats {
  totalRuns: number;
  succeeded: number;
  failed: number;
  running: number;
  /** `created_at` of the oldest task still `dispatching`/`running`; null when none are. */
  runningSince: string | null;
}

export interface FleetTaskRecord {
  id: number;
  tenantId: number;
  upstreamTaskId: string;
  callerAgentId: string;
  callerCallbackUrl: string | null;
  callerCallbackAuth: PushNotificationConfig["authentication"] | null;
  targetAgentId: string;
  skillId: string;
  downstreamTaskId: string | null;
  state: FleetTaskState;
  attempt: number;
  nextRetryAt: string | null;
  deadlineAt: string;
  result: unknown | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  tenantId: number;
  upstreamTaskId: string;
  callerAgentId: string;
  callerCallbackUrl?: string | null;
  callerCallbackAuth?: PushNotificationConfig["authentication"] | null;
  targetAgentId: string;
  skillId: string;
  deadlineAt: Date;
  /**
   * Set when the composition layer owns this step. Its completion then drives
   * the state machine instead of calling a webhook, and `workflowFromState`
   * records where to advance from if the task has to be retried.
   */
  workflowRunId?: number | null;
  workflowFromState?: string | null;
}

const AGENT_COLUMNS = `
  tenant_id, agent_id, display_name, endpoint_url,
  card_json, health, card_fetched_at, last_seen_at
`;

const TASK_COLUMNS = `
  id, tenant_id, upstream_task_id, caller_agent_id, caller_callback_url,
  caller_callback_auth, target_agent_id, skill_id, downstream_task_id,
  state, attempt, next_retry_at, deadline_at, result_json, notified_at,
  created_at, updated_at
`;

interface AgentRow {
  tenant_id: string;
  agent_id: string;
  display_name: string;
  endpoint_url: string;
  card_json: A2AAgentCard;
  health: AgentHealth;
  card_fetched_at: Date | null;
  last_seen_at: Date | null;
}

interface TaskRow {
  id: string;
  tenant_id: string;
  upstream_task_id: string;
  caller_agent_id: string;
  caller_callback_url: string | null;
  caller_callback_auth: PushNotificationConfig["authentication"] | null;
  target_agent_id: string;
  skill_id: string;
  downstream_task_id: string | null;
  state: FleetTaskState;
  attempt: number;
  next_retry_at: Date | null;
  deadline_at: Date;
  result_json: unknown | null;
  notified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toAgent(row: AgentRow): GatewayAgentRecord {
  return {
    tenantId: Number(row.tenant_id),
    agentId: row.agent_id,
    displayName: row.display_name,
    endpointUrl: row.endpoint_url,
    card: row.card_json,
    health: row.health,
    cardFetchedAt: iso(row.card_fetched_at),
    lastSeenAt: iso(row.last_seen_at),
  };
}

function toTask(row: TaskRow): FleetTaskRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    upstreamTaskId: row.upstream_task_id,
    callerAgentId: row.caller_agent_id,
    callerCallbackUrl: row.caller_callback_url,
    callerCallbackAuth: row.caller_callback_auth,
    targetAgentId: row.target_agent_id,
    skillId: row.skill_id,
    downstreamTaskId: row.downstream_task_id,
    state: row.state,
    attempt: row.attempt,
    nextRetryAt: iso(row.next_retry_at),
    deadlineAt: row.deadline_at.toISOString(),
    result: row.result_json,
    notifiedAt: iso(row.notified_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface GatewayStoreOptions extends FleetDbOptions {
  /** Required only for the outbound-credential methods. */
  secretBox?: SecretBox;
}

/**
 * Postgres-backed registry and task ledger for the fleet gateway.
 *
 * Every agent-facing read takes `tenantId` as its first argument by
 * construction — a cross-tenant lookup returns nothing rather than raising,
 * so callers fall through to the ordinary "not found" branch (docs §9.2).
 * RLS lands in a later migration as the backstop for whatever this layer
 * forgets (docs §9.1 layer 6).
 */
export class GatewayStore {
  private readonly pool: Pool;
  private readonly secretBox?: SecretBox;

  constructor(opts: GatewayStoreOptions) {
    this.pool = createFleetPool(opts);
    this.secretBox = opts.secretBox;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** Test/bootstrap helper: apply a migration file's SQL verbatim. */
  async migrate(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  /**
   * Test helper: count rows without a tenant filter. Runs on the pool's owner
   * role, so it is not subject to RLS — which is the point, since it is used
   * to assert that nothing was created at all.
   */
  async countRows(table: string): Promise<number> {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
      throw new Error(`refusing to count a non-identifier table: ${table}`);
    }
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${table}`,
    );
    return Number(rows[0].n);
  }

  /** Test helper: wipe every table without dropping the schema. */
  async truncateAll(): Promise<void> {
    await this.pool.query(
      `TRUNCATE tenants, fleet_tenant_members, fleet_agents, fleet_agent_skills,
                fleet_agent_tokens, fleet_agent_credentials,
                fleet_tasks, fleet_task_events,
                auth_user, auth_session, auth_account, auth_verification
       RESTART IDENTITY CASCADE`,
    );
  }

  /**
   * Run inside the tenant's own security context (docs §9.1 layer 6).
   *
   * `SET LOCAL ROLE fleet_app` is the part that makes RLS real: the pool
   * connects as `postgres`, which is both superuser and table owner, and RLS
   * is simply not applied to such a role. Switching to the unprivileged role
   * for the duration of the transaction puts the policies in force, and the
   * switch unwinds automatically at COMMIT or ROLLBACK.
   *
   * From here a query that forgets `WHERE tenant_id = ...` returns nothing
   * instead of another tenant's rows.
   */
  async withTenant<T>(
    tenantId: number,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE fleet_app");
      // Parameterised so a caller cannot inject through the tenant id.
      await client.query("SELECT set_config('app.tenant_id', $1::text, true)", [
        tenantId,
      ]);
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- tenants

  async ensureTenant(input: {
    slug: string;
    displayName: string;
  }): Promise<TenantRecord> {
    const { rows } = await this.pool.query<{
      id: string;
      slug: string;
      display_name: string;
      created_at: Date;
    }>(
      `INSERT INTO tenants (slug, display_name)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id, slug, display_name, created_at`,
      [input.slug, input.displayName],
    );
    const row = rows[0];
    return {
      id: Number(row.id),
      slug: row.slug,
      displayName: row.display_name,
      createdAt: row.created_at.toISOString(),
    };
  }

  /**
   * Find or mint the tenant a user owns.
   *
   * Called from Better Auth's user-create hook, so there is never a moment
   * where someone is signed in with nowhere to put their agents. One user =
   * one tenant for now; the membership table is already shaped for more.
   */
  async ensureTenantForUser(user: {
    id: string;
    email: string;
    name?: string;
  }): Promise<TenantRecord> {
    const existing = await this.tenantForUser(user.id);
    if (existing) return existing;

    return this.withTransaction(async (client) => {
      const slug = await this.freeSlug(client, user.email);
      const { rows } = await client.query<{
        id: string;
        slug: string;
        display_name: string;
        created_at: Date;
      }>(
        `INSERT INTO tenants (slug, display_name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, slug, display_name, created_at`,
        [slug, user.name?.trim() || user.email, user.id],
      );
      const row = rows[0];
      await client.query(
        `INSERT INTO fleet_tenant_members (tenant_id, user_id, role)
         VALUES ($1, $2, 'owner')
         ON CONFLICT DO NOTHING`,
        [row.id, user.id],
      );
      return {
        id: Number(row.id),
        slug: row.slug,
        displayName: row.display_name,
        createdAt: row.created_at.toISOString(),
      };
    });
  }

  /**
   * The slug appears in every gateway URL, so it has to be URL-safe and
   * unique. Derived from the email's local part, with a numeric suffix when
   * that is taken — two people at different companies are both "admin".
   */
  private async freeSlug(client: PoolClient, email: string): Promise<string> {
    const base =
      email
        .split("@")[0]
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "tenant";

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const { rows } = await client.query("SELECT 1 FROM tenants WHERE slug = $1", [
        slug,
      ]);
      if (rows.length === 0) return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  async tenantForUser(userId: string): Promise<TenantRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      slug: string;
      display_name: string;
      created_at: Date;
    }>(
      `SELECT t.id, t.slug, t.display_name, t.created_at
       FROM tenants t
       JOIN fleet_tenant_members m ON m.tenant_id = t.id
       WHERE m.user_id = $1
       ORDER BY t.id
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: Number(row.id),
      slug: row.slug,
      displayName: row.display_name,
      createdAt: row.created_at.toISOString(),
    };
  }

  async getTenantBySlug(slug: string): Promise<TenantRecord | null> {
    const { rows } = await this.pool.query<{
      id: string;
      slug: string;
      display_name: string;
      created_at: Date;
    }>(`SELECT id, slug, display_name, created_at FROM tenants WHERE slug = $1`, [
      slug,
    ]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: Number(row.id),
      slug: row.slug,
      displayName: row.display_name,
      createdAt: row.created_at.toISOString(),
    };
  }

  // ----------------------------------------------------------------- agents

  /**
   * Register or refresh an agent. The skill index is rebuilt from the card in
   * the same transaction, so a card that drops a skill stops matching it.
   */
  async registerAgent(input: {
    tenantId: number;
    agentId: string;
    displayName: string;
    endpointUrl: string;
    card: A2AAgentCard;
    health?: AgentHealth;
  }): Promise<GatewayAgentRecord> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<AgentRow>(
        `INSERT INTO fleet_agents
           (tenant_id, agent_id, display_name, endpoint_url, card_json,
            health, card_fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
           display_name    = EXCLUDED.display_name,
           endpoint_url    = EXCLUDED.endpoint_url,
           card_json       = EXCLUDED.card_json,
           health          = EXCLUDED.health,
           card_fetched_at = now(),
           updated_at      = now()
         RETURNING ${AGENT_COLUMNS}`,
        [
          input.tenantId,
          input.agentId,
          input.displayName,
          input.endpointUrl,
          JSON.stringify(input.card),
          input.health ?? "healthy",
        ],
      );

      await client.query(
        `DELETE FROM fleet_agent_skills WHERE tenant_id = $1 AND agent_id = $2`,
        [input.tenantId, input.agentId],
      );
      for (const skill of input.card.skills ?? []) {
        await client.query(
          `INSERT INTO fleet_agent_skills
             (tenant_id, agent_id, skill_id, name, description, input_schema)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            input.tenantId,
            input.agentId,
            skill.id,
            skill.name,
            skill.description,
            skill.inputSchema === undefined
              ? null
              : JSON.stringify(skill.inputSchema),
          ],
        );
      }

      return toAgent(rows[0]);
    });
  }

  async getAgent(
    tenantId: number,
    agentId: string,
  ): Promise<GatewayAgentRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM fleet_agents
         WHERE tenant_id = $1 AND agent_id = $2`,
        [tenantId, agentId],
      );
      return rows.length > 0 ? toAgent(rows[0]) : null;
    });
  }

  async listAgents(tenantId: number): Promise<GatewayAgentRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS} FROM fleet_agents
         WHERE tenant_id = $1 ORDER BY agent_id`,
        [tenantId],
      );
      return rows.map(toAgent);
    });
  }

  /**
   * Run counts per agent, keyed by `agentId` — the numbers the card on
   * `/app/agents` shows. Scoped to one agent when `agentId` is given, so the
   * detail page does not pay for every agent's aggregate to show its own.
   */
  async agentTaskStats(
    tenantId: number,
    agentId?: string,
  ): Promise<Map<string, AgentTaskStats>> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{
        target_agent_id: string;
        total: string;
        succeeded: string;
        failed: string;
        running: string;
        oldest_running: Date | null;
      }>(
        `SELECT target_agent_id,
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE outcome = 'succeeded') AS succeeded,
           COUNT(*) FILTER (WHERE outcome = 'failed') AS failed,
           COUNT(*) FILTER (WHERE outcome = 'running') AS running,
           MIN(created_at) FILTER (WHERE outcome = 'running') AS oldest_running
         FROM (
           SELECT target_agent_id, created_at,
             CASE
               WHEN state IN ('dispatching', 'running') THEN 'running'
               WHEN state IN ('failed', 'timed_out') THEN 'failed'
               -- A callback can settle a task into done/done_pending_notify while
               -- still reporting a downstream failure (result_json.state), so the
               -- ledger state alone is not enough to call it a success. A missing
               -- state (legacy rows, or callers that never set it) keeps the old
               -- done-means-succeeded behaviour.
               WHEN state IN ('done', 'done_pending_notify')
                 AND result_json->>'state' IS NOT NULL
                 AND result_json->>'state' <> 'completed' THEN 'failed'
               WHEN state IN ('done', 'done_pending_notify') THEN 'succeeded'
             END AS outcome
           FROM fleet_tasks
           WHERE tenant_id = $1 ${agentId ? "AND target_agent_id = $2" : ""}
         ) t
         GROUP BY target_agent_id`,
        agentId ? [tenantId, agentId] : [tenantId],
      );
      const stats = new Map<string, AgentTaskStats>();
      for (const row of rows) {
        stats.set(row.target_agent_id, {
          totalRuns: Number(row.total),
          succeeded: Number(row.succeeded),
          failed: Number(row.failed),
          running: Number(row.running),
          runningSince: iso(row.oldest_running),
        });
      }
      return stats;
    });
  }

  /**
   * Remove an agent. Its skills, tokens and outbound credential go with it
   * (ON DELETE CASCADE); its tasks do not, because `fleet_tasks` names agents
   * by text rather than by key — the ledger of what ran is not the registry's
   * to erase.
   */
  async deleteAgent(tenantId: number, agentId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM fleet_agents WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Every agent in this tenant offering `skillId`. Deliberately returns all
   * matches: the gateway never picks one on the caller's behalf (docs §6.1).
   */
  async findAgentsBySkill(
    tenantId: number,
    skillId: string,
  ): Promise<GatewayAgentRecord[]> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<AgentRow>(
        `SELECT ${AGENT_COLUMNS.split(",")
          .map((c) => `a.${c.trim()}`)
          .join(", ")}
         FROM fleet_agents a
         JOIN fleet_agent_skills s
           ON s.tenant_id = a.tenant_id AND s.agent_id = a.agent_id
         WHERE a.tenant_id = $1 AND s.skill_id = $2
         ORDER BY a.agent_id`,
        [tenantId, skillId],
      );
      return rows.map(toAgent);
    });
  }

  // ----------------------------------------------------------------- tokens

  async issueAgentToken(
    tenantId: number,
    agentId: string,
    tokenHash: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_agent_tokens (tenant_id, agent_id, token_hash)
       VALUES ($1, $2, $3)`,
      [tenantId, agentId, tokenHash],
    );
  }

  /**
   * Issue a replacement and retire everything before it, in one transaction.
   *
   * The order matters and so does the atomicity: revoking first would lock the
   * agent out if the insert then failed, and doing it in two statements would
   * leave a window where both the old and the new token work. A rotation is a
   * response to a leak often enough that the window is the point.
   */
  async rotateAgentToken(
    tenantId: number,
    agentId: string,
    newTokenHash: string,
  ): Promise<{ revoked: number }> {
    return this.withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE fleet_agent_tokens SET revoked_at = now()
         WHERE tenant_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
        [tenantId, agentId],
      );
      await client.query(
        `INSERT INTO fleet_agent_tokens (tenant_id, agent_id, token_hash)
         VALUES ($1, $2, $3)`,
        [tenantId, agentId, newTokenHash],
      );
      return { revoked: rowCount ?? 0 };
    });
  }

  async revokeAgentToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_agent_tokens SET revoked_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  /**
   * The caller's authoritative identity (docs §3.1, §4). A token names exactly
   * one (tenant, agent) pair; nothing in the request can widen that.
   */
  async resolveAgentToken(
    tokenHash: string,
  ): Promise<{ tenantId: number; agentId: string } | null> {
    const { rows } = await this.pool.query<{
      tenant_id: string;
      agent_id: string;
    }>(
      `SELECT tenant_id, agent_id FROM fleet_agent_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    return rows.length > 0
      ? { tenantId: Number(rows[0].tenant_id), agentId: rows[0].agent_id }
      : null;
  }

  // ------------------------------------------------------- outbound creds

  /**
   * What the gateway presents when calling this agent. Sealed before it
   * reaches the database, so a dump alone does not yield working credentials
   * for every registered agent (docs §4).
   */
  async putAgentCredential(
    tenantId: number,
    agentId: string,
    credential: AgentCredential,
  ): Promise<void> {
    const box = this.requireSecretBox();
    const sealed = box.seal(
      JSON.stringify({
        secret: credential.secret,
        ...(credential.headerName ? { headerName: credential.headerName } : {}),
      }),
    );
    await this.pool.query(
      `INSERT INTO fleet_agent_credentials (tenant_id, agent_id, scheme, secret_enc)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
         scheme = EXCLUDED.scheme,
         secret_enc = EXCLUDED.secret_enc,
         updated_at = now()`,
      [tenantId, agentId, credential.scheme, sealed],
    );
  }

  async getAgentCredential(
    tenantId: number,
    agentId: string,
  ): Promise<AgentCredential | null> {
    const { rows } = await this.pool.query<{
      scheme: AgentCredential["scheme"];
      secret_enc: Buffer;
    }>(
      `SELECT scheme, secret_enc FROM fleet_agent_credentials
       WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId],
    );
    if (rows.length === 0) return null;
    const box = this.requireSecretBox();
    const opened = JSON.parse(box.open(rows[0].secret_enc)) as {
      secret: string;
      headerName?: string;
    };
    return {
      scheme: rows[0].scheme,
      secret: opened.secret,
      ...(opened.headerName ? { headerName: opened.headerName } : {}),
    };
  }

  /** An agent that stopped wanting authentication. The row is dropped rather
   *  than blanked: an empty secret would still send an empty header. */
  async deleteAgentCredential(tenantId: number, agentId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM fleet_agent_credentials WHERE tenant_id = $1 AND agent_id = $2`,
      [tenantId, agentId],
    );
  }

  private requireSecretBox(): SecretBox {
    if (!this.secretBox) {
      throw new Error(
        "GatewayStore was constructed without a secretBox; agent credentials cannot be read or written",
      );
    }
    return this.secretBox;
  }

  // ------------------------------------------------------------------ tasks

  async createTask(input: CreateTaskInput): Promise<FleetTaskRecord> {
    const { rows } = await this.pool.query<TaskRow>(
      `INSERT INTO fleet_tasks
         (tenant_id, upstream_task_id, caller_agent_id, caller_callback_url,
          caller_callback_auth, target_agent_id, skill_id, state, deadline_at,
          workflow_run_id, workflow_from_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'dispatching', $8, $9, $10)
       RETURNING ${TASK_COLUMNS}`,
      [
        input.tenantId,
        input.upstreamTaskId,
        input.callerAgentId,
        input.callerCallbackUrl ?? null,
        input.callerCallbackAuth
          ? JSON.stringify(input.callerCallbackAuth)
          : null,
        input.targetAgentId,
        input.skillId,
        input.deadlineAt,
        input.workflowRunId ?? null,
        input.workflowFromState ?? null,
      ],
    );
    return toTask(rows[0]);
  }

  async getTask(taskId: number): Promise<FleetTaskRecord | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM fleet_tasks WHERE id = $1`,
      [taskId],
    );
    return rows.length > 0 ? toTask(rows[0]) : null;
  }

  async getTaskByUpstreamId(
    tenantId: number,
    upstreamTaskId: string,
  ): Promise<FleetTaskRecord | null> {
    return this.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<TaskRow>(
        `SELECT ${TASK_COLUMNS} FROM fleet_tasks
         WHERE tenant_id = $1 AND upstream_task_id = $2`,
        [tenantId, upstreamTaskId],
      );
      return rows.length > 0 ? toTask(rows[0]) : null;
    });
  }

  /**
   * Dispatch never got off the ground. The caller learns this synchronously
   * from the JSON-RPC error, so `notified_at` is stamped here to keep the row
   * out of the notify queue.
   */
  async failTask(taskId: number, result: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_tasks
       SET state = 'failed', result_json = $2,
           notified_at = now(), callback_token_hash = NULL, updated_at = now()
       WHERE id = $1 AND state NOT IN ('done', 'failed', 'timed_out', 'cancelled')`,
      [taskId, JSON.stringify(result)],
    );
  }

  /** Step ② committed: the downstream accepted, and the callback is armed. */
  async attachDownstream(
    taskId: number,
    input: { downstreamTaskId: string; callbackTokenHash: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_tasks
       SET downstream_task_id = $2, callback_token_hash = $3,
           state = 'running', updated_at = now()
       WHERE id = $1 AND state = 'dispatching'`,
      [taskId, input.downstreamTaskId, input.callbackTokenHash],
    );
  }

  /**
   * Resolve an inbound callback (docs §9.3). This runs before the tenant is
   * known — the token is the only thing the request carries — so it is the one
   * lookup that cannot be tenant-scoped up front. It is narrow by
   * construction: exact hash match, live task only. A replayed callback on a
   * finished task resolves to nothing.
   */
  async resolveCallbackToken(
    tokenHash: string,
  ): Promise<FleetTaskRecord | null> {
    const { rows } = await this.pool.query<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM fleet_tasks
       WHERE callback_token_hash = $1
         AND state NOT IN ('done', 'failed', 'timed_out', 'cancelled')`,
      [tokenHash],
    );
    return rows.length > 0 ? toTask(rows[0]) : null;
  }

  /** Step ③: the downstream reported back; the caller has not been told yet. */
  async recordDownstreamResult(
    taskId: number,
    result: unknown,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_tasks
       SET result_json = $2, state = 'done_pending_notify', updated_at = now()
       WHERE id = $1 AND state = 'running'`,
      [taskId, JSON.stringify(result)],
    );
  }

  /**
   * Step ④ succeeded. A success settles into `done`; a timeout or failure
   * keeps its outcome and is merely marked delivered.
   */
  async markNotified(taskId: number): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_tasks
       SET state = CASE WHEN state = 'done_pending_notify' THEN 'done' ELSE state END,
           notified_at = now(),
           next_retry_at = NULL,
           callback_token_hash = NULL,
           updated_at = now()
       WHERE id = $1 AND notified_at IS NULL`,
      [taskId],
    );
  }

  /**
   * Claim tasks whose caller still needs telling (step ④), bumping `attempt`
   * so a crashed worker's rows come back on the next pass.
   *
   * `FOR UPDATE SKIP LOCKED` is the whole point: the old SQLite store did a
   * bare SELECT-then-UPDATE and was correct only because one writer existed
   * (docs §8.1). With several site instances that shape hands the same row to
   * two workers and the caller gets notified twice.
   */
  async claimDueNotifications(
    now: Date,
    limit: number,
  ): Promise<FleetTaskRecord[]> {
    return this.withTransaction(async (client) => {
      // Success and timeout both owe the caller an answer, so the queue keys
      // off `notified_at`, not off the task's outcome.
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM fleet_tasks
         WHERE state IN ('done_pending_notify', 'timed_out', 'failed')
           AND notified_at IS NULL
           AND caller_callback_url IS NOT NULL
           -- A workflow-owned step is claimed by the driver instead; both
           -- consuming it would advance the run and POST a webhook.
           AND workflow_run_id IS NULL
           AND (next_retry_at IS NULL OR next_retry_at <= $1)
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const updated = await client.query<TaskRow>(
        `UPDATE fleet_tasks
         SET attempt = attempt + 1, next_retry_at = NULL, updated_at = now()
         WHERE id = ANY($1::bigint[])
         RETURNING ${TASK_COLUMNS}`,
        [ids],
      );
      return updated.rows.map(toTask);
    });
  }

  /** Step ④ failed; try again after `nextRetryAt`. */
  async recordNotifyFailure(
    taskId: number,
    nextRetryAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_tasks
       SET next_retry_at = $2, updated_at = now()
       WHERE id = $1 AND notified_at IS NULL`,
      [taskId, nextRetryAt],
    );
  }

  /**
   * Step ④ has exhausted its budget. The task's own outcome is untouched —
   * if the downstream succeeded, the work succeeded and `tasks/get` must keep
   * saying so; only delivery gave up (docs §8, reconciliation).
   */
  async abandonNotification(taskId: number): Promise<void> {
    await this.pool.query(
      `UPDATE fleet_tasks
       SET state = CASE WHEN state = 'done_pending_notify' THEN 'done' ELSE state END,
           notified_at = now(),
           next_retry_at = NULL,
           callback_token_hash = NULL,
           updated_at = now()
       WHERE id = $1 AND notified_at IS NULL`,
      [taskId],
    );
  }

  /**
   * Tasks the downstream never reported on. Same SKIP LOCKED discipline, and
   * the transition happens in the claim so a task can only time out once.
   */
  async claimExpired(now: Date, limit: number): Promise<FleetTaskRecord[]> {
    return this.withTransaction(async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM fleet_tasks
         WHERE state IN ('dispatching', 'running')
           AND deadline_at <= $1
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      if (rows.length === 0) return [];
      const updated = await client.query<TaskRow>(
        `UPDATE fleet_tasks
         SET state = 'timed_out', callback_token_hash = NULL, updated_at = now()
         WHERE id = ANY($1::bigint[])
         RETURNING ${TASK_COLUMNS}`,
        [rows.map((r) => r.id)],
      );
      return updated.rows.map(toTask);
    });
  }

  /**
   * Deliberately unscoped, for the cross-tenant background workers and for
   * asserting that the owner role still bypasses RLS (docs §8).
   */
  async listAllAgentIdsUnscoped(): Promise<string[]> {
    const { rows } = await this.pool.query<{ agent_id: string }>(
      "SELECT agent_id FROM fleet_agents",
    );
    return rows.map((r) => r.agent_id);
  }

  /** The composition layer's store, sharing this pool and tenant context. */
  workflows(): WorkflowStore {
    return new WorkflowStore({
      pool: this.pool,
      withTenant: (tenantId, fn) => this.withTenant(tenantId, fn),
    });
  }

  async appendTaskEvent(input: {
    tenantId: number;
    taskId: number;
    eventType: string;
    payload: unknown;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO fleet_task_events (tenant_id, task_id, event_type, payload)
       VALUES ($1, $2, $3, $4)`,
      [
        input.tenantId,
        input.taskId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
  }
}
