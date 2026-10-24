-- Proof tasks: an admin can require 1–5 photos to complete a task. The
-- hunter's submission is reviewed (approve / ask to resubmit / reject)
-- before XP is paid. See taskProofService.js.
ALTER TYPE "completion_status" ADD VALUE 'IN_REVIEW';
ALTER TYPE "completion_status" ADD VALUE 'RESUBMIT';
ALTER TYPE "completion_status" ADD VALUE 'REJECTED';
ALTER TYPE "notification_type" ADD VALUE 'TASK_REVIEW';

ALTER TABLE "tasks" ADD COLUMN "proof_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_proof_count_chk" CHECK ("proof_count" BETWEEN 0 AND 5);

ALTER TABLE "task_completions"
  ADD COLUMN "proof_urls" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "proof_submitted_at" TIMESTAMP(6),
  ADD COLUMN "reviewed_at" TIMESTAMP(6),
  ADD COLUMN "reviewed_by" BIGINT,
  ADD COLUMN "review_note" VARCHAR(300);
