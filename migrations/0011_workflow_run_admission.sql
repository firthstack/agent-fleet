-- 每租户并发上限：run 先记下来，拿到名额才派发。
--
-- 此前没有任何并发控制：POST /runs 在请求内同步派发，N 个并发提交就是 N 个
-- 立即派发（实测 5 次提交在 38ms 内全部压到同一个 agent 上）。原来那个
-- workflow agent 内部排队的行为，在把编排搬进平台时丢掉了。

ALTER TABLE fleet_workflow_runs
  -- 何时获得名额。NULL = 已受理但还在排队。
  ADD COLUMN IF NOT EXISTS admitted_at TIMESTAMPTZ,
  -- 启动时的原始 payload。排队的 run 要在拿到名额时算出**与立即启动完全相同**
  -- 的起始决策，而 vars 列存的是走完 start 转移之后的值——拿它重算会把转移里
  -- 的 set 应用第二次。
  ADD COLUMN IF NOT EXISTS input_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 已有的 run 都是立即启动的。不回填的话它们会被当成"在排队"，于是被第二次派发。
UPDATE fleet_workflow_runs SET admitted_at = created_at WHERE admitted_at IS NULL;

-- 排空器问两个问题：这个租户有几个在跑，以及它排队里最早的是哪个。
CREATE INDEX IF NOT EXISTS fleet_workflow_runs_queued
  ON fleet_workflow_runs (tenant_id, id)
  WHERE admitted_at IS NULL;

CREATE INDEX IF NOT EXISTS fleet_workflow_runs_live
  ON fleet_workflow_runs (tenant_id)
  WHERE admitted_at IS NOT NULL
    AND state NOT IN ('completed', 'failed', 'cancelled', 'needs_human');
