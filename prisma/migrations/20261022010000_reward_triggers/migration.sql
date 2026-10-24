-- Scratch cards for level-ups and birthdays as well as streaks: coupons
-- hang off a reward_triggers row (STREAK n days / LEVEL_UP level n /
-- BIRTHDAY) instead of a streak_milestones row. See rewardService.js.

CREATE TYPE "reward_trigger_kind" AS ENUM ('STREAK', 'LEVEL_UP', 'BIRTHDAY');

ALTER TYPE "reward_trigger" ADD VALUE 'BIRTHDAY';

CREATE TABLE "reward_triggers" (
    "id" BIGSERIAL NOT NULL,
    "kind" "reward_trigger_kind" NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "description" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_triggers_pkey" PRIMARY KEY ("id"),
    -- value: streak days / level number (>= 1); birthday has none (0).
    CONSTRAINT "reward_triggers_value_chk" CHECK (("kind" = 'BIRTHDAY' AND "value" = 0) OR ("kind" <> 'BIRTHDAY' AND "value" >= 1))
);

CREATE UNIQUE INDEX "reward_triggers_kind_value_key" ON "reward_triggers"("kind", "value");

-- There's only ever one birthday trigger; it's here from the start so the
-- admin only has to add coupons to it.
INSERT INTO "reward_triggers" ("kind", "value", "description") VALUES ('BIRTHDAY', 0, 'Birthday');

-- Every streak milestone that already has coupons or cards becomes a
-- STREAK trigger for the same number of days.
INSERT INTO "reward_triggers" ("kind", "value", "description")
SELECT 'STREAK', sm."streak_days", sm."description"
FROM "streak_milestones" sm
WHERE EXISTS (SELECT 1 FROM "reward_coupons" rc WHERE rc."milestone_id" = sm."id")
   OR EXISTS (SELECT 1 FROM "user_rewards" ur WHERE ur."milestone_id" = sm."id");

-- Coupons move to their trigger.
ALTER TABLE "reward_coupons" ADD COLUMN "trigger_id" BIGINT;
UPDATE "reward_coupons" rc SET "trigger_id" = rt."id"
FROM "streak_milestones" sm, "reward_triggers" rt
WHERE sm."id" = rc."milestone_id" AND rt."kind" = 'STREAK' AND rt."value" = sm."streak_days";
ALTER TABLE "reward_coupons" ALTER COLUMN "trigger_id" SET NOT NULL;

ALTER TABLE "reward_coupons" DROP CONSTRAINT "reward_coupons_milestone_id_fkey";
DROP INDEX "idx_reward_coupons_milestone";
ALTER TABLE "reward_coupons" DROP COLUMN "milestone_id";
CREATE INDEX "idx_reward_coupons_trigger" ON "reward_coupons"("trigger_id", "is_active");
ALTER TABLE "reward_coupons" ADD CONSTRAINT "reward_coupons_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "reward_triggers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Cards move to their trigger. period lets a trigger fire again later:
-- the birthday card uses the year; streak and level cards stay 0 (once ever).
ALTER TABLE "user_rewards" ADD COLUMN "trigger_id" BIGINT,
ADD COLUMN "period" INTEGER NOT NULL DEFAULT 0;
UPDATE "user_rewards" ur SET "trigger_id" = rt."id"
FROM "streak_milestones" sm, "reward_triggers" rt
WHERE sm."id" = ur."milestone_id" AND rt."kind" = 'STREAK' AND rt."value" = sm."streak_days";

ALTER TABLE "user_rewards" DROP CONSTRAINT "user_rewards_milestone_id_fkey";
DROP INDEX "uq_user_rewards_user_milestone";
ALTER TABLE "user_rewards" DROP COLUMN "milestone_id";

-- One card per user per trigger per period, whatever retries or races happen.
CREATE UNIQUE INDEX "uq_user_rewards_user_trigger" ON "user_rewards"("user_id", "trigger_id", "period") WHERE (trigger_id IS NOT NULL);
ALTER TABLE "user_rewards" ADD CONSTRAINT "user_rewards_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "reward_triggers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Birthday rewards wait 30 days after a date-of-birth change, so editing
-- it to today doesn't pay out. Null = set before this was tracked.
ALTER TABLE "users" ADD COLUMN "dob_updated_at" TIMESTAMP(6);
