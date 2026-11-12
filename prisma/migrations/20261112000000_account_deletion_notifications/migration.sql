-- Account deletion pushes (accountDeletionService.js):
-- * ACCOUNT_DELETION          — deletion scheduled / cancelled from the website
-- * ACCOUNT_DELETION_REMINDER — 3 days before the account is deleted

-- AlterEnum
ALTER TYPE "notification_type" ADD VALUE 'ACCOUNT_DELETION';
ALTER TYPE "notification_type" ADD VALUE 'ACCOUNT_DELETION_REMINDER';
