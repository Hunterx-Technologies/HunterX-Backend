-- Friends between existing hunters (friendService.js): requests, friendships
-- and blocks. Additive: two new tables and two notification types. Existing
-- invite pairs (referrals / users.referred_by) are copied in as friendships,
-- so the Friends leaderboard keeps everyone it shows today.

-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'FRIEND_REQUEST';
ALTER TYPE "notification_type" ADD VALUE 'FRIEND_ACCEPTED';

-- CreateEnum
CREATE TYPE "friendship_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateTable
CREATE TABLE "friendships" (
    "id"           BIGSERIAL NOT NULL,
    "user_low"     BIGINT NOT NULL,
    "user_high"    BIGINT NOT NULL,
    "requested_by" BIGINT NOT NULL,
    "status"       "friendship_status" NOT NULL DEFAULT 'PENDING',
    "source"       VARCHAR(16) NOT NULL DEFAULT 'REQUEST',
    "created_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accepted_at"  TIMESTAMP(6),

    CONSTRAINT "friendships_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "friendships_pair_order" CHECK ("user_low" < "user_high")
);

-- CreateTable
CREATE TABLE "user_blocks" (
    "id"         BIGSERIAL NOT NULL,
    "blocker_id" BIGINT NOT NULL,
    "blocked_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uq_friendships_pair" ON "friendships"("user_low", "user_high");
CREATE INDEX "idx_friendships_low_status" ON "friendships"("user_low", "status");
CREATE INDEX "idx_friendships_high_status" ON "friendships"("user_high", "status");
CREATE INDEX "idx_friendships_requested_by" ON "friendships"("requested_by", "created_at");
CREATE UNIQUE INDEX "uq_user_blocks_pair" ON "user_blocks"("blocker_id", "blocked_id");
CREATE INDEX "idx_user_blocks_blocked" ON "user_blocks"("blocked_id");

-- AddForeignKey
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_low_fkey" FOREIGN KEY ("user_low") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_high_fkey" FOREIGN KEY ("user_high") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Backfill: every existing invite pair becomes an accepted friendship.
INSERT INTO "friendships" ("user_low", "user_high", "requested_by", "status", "source", "created_at", "updated_at", "accepted_at")
SELECT LEAST(p.inviter, p.invitee), GREATEST(p.inviter, p.invitee), p.inviter, 'ACCEPTED', 'INVITE', p.at, p.at, p.at
FROM (
    SELECT "referrer_id" AS inviter, "referred_id" AS invitee, COALESCE("created_at", CURRENT_TIMESTAMP) AS at
    FROM "referrals"
    UNION ALL
    SELECT "referred_by", "id", COALESCE("created_at", CURRENT_TIMESTAMP)
    FROM "users"
    WHERE "referred_by" IS NOT NULL
) p
WHERE p.inviter <> p.invitee
ON CONFLICT ("user_low", "user_high") DO NOTHING;
