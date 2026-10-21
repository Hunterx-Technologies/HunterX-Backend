-- Append-only audit trail of admin moderation actions (ban / unban /
-- streak reset), shown in the admin User Detail "Activity History" tab.
-- CreateEnum
CREATE TYPE "admin_user_action_type" AS ENUM ('BAN', 'UNBAN', 'STREAK_RESET');

-- CreateTable
CREATE TABLE "admin_user_actions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "admin_id" BIGINT,
    "action" "admin_user_action_type" NOT NULL,
    "reason" VARCHAR(500),
    "details" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_user_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_admin_user_actions_user_created" ON "admin_user_actions"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "admin_user_actions" ADD CONSTRAINT "admin_user_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "admin_user_actions" ADD CONSTRAINT "admin_user_actions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

