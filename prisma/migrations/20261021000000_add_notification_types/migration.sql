-- New push types for the notification gap review: paid-task purchase /
-- access expiry / completion, the "all daily quests cleared" confirmation,
-- and admin account actions (ban, unban, streak reset).
-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'PURCHASE_CONFIRMED';
ALTER TYPE "notification_type" ADD VALUE 'PAID_TASK_EXPIRING';
ALTER TYPE "notification_type" ADD VALUE 'QUEST_COMPLETED';
ALTER TYPE "notification_type" ADD VALUE 'DAY_COMPLETE';
ALTER TYPE "notification_type" ADD VALUE 'ACCOUNT_UPDATE';
