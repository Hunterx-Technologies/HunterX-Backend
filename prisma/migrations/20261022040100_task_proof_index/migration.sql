-- Admin review queue: oldest IN_REVIEW submissions first. Separate from
-- the previous migration because Postgres can't use an enum value in the
-- same transaction that adds it.
CREATE INDEX "idx_completions_in_review" ON "task_completions"("proof_submitted_at") WHERE (status = 'IN_REVIEW'::completion_status);
