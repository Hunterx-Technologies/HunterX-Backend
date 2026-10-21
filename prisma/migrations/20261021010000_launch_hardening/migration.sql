-- Pre-launch hardening.

-- Wrong-code counter: an OTP is burned after too many bad guesses
-- (authService.verifyOtp), so 6 digits can't be brute-forced.
ALTER TABLE "email_otps" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- Bumped on password reset — refresh tokens carry the version they were
-- issued under and stop working once it moves (authService.refreshAccessToken).
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

-- hunter_id numbers used to be COUNT(*) + 1, which collides as soon as a user
-- is deleted (or two signups race). Start the sequence past every number
-- already handed out.
CREATE SEQUENCE IF NOT EXISTS "hunter_id_seq" START 1;
SELECT setval(
  'hunter_id_seq',
  GREATEST(
    (SELECT COALESCE(MAX(CAST(substring("hunter_id" from '[0-9]+$') AS BIGINT)), 0) FROM "users"),
    (SELECT COUNT(*) FROM "users")
  ) + 1,
  false
);

-- Referral payout looks referrals up by the referred user.
CREATE INDEX IF NOT EXISTS "idx_referrals_referred" ON "referrals"("referred_id");

-- Inbox: newest-first keyset paging per user.
CREATE INDEX IF NOT EXISTS "idx_notifications_user_id_desc" ON "notifications"("user_id", "id" DESC);
