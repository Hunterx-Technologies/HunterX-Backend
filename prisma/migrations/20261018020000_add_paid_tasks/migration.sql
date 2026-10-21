-- Paid tasks: a task can be marked is_paid with a price and validity_days.
-- It is listed (locked) to every user, and only assigned to users with a
-- PAID task_purchases row whose access window covers the date.
-- CreateEnum
CREATE TYPE "task_purchase_status" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUNDED');

-- AlterTable
ALTER TABLE "tasks"
    ADD COLUMN "is_paid" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "price" DECIMAL(10,2),
    ADD COLUMN "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    ADD COLUMN "validity_days" INTEGER;

-- CreateTable
CREATE TABLE "task_purchases" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "task_id" BIGINT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'INR',
    "status" "task_purchase_status" NOT NULL DEFAULT 'PENDING',
    "payment_provider" VARCHAR(50),
    "payment_ref" VARCHAR(255),
    "access_start" DATE,
    "access_end" DATE,
    "paid_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_purchases_payment_ref_key" ON "task_purchases"("payment_ref");
CREATE INDEX "idx_task_purchases_user_access" ON "task_purchases"("user_id", "status", "access_start", "access_end");
CREATE INDEX "idx_task_purchases_task" ON "task_purchases"("task_id");

-- AddForeignKey
ALTER TABLE "task_purchases" ADD CONSTRAINT "task_purchases_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "task_purchases" ADD CONSTRAINT "task_purchases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
