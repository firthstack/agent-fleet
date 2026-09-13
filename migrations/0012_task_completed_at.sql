-- 记录任务「执行完成」的时刻，与「通知完成」解耦（PR #13 复审意见）。
--
-- agentTaskStats 用 updated_at 挑「最近一次完成的任务」并算耗时，但
-- claimDueNotifications / recordNotifyFailure / markNotified /
-- abandonNotification 在任务执行结束之后，为了推进通知投递，还会继续
-- 改写同一行的 updated_at。于是任务 A 先结束，任务 B 后结束，A 的通知
-- 重试晚于 B 的执行完成发生时，updated_at 排序会把 A 显示成"最近一次
-- 运行"，耗时里也混进了通知重试的等待时间。
--
-- completed_at 只在执行真正结束的三处写入一次：downstream 报告结果
-- （recordDownstreamResult）、派发本身失败（failTask）、以及被判定超时
-- （claimExpired 把状态转成 timed_out）。此后的通知相关写入都不会碰它。

ALTER TABLE fleet_tasks
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- 已有的行都已经执行完成过，用 updated_at 回填——这是当下能拿到的最接近的
-- 时间点，此后的写入不会再覆盖它。仍在 dispatching/running 的行留 NULL。
UPDATE fleet_tasks
SET completed_at = updated_at
WHERE completed_at IS NULL
  AND state IN ('done', 'done_pending_notify', 'failed', 'timed_out');

-- agentTaskStats 只要每个 agent「最近完成的一行」，不需要把某个 agent 全部
-- 完成时间戳都聚合排序一遍；这个索引让那次查找直接按顺序扫到即可，不用
-- 现场排序或物化数组。
CREATE INDEX IF NOT EXISTS fleet_tasks_last_completed
  ON fleet_tasks (tenant_id, target_agent_id, completed_at DESC)
  WHERE completed_at IS NOT NULL;
