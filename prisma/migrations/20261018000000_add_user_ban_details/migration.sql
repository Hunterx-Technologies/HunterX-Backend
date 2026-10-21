-- AlterTable
-- Admin ban audit trail. users.is_banned stays the single source of truth
-- for enforcement (auth middleware, login/refresh, leaderboards, crons);
-- these columns only record why/when/by whom, and are cleared on unban.
ALTER TABLE "users" ADD COLUMN     "ban_reason" VARCHAR(500),
ADD COLUMN     "banned_at" TIMESTAMP(6),
ADD COLUMN     "banned_by" BIGINT;
