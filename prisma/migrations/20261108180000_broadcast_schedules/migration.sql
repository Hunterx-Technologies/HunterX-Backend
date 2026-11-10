-- Scheduled + recurring admin broadcasts (broadcastScheduleService.js).

-- CreateEnum
CREATE TYPE "broadcast_recurrence" AS ENUM ('NONE', 'DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "broadcast_schedule_status" AS ENUM ('SCHEDULED', 'PAUSED', 'SENDING', 'SENT', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "broadcast_run_status" AS ENUM ('QUEUING', 'QUEUED', 'SKIPPED', 'FAILED');

-- CreateTable
CREATE TABLE "broadcast_schedules" (
    "id"            BIGSERIAL NOT NULL,
    "title"         VARCHAR(255) NOT NULL,
    "body"          TEXT NOT NULL,
    "url"           VARCHAR(100),
    "audience"      VARCHAR(20) NOT NULL,
    "inactive_days" INTEGER,
    "recurrence"    "broadcast_recurrence" NOT NULL DEFAULT 'NONE',
    "start_date"    DATE NOT NULL,
    "send_time"     VARCHAR(5) NOT NULL,
    "next_run_at"   TIMESTAMP(6),
    "status"        "broadcast_schedule_status" NOT NULL DEFAULT 'SCHEDULED',
    "run_count"     INTEGER NOT NULL DEFAULT 0,
    "last_run_at"   TIMESTAMP(6),
    "completed_at"  TIMESTAMP(6),
    "last_error"    VARCHAR(500),
    "created_by"    BIGINT,
    "created_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_schedule_runs" (
    "id"                BIGSERIAL NOT NULL,
    "schedule_id"       BIGINT,
    "run_for"           TIMESTAMP(6) NOT NULL,
    "broadcast_id"      VARCHAR(36) NOT NULL,
    "title"             VARCHAR(255) NOT NULL,
    "status"            "broadcast_run_status" NOT NULL DEFAULT 'QUEUING',
    "attempts"          INTEGER NOT NULL DEFAULT 0,
    "recipients"        INTEGER,
    "reachable_by_push" INTEGER,
    "error"             VARCHAR(500),
    "created_at"        TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queued_at"         TIMESTAMP(6),

    CONSTRAINT "broadcast_schedule_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_broadcast_schedules_due" ON "broadcast_schedules"("status", "next_run_at");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_schedule_runs_broadcast_id_key" ON "broadcast_schedule_runs"("broadcast_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_broadcast_runs_schedule_run_for" ON "broadcast_schedule_runs"("schedule_id", "run_for");

-- CreateIndex
CREATE INDEX "idx_broadcast_runs_status" ON "broadcast_schedule_runs"("status");

-- AddForeignKey
ALTER TABLE "broadcast_schedule_runs" ADD CONSTRAINT "broadcast_schedule_runs_schedule_id_fkey"
    FOREIGN KEY ("schedule_id") REFERENCES "broadcast_schedules"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
