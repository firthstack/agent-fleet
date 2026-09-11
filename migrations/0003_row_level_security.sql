-- 第 6 层兜底：Postgres RLS（docs §9.1）
--
-- 前五层都是「某个查询别忘了加 WHERE tenant_id」。靠人肉保证每个数据访问
-- 方法都不漏，迟早会漏一次，而这类疏漏直接等于跨租户数据泄漏。
--
-- 一个前提必须先解决：应用以 postgres 连接，而它既是超级用户（BYPASSRLS）
-- 又是表属主 —— 对这个角色，RLS 策略是完全不生效的。光加策略等于自欺。
--
-- 解法是一个专用低权角色 fleet_app。请求路径在事务里 SET LOCAL ROLE
-- fleet_app，策略随即生效；事务结束自动还原。连接串不用改，因此
-- InstaCloud 的 DATABASE_URL 绑定保持原样。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fleet_app') THEN
    -- NOLOGIN：这个角色只能通过 SET ROLE 进入，不能直接建连接。
    CREATE ROLE fleet_app NOLOGIN;
  END IF;
END
$$;

-- current_schema() rather than a hardcoded `public`, so the migration replays
-- into a test schema as faithfully as it ran against the deployed database.
DO $$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO fleet_app', s);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO fleet_app', s);
  EXECUTE format(
    'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO fleet_app', s);
END
$$;

-- 每张带 tenant_id 的表：启用 RLS，并用同一条策略。
-- current_setting(..., true) 在未设置时返回 NULL，而 tenant_id = NULL 恒为
-- NULL，于是「忘了设置租户」的结果是查不到任何行 —— 失败方向是保守的。
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fleet_users', 'fleet_agents', 'fleet_agent_skills',
    'fleet_agent_tokens', 'fleet_agent_credentials',
    'fleet_tasks', 'fleet_task_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING '
      '(tenant_id = current_setting(''app.tenant_id'', true)::bigint) '
      'WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::bigint)',
      t
    );
  END LOOP;
END
$$;

-- tenants 自身：租户只能看到自己那一行。
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = current_setting('app.tenant_id', true)::bigint);

-- 属主（postgres）刻意不加 FORCE ROW LEVEL SECURITY：后台的通知重试与超时
-- 清扫本来就是跨租户扫描（docs §8），它们以属主身份运行是正确的，不是漏洞。
-- 两条按 token 反查的路径同理，它们必须先查到行才知道租户是谁：
--   - resolveAgentToken   —— 请求的租户身份就是它查出来的
--   - resolveCallbackToken —— 回调端点无会话（docs §9.3）
-- 这两个查询都是精确 hash 匹配且只取所需字段。
