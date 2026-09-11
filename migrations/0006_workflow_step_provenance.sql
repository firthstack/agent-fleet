-- 两个字段是上一轮修 bug 时引入的，补上对应的列。
--
-- workflow_from_state：推进的依据必须是任务自己记录的来源状态，而不是 run
-- 的当前状态。run 行在派发**之前**写（这样卡住的步骤在观察器上可见），于是
-- 派发失败时 run 会比被重试的任务领先一个状态，按 run 恢复就会从错的地方
-- 继续往下走。
--
-- awaiting_task_id：网关是至少一次投递，同一个完成回调可能到两次。run 只
-- 认它当前在等的那个任务，陈旧的完成直接跳过——否则一个需求会开出两个 PR。

ALTER TABLE fleet_tasks
  ADD COLUMN IF NOT EXISTS workflow_from_state TEXT;

ALTER TABLE fleet_workflow_runs
  ADD COLUMN IF NOT EXISTS awaiting_task_id BIGINT;
