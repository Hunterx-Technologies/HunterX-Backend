-- AlterTable
-- "Show me on leaderboards" toggle — defaults to visible so existing
-- users aren't silently hidden from global/genz when this ships.
ALTER TABLE "user_settings" ADD COLUMN     "leaderboard_visible" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
-- Backs the Postgres fallback path for the global/genz leaderboard
-- scopes (ORDER BY total_xp DESC, user_id ASC) when Redis is down.
CREATE INDEX "idx_user_progression_leaderboard" ON "user_progression"("total_xp" DESC, "user_id");

-- CreateIndex
-- Backs the friends leaderboard scope's referrer lookup
-- (users.referred_by -> who referred me).
CREATE INDEX "idx_users_referred_by" ON "users"("referred_by");
