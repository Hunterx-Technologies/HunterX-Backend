-- One row per XP award that raised the user's level (xpService.js#checkLevelUp),
-- whatever paid the XP: a quest, an approved proof, a referral. The app shows
-- the level-up screen for it once (straight from the completion response, or
-- on next open) and marks it seen.
CREATE TABLE "level_up_events" (
    "id"         BIGSERIAL NOT NULL,
    "user_id"    BIGINT NOT NULL,
    "from_level" INTEGER NOT NULL,
    "to_level"   INTEGER NOT NULL,
    "xp_earned"  INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_at"    TIMESTAMP(6),

    CONSTRAINT "level_up_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "level_up_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "idx_level_up_events_unseen" ON "level_up_events"("user_id") WHERE "seen_at" IS NULL;
