-- 0003 的策略写成 current_setting('app.tenant_id', true)::bigint。
-- 当这个设置是空串时 —— set_config(..., NULL, ...) 的结果，也是会话重置后
-- 的状态 —— 这个转换会抛 "invalid input syntax for type bigint" 而不是得到
-- NULL。数据没泄漏，但策略的行为取决于一个会抛异常的类型转换，任何忘记设置
-- 租户的代码路径拿到的是 500 而不是干净的空结果。
--
-- NULLIF 把空串折成 NULL，于是 tenant_id = NULL 恒为 NULL，行被过滤掉。
-- 失败方向仍然保守，但现在是安静地保守。

DO $$
DECLARE
  t text;
  expr text := 'NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint';
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fleet_users', 'fleet_agents', 'fleet_agent_skills',
    'fleet_agent_tokens', 'fleet_agent_credentials',
    'fleet_tasks', 'fleet_task_events'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = %s) WITH CHECK (tenant_id = %s)',
      t, expr, expr
    );
  END LOOP;

  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON tenants';
  EXECUTE format('CREATE POLICY tenant_isolation ON tenants USING (id = %s)', expr);
END
$$;
