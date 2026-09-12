-- 给健康巡检的探测写入加一个乐观并发令牌（docs §5 step 5）。
--
-- 巡检先枚举全部 agent 再逐个探测，探测在途时租户可能编辑或删除同一行。
-- 巡检的写回如果是无条件 upsert，就会用枚举时的旧快照盖掉那次编辑，或者在
-- 行已被删除之后把它连同已级联清空的 token/credential 一起插回来。这里加
-- 一列递增版本号，写回时按「版本号仍是探测时看到的那个」为条件更新，不匹配
-- 就放弃，从不插入。
--
-- 没有用 updated_at 本身做这个令牌：它是 TIMESTAMPTZ，Postgres 端是微秒精度，
-- 而 JS 端 toISOString() 只有毫秒精度，经过序列化再传回来做等值比较几乎总是
-- 对不上。独立的整数计数器没有这个坑。

ALTER TABLE fleet_agents
  ADD COLUMN IF NOT EXISTS probe_version BIGINT NOT NULL DEFAULT 1;
