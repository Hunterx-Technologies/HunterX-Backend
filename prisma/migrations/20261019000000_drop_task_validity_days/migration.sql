-- Paid task access now runs from the purchase day to tasks.end_date, so a
-- separate validity length is no longer needed.
-- AlterTable
ALTER TABLE "tasks" DROP COLUMN "validity_days";
