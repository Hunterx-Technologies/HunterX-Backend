-- MONTHLY was added to the task_type enum in schema.prisma without a
-- migration, so databases built from migrations reject it.
ALTER TYPE "task_type" ADD VALUE IF NOT EXISTS 'MONTHLY';
