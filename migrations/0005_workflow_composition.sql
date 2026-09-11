-- 组合层（docs/fleet-composition-layer.md §5.2）
--
-- 关键设计：workflow 的推进复用通知队列**同一套**认领机制。一个属于
-- workflow 的任务完成后，不是去打调用方的 webhook，而是驱动状态机往前走。
-- 于是退避重试、超时、幂等、SKIP LOCKED 并发安全全部直接继承，组合层自己
-- 一行可靠性代码都不用写。

CREATE TABLE IF NOT EXISTS fleet_workflows (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  version    INT  NOT NULL,
  definition JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 在途的 run 绑定具体版本，改版不影响它们（§6）
  UNIQUE (tenant_id, name, version)
);

CREATE TABLE IF NOT EXISTS fleet_workflow_runs (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_id BIGINT NOT NULL REFERENCES fleet_workflows(id) ON DELETE RESTRICT,
  state       TEXT NOT NULL,          -- 当前状态名
  status      TEXT NOT NULL,          -- 状态声明的 status
  -- reason 提为一等列。旧实现把它埋在 result 的 JSONB 里，靠 resultReason()
  -- 挖出来；而 resume 规则要按它判断，它需要可查询（§4.3）
  reason      TEXT,
  vars        JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type TEXT NOT NULL,
  source_ref  TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 重投递的派发不能开出第二个 run（定义里的 dedupeBy）
  UNIQUE (tenant_id, source_type, source_ref)
);

CREATE INDEX IF NOT EXISTS fleet_workflow_runs_by_workflow
  ON fleet_workflow_runs (tenant_id, workflow_id, updated_at DESC);

-- 状态变迁流水。运行观察器要的就是这张表（§6）
CREATE TABLE IF NOT EXISTS fleet_workflow_run_events (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  BIGINT NOT NULL,
  run_id     BIGINT NOT NULL REFERENCES fleet_workflow_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fleet_workflow_run_events_by_run
  ON fleet_workflow_run_events (run_id, id);

-- 任务归属：有这一列就说明完成后该推进状态机，而不是打 webhook
ALTER TABLE fleet_tasks
  ADD COLUMN IF NOT EXISTS workflow_run_id BIGINT
    REFERENCES fleet_workflow_runs(id) ON DELETE SET NULL;

-- 认领待推进的任务，与通知队列同构
CREATE INDEX IF NOT EXISTS fleet_tasks_workflow_scan
  ON fleet_tasks (state, next_retry_at)
  WHERE workflow_run_id IS NOT NULL AND notified_at IS NULL;

-- RLS，与 0003/0004 保持一致
DO $$
DECLARE
  t text;
  expr text := 'NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fleet_workflows', 'fleet_workflow_runs', 'fleet_workflow_run_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = %s) WITH CHECK (tenant_id = %s)',
      t, expr, expr
    );
  END LOOP;

  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO fleet_app',
    current_schema());
  EXECUTE format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO fleet_app', current_schema());
END
$$;
