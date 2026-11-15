-- The IST day the app last showed the "Day Complete" screen, so it shows
-- once per day per account (not per device or login). Additive.

-- AlterTable
ALTER TABLE "user_progression" ADD COLUMN "day_complete_seen_date" DATE;
