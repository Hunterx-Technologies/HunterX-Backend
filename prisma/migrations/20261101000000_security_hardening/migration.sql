-- Security hardening (audit 2026-11-01).
--
-- users.email_verified_at — when the address on the account was last proven
-- to belong to its owner (signup OTP, a Google/Apple token carrying that
-- address, a password reset, or a confirmed email change). Google/Apple
-- sign-in only links into an existing account whose email is verified, so
-- an address typed onto an account can't capture someone else's sign-in.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP(6);

-- Email + password accounts whose email is still the one they signed up
-- with (auth_providers.provider_id for EMAIL is the signup address, which
-- signup verified by OTP). Accounts whose email was changed later, and
-- Google/Apple-created accounts, stay unverified until their next Google /
-- Apple sign-in with that same address, or a password reset.
UPDATE "users" u
SET "email_verified_at" = COALESCE(u."created_at", CURRENT_TIMESTAMP)
WHERE u."email" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "auth_providers" ap
    WHERE ap."user_id" = u."id"
      AND ap."provider" = 'EMAIL'
      AND lower(ap."provider_id") = lower(u."email")
  );

-- IF NOT EXISTS: an earlier, unmerged account-deletion migration
-- (20261027000000_account_deletion) already added deletion_requested_at,
-- delete_at and idx_users_delete_at to some databases, with the same
-- meaning (nullable timestamps; partial index on delete_at).
--
-- Account deletion with a 30-day grace period. delete_at set = scheduled;
-- the hourly purge (src/cron/accountDeletion.js) deletes the account once
-- it passes. deletion_token_hash: SHA-256 of the one-time link the app
-- opens on the website (10 minutes).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_requested_at" TIMESTAMP(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "delete_at" TIMESTAMP(6);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_token_hash" VARCHAR(64);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_token_expiry" TIMESTAMP(6);

CREATE INDEX IF NOT EXISTS "idx_users_delete_at" ON "users"("delete_at") WHERE "delete_at" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "users_deletion_token_hash_key" ON "users"("deletion_token_hash");

-- One-time codes for signed-in or account-bound actions (email change,
-- website account deletion / cancellation). Only the SHA-256 of the code
-- is stored.
CREATE TABLE "account_otps" (
    "id"         BIGSERIAL    NOT NULL,
    "user_id"    BIGINT       NOT NULL,
    "purpose"    VARCHAR(32)  NOT NULL,
    "email"      VARCHAR(255) NOT NULL,
    "otp_hash"   VARCHAR(64)  NOT NULL,
    "attempts"   INTEGER      NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(6) NOT NULL,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_otps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_account_otps_user_purpose" ON "account_otps"("user_id", "purpose");

ALTER TABLE "account_otps" ADD CONSTRAINT "account_otps_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- Refresh tokens, one row per issued token (jti). Rotation revokes the old
-- row; presenting a revoked token again revokes its whole family (a stolen
-- token replayed after the owner refreshed). Logout revokes the family.
CREATE TABLE "refresh_tokens" (
    "jti"         VARCHAR(64)  NOT NULL,
    "user_id"     BIGINT       NOT NULL,
    "family_id"   VARCHAR(64)  NOT NULL,
    "expires_at"  TIMESTAMP(6) NOT NULL,
    "revoked_at"  TIMESTAMP(6),
    "replaced_by" VARCHAR(64),
    "created_at"  TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("jti")
);

CREATE INDEX "idx_refresh_tokens_user" ON "refresh_tokens"("user_id");
CREATE INDEX "idx_refresh_tokens_family" ON "refresh_tokens"("family_id");
CREATE INDEX "idx_refresh_tokens_expires" ON "refresh_tokens"("expires_at");

ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
