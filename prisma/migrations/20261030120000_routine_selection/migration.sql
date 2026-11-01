-- Routine tasks get their own flag, separate from is_default_daily, and each
-- hunter's choice per routine task becomes an explicit selected true/false.

-- 1. tasks.is_routine — optional per hunter. The built-in daily tasks
--    (sleep, water, protein, steps) start as routine.
ALTER TABLE "tasks" ADD COLUMN "is_routine" BOOLEAN NOT NULL DEFAULT false;
UPDATE "tasks" SET "is_routine" = true WHERE "is_default_daily" = true;

-- 2. user_routine_tasks.selected — the hunter's on/off choice. Existing rows
--    are picks, so they're selected.
ALTER TABLE "user_routine_tasks" ADD COLUMN "selected" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "user_routine_tasks" ADD COLUMN "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP;

-- 3. Hunters who picked some routine tasks: the rest are explicitly off.
INSERT INTO "user_routine_tasks" ("user_id", "task_id", "selected")
SELECT r."user_id", t."id", false
FROM (SELECT DISTINCT "user_id" FROM "user_routine_tasks") r
CROSS JOIN "tasks" t
WHERE t."is_routine" = true
ON CONFLICT ("user_id", "task_id") DO NOTHING;

-- 4. Hunters who never picked (accounts from before the picker) kept getting
--    every routine task — record that as all selected.
INSERT INTO "user_routine_tasks" ("user_id", "task_id", "selected")
SELECT u."id", t."id", true
FROM "users" u
CROSS JOIN "tasks" t
WHERE t."is_routine" = true
  AND NOT EXISTS (SELECT 1 FROM "user_routine_tasks" r WHERE r."user_id" = u."id")
ON CONFLICT ("user_id", "task_id") DO NOTHING;
