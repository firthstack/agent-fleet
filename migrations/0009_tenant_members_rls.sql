-- fleet_tenant_members 补上 RLS 与授权（docs/fleet-console.md §9.1 第 6 层）
--
-- 0005 的 GRANT ... ON ALL TABLES 是一次性快照，而这张表是 0008 才建的，
-- 于是它既没授权给 fleet_app，也没有 tenant_isolation 策略。今天不漏数据——
-- fleet_app 连 SELECT 权限都没有——但这是"拿不到"而不是"被隔离"，第一个在
-- withTenant 里读成员表的调用会撞上权限错误，而不是拿到自己那行。
--
-- auth_* 那四张表的情况不同：它们不归任何租户所有，0008 里刻意排除，这里
-- 继续排除。

GRANT SELECT, INSERT, UPDATE, DELETE ON fleet_tenant_members TO fleet_app;

-- 和 0003 一样只 ENABLE、不 FORCE：属主（postgres）要能跨租户扫表，登录后
-- 按 user_id 找租户这条路径正是在切进租户上下文之前跑的。
ALTER TABLE fleet_tenant_members ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  expr text := 'NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint';
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON fleet_tenant_members';
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON fleet_tenant_members USING (tenant_id = %s) WITH CHECK (tenant_id = %s)',
    expr, expr
  );
END
$$;
