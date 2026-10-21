-- A buyer who COMPLETES a paid task has it closed for them: it's no longer
-- assigned, listed, or offered for purchase again.
-- AlterTable
ALTER TABLE "task_purchases" ADD COLUMN "completed_at" TIMESTAMP(6);
