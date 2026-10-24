-- Rewards can be switched off like tasks: an inactive reward_triggers row
-- grants no new scratch cards (rewardService.js#grantTriggerCard).
ALTER TABLE "reward_triggers" ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT true;
