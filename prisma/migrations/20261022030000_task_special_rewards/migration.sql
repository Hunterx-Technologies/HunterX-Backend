-- Special rewards: a reward_triggers row of kind TASK, linked from any
-- number of tasks. Completing a linked task grants one scratch card from
-- it (user_rewards.period = the task id). See rewardService.js.
ALTER TYPE "reward_trigger_kind" ADD VALUE 'TASK';

ALTER TABLE "tasks" ADD COLUMN "special_reward_id" BIGINT;
CREATE INDEX "idx_tasks_special_reward" ON "tasks"("special_reward_id") WHERE "special_reward_id" IS NOT NULL;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_special_reward_id_fkey" FOREIGN KEY ("special_reward_id") REFERENCES "reward_triggers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
