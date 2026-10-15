-- Push notification infrastructure (Phases 1–6).
--
-- * notifications becomes a push outbox: rows are written PENDING inside the
--   caller's transaction and delivered after commit by the dispatcher cron.
-- * user_fcm_tokens (never written by any code path) is replaced by
--   user_push_tokens — one row per device, keyed on the Expo push token.
-- * user_settings gains timezone + reminder_time for local-time scheduling,
--   and notify_social / notify_leaderboard toggles.
-- * notification_type gains NEW_QUEST, FRIEND_JOINED, LEADERBOARD_UPDATE,
--   FEEDBACK_UPDATE, HEALTH_SYNC, WIN_BACK.
-- * leaderboard_rank_snapshots backs the daily leaderboard digest.

-- CreateEnum
CREATE TYPE "push_platform" AS ENUM ('IOS', 'ANDROID');

-- CreateEnum
CREATE TYPE "push_status" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "notification_type" ADD VALUE 'NEW_QUEST';
ALTER TYPE "notification_type" ADD VALUE 'FRIEND_JOINED';
ALTER TYPE "notification_type" ADD VALUE 'LEADERBOARD_UPDATE';
ALTER TYPE "notification_type" ADD VALUE 'FEEDBACK_UPDATE';
ALTER TYPE "notification_type" ADD VALUE 'HEALTH_SYNC';
ALTER TYPE "notification_type" ADD VALUE 'WIN_BACK';

-- DropForeignKey
ALTER TABLE "user_fcm_tokens" DROP CONSTRAINT "user_fcm_tokens_user_id_fkey";

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupe_key" VARCHAR(100),
ADD COLUMN     "deliver_after" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "push_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "push_claim" VARCHAR(36),
ADD COLUMN     "push_claimed_at" TIMESTAMP(6),
ADD COLUMN     "push_error" VARCHAR(500),
ADD COLUMN     "push_status" "push_status" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "pushed_at" TIMESTAMP(6);

-- AlterTable
ALTER TABLE "user_settings" ADD COLUMN     "notify_leaderboard" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notify_social" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reminder_time" VARCHAR(5) NOT NULL DEFAULT '19:00',
ADD COLUMN     "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Kolkata';

-- DropTable
DROP TABLE "user_fcm_tokens";

-- DropEnum
DROP TYPE "fcm_platform";

-- CreateTable
CREATE TABLE "leaderboard_rank_snapshots" (
    "user_id" BIGINT NOT NULL,
    "global_rank" INTEGER,
    "friends_rank" INTEGER,
    "updated_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "leaderboard_rank_snapshots_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "push_receipts" (
    "id" BIGSERIAL NOT NULL,
    "ticket_id" VARCHAR(64) NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "notification_id" BIGINT,
    "created_at" TIMESTAMP(6) NOT NULL,

    CONSTRAINT "push_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_push_tokens" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "token" VARCHAR(500) NOT NULL,
    "platform" "push_platform" NOT NULL,
    "app_version" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_receipts_ticket_id_key" ON "push_receipts"("ticket_id");

-- CreateIndex
CREATE INDEX "idx_push_receipts_created" ON "push_receipts"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_push_tokens_token_key" ON "user_push_tokens"("token");

-- CreateIndex
CREATE INDEX "idx_user_push_tokens_user" ON "user_push_tokens"("user_id");

-- CreateIndex
CREATE INDEX "idx_notifications_push_queue" ON "notifications"("push_status", "deliver_after");

-- CreateIndex
CREATE UNIQUE INDEX "uq_notifications_user_dedupe" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "leaderboard_rank_snapshots" ADD CONSTRAINT "leaderboard_rank_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_push_tokens" ADD CONSTRAINT "user_push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- Backfill: everything that existed before this migration is history, not a
-- send queue — don't push it the moment the dispatcher starts.
UPDATE "notifications" SET "push_status" = 'SKIPPED', "push_error" = 'pre_push_backfill';
