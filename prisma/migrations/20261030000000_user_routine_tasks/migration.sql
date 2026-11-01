-- Routine tasks each hunter picked (onboarding "pick your routine" step and
-- Home > Add task). No rows for a user = every routine task, as before.
CREATE TABLE "user_routine_tasks" (
    "user_id"    BIGINT NOT NULL,
    "task_id"    BIGINT NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_routine_tasks_pkey" PRIMARY KEY ("user_id", "task_id")
);

CREATE INDEX "idx_user_routine_tasks_task" ON "user_routine_tasks"("task_id");

ALTER TABLE "user_routine_tasks" ADD CONSTRAINT "user_routine_tasks_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "user_routine_tasks" ADD CONSTRAINT "user_routine_tasks_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
