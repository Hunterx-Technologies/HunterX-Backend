-- Routine is no longer set by hand: a free, recurring DAILY_ADMIN task is a
-- routine task (adminTaskService.js#buildTaskData). The built-in DAILY_FIXED
-- tasks stay routine.
UPDATE "tasks"
SET "is_routine" = ("task_type" = 'DAILY_ADMIN' AND "is_recurring" AND NOT "is_paid")
WHERE "task_type" <> 'DAILY_FIXED';
