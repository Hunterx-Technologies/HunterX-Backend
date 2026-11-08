-- Index cleanup (no data or behaviour change).
--
-- 1. Duplicate indexes: each of these columns also has a UNIQUE index on
--    exactly the same columns, which serves every lookup.
-- 2. Redundant indexes: their column is the leading column of a UNIQUE
--    index on the same table.
-- 3. Missing indexes on foreign-key columns that are filtered on, or
--    checked when a referenced row is deleted (account deletion, admin
--    deletes of tasks / reward triggers / coupon pools / badges / quotes).
--
-- IF [NOT] EXISTS keeps it safe on a database whose indexes have drifted.

-- DropIndex
DROP INDEX IF EXISTS "idx_matches_user_a";

-- DropIndex
DROP INDEX IF EXISTS "idx_swipes_swiper";

-- DropIndex
DROP INDEX IF EXISTS "idx_dragon_stage_number";

-- DropIndex
DROP INDEX IF EXISTS "idx_health_user_date";

-- DropIndex
DROP INDEX IF EXISTS "idx_health_metrics_daily_user_date";

-- DropIndex
DROP INDEX IF EXISTS "idx_task_admin_targets_task";

-- DropIndex
DROP INDEX IF EXISTS "idx_dragon_evolutions_user";

-- DropIndex
DROP INDEX IF EXISTS "idx_onboarding_answers_user";

-- DropIndex
DROP INDEX IF EXISTS "idx_streak_milestones_user";

-- DropIndex
DROP INDEX IF EXISTS "idx_users_email";

-- DropIndex
DROP INDEX IF EXISTS "idx_users_hunter_id";

-- DropIndex
DROP INDEX IF EXISTS "idx_users_referral_code";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_admin_user_actions_admin" ON "admin_user_actions"("admin_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_matches_unmatched_by" ON "discovery_matches"("unmatched_by");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_messages_sender" ON "messages"("sender_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_notifications_quote" ON "notifications"("quote_id") WHERE (quote_id IS NOT NULL);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_task_admin_targets_user" ON "task_admin_targets"("user_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_user_badges_badge" ON "user_badges"("badge_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_user_rewards_trigger" ON "user_rewards"("trigger_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_user_rewards_pool" ON "user_rewards"("pool_id");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_xp_transactions_task" ON "xp_transactions"("task_id");

