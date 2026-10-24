-- A streak life spent, or a streak broken, recorded the moment the backend
-- applies it (streakService.js#reconcileStreak / bumpDailyStreak). The app
-- shows each one once (the "streak life lost" card) and then marks it seen.
CREATE TYPE "streak_event_type" AS ENUM ('LIFE_USED', 'STREAK_BROKEN');

CREATE TABLE "streak_events" (
    "id"          BIGSERIAL NOT NULL,
    "user_id"     BIGINT NOT NULL,
    "type"        "streak_event_type" NOT NULL,
    "lives_lost"  INTEGER NOT NULL DEFAULT 0,
    "lives_left"  INTEGER NOT NULL DEFAULT 0,
    "streak_days" INTEGER NOT NULL DEFAULT 0,
    "created_at"  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seen_at"     TIMESTAMP(6),

    CONSTRAINT "streak_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "streak_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX "idx_streak_events_unseen" ON "streak_events"("user_id") WHERE "seen_at" IS NULL;
CREATE INDEX "idx_streak_events_user_created" ON "streak_events"("user_id", "created_at");
