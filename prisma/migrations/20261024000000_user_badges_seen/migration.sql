-- When the app showed the badge's unlock popup (the home screen's streak
-- badge reveal). Null = not shown yet. Badges earned before this existed
-- count as shown, so nobody gets old badges replayed.
ALTER TABLE "user_badges" ADD COLUMN "seen_at" TIMESTAMP(6);
UPDATE "user_badges" SET "seen_at" = COALESCE("earned_at", CURRENT_TIMESTAMP);

CREATE INDEX "idx_user_badges_unseen" ON "user_badges"("user_id") WHERE "seen_at" IS NULL;
