-- 把「调用方是否已被通知」与「任务结局」解耦。
--
-- 0001 里通知队列只认 done_pending_notify，于是被 sweeper 判为 timed_out 的
-- 任务永远不会被通知，上游一直等一个不会来的回复（docs §8「超时清扫」要求
-- 判定之后必须通知上游）。失败和超时同样需要送达，所以送达状态需要独立于
-- 任务结局单独记录。

ALTER TABLE fleet_tasks
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

DROP INDEX IF EXISTS fleet_tasks_retry_scan;

-- 通知队列：需要告知调用方、且尚未送达的任务，无论结局是成功还是超时。
CREATE INDEX IF NOT EXISTS fleet_tasks_notify_scan
  ON fleet_tasks (state, next_retry_at)
  WHERE notified_at IS NULL;
