-- Sign in with Apple token revocation (App Store Guideline 5.1.1(v)).
-- auth_providers.apple_refresh_token — the refresh token Apple returns when
-- the app's one-time authorization code is exchanged at sign-in
-- (appleTokenService.js). Account deletion revokes it at Apple's
-- /auth/revoke so the Apple ID is unlinked from HunterX.
ALTER TABLE "auth_providers" ADD COLUMN IF NOT EXISTS "apple_refresh_token" TEXT;

-- Announcements / offers (admin broadcasts) are promotional push, which
-- App Store Guideline 4.5.4 and our Privacy Policy say are sent only to
-- users who opt in. Off by default, and switched off for everyone who never
-- chose it: the old default was on, so an existing `true` was never an
-- explicit opt-in. Users turn it on from the push permission modal or
-- System Settings.
ALTER TABLE "user_settings" ALTER COLUMN "notify_announcements" SET DEFAULT false;
UPDATE "user_settings" SET "notify_announcements" = false WHERE "notify_announcements" = true;
