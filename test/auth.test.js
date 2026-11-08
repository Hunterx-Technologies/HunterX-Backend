// Account-security regressions in authService.js: social sign-in never links
// into an account whose email wasn't verified (audit C-1), email changes
// need a code sent to the new address, password login locks after repeated
// failures, and signup codes don't reveal which emails are registered.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
process.env.GOOGLE_CLIENT_ID_WEB = 'test-client';
delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

const sent = [];
const fakeMail = { sendMail: async (msg) => { sent.push(msg); return {}; } };
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: fakeMail.sendMail, mailTransporter: fakeMail },
});

let googlePayload = null;
class FakeOAuth2Client {
  async verifyIdToken() {
    return { getPayload: () => googlePayload };
  }
}
mock.module('google-auth-library', { namedExports: { OAuth2Client: FakeOAuth2Client } });

const auth = await import('../src/services/authService.js');

const PASSWORD = 'Hunter#2026';
const passwordHash = await bcrypt.hash(PASSWORD, 4);

function seedUser(overrides = {}) {
  const row = {
    id: 1n, name: 'Attacker', email: 'attacker@example.com', role: 'USER', gender: null,
    token_version: 0, is_banned: false, onboarding_done: true, password_hash: passwordHash,
    email_verified_at: new Date(), delete_at: null, created_at: new Date(), ...overrides,
  };
  fake.models.users.rows.push(row);
  return row;
}

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  sent.length = 0;
});

test('C-1: Google sign-in does not link into an account whose email is unverified', async () => {
  seedUser({ email: 'victim@gmail.com', email_verified_at: null });
  googlePayload = { sub: 'google-victim', email: 'victim@gmail.com', email_verified: true, name: 'Victim' };
  await assert.rejects(auth.loginWithGoogle('token'), /EMAIL_LINK_UNVERIFIED/);
  assert.equal(fake.models.auth_providers.rows.length, 0);
});

test('Google sign-in still links into an account with a verified email', async () => {
  seedUser({ email: 'owner@gmail.com' });
  googlePayload = { sub: 'google-owner', email: 'owner@gmail.com', email_verified: true, name: 'Owner' };
  const result = await auth.loginWithGoogle('token');
  assert.equal(result.linked, true);
  assert.ok(result.accessToken && result.refreshToken);
  assert.equal(fake.models.auth_providers.rows[0].provider_id, 'google-owner');
});

test('a returning Google user (provider already linked) logs straight in', async () => {
  seedUser({ email: 'returning@gmail.com' });
  fake.models.auth_providers.rows.push({ id: 10n, user_id: 1n, provider: 'GOOGLE', provider_id: 'google-returning' });
  googlePayload = { sub: 'google-returning', email: 'returning@gmail.com', email_verified: true, name: 'Returning' };
  const result = await auth.loginWithGoogle('token');
  assert.equal(result.isNew, false);
  assert.ok(result.accessToken && result.refreshToken);
});

test('profile update cannot change the email', async () => {
  seedUser();
  await assert.rejects(
    auth.updateUserProfile(1n, { email: 'victim@gmail.com' }),
    /EMAIL_CHANGE_REQUIRES_VERIFICATION/
  );
  assert.equal(fake.models.users.rows[0].email, 'attacker@example.com');
});

test('email change needs the current password, then a code sent to the new address', async () => {
  seedUser();
  await assert.rejects(auth.requestEmailChange(1n, 'new@example.com'), /CURRENT_PASSWORD_REQUIRED/);
  await assert.rejects(auth.requestEmailChange(1n, 'new@example.com', 'wrong'), /INVALID_CURRENT_PASSWORD/);

  await auth.requestEmailChange(1n, 'new@example.com', PASSWORD);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'new@example.com');
  assert.equal(fake.models.users.rows[0].email, 'attacker@example.com', 'not changed before the code');

  await assert.rejects(auth.confirmEmailChange(1n, 'new@example.com', '000000'), /OTP_INVALID/);
  await assert.rejects(auth.confirmEmailChange(1n, 'other@example.com', '000000'), /OTP_INVALID/);
});

test('password login locks after 10 failures', async () => {
  seedUser({ email: 'lockme@example.com' });
  for (let i = 0; i < 10; i++) {
    await assert.rejects(auth.loginWithEmail('lockme@example.com', 'wrong'), /INVALID_CREDENTIALS/);
  }
  await assert.rejects(auth.loginWithEmail('lockme@example.com', PASSWORD), /LOGIN_LOCKED/);
});

test('signup code request for a registered email: ACCOUNT_EXISTS, no code, no email', async () => {
  seedUser({ email: 'taken@example.com' });
  fake.models.auth_providers.rows.push({ id: 5n, user_id: 1n, provider: 'GOOGLE', provider_id: 'g-taken' });
  await assert.rejects(auth.sendOtp('taken@example.com'), { message: 'ACCOUNT_EXISTS', providers: ['GOOGLE'] });
  assert.equal(fake.models.email_otps.rows.length, 0, 'no code for an existing account');
  assert.equal(sent.length, 0, 'no email');
});

test('signup code request for an account waiting to be deleted: log in to restore', async () => {
  seedUser({ email: 'leaving@example.com', delete_at: new Date(Date.now() + 86_400_000) });
  await assert.rejects(auth.sendOtp('leaving@example.com'), /ACCOUNT_PENDING_DELETION_LOGIN_TO_RESTORE/);
  assert.equal(sent.length, 0);
});

test('signup code request for a new email sends a code', async () => {
  assert.equal(await auth.sendOtp('brand-new@example.com'), true);
  assert.equal(fake.models.email_otps.rows.length, 1);
  assert.equal(sent[0].to, 'brand-new@example.com');
});

test('change password rejects a wrong current password and revokes sessions on success', async () => {
  seedUser();
  await assert.rejects(auth.changePassword(1n, 'wrong', 'Another#2026'), /INVALID_CURRENT_PASSWORD/);
  fake.models.refresh_tokens.rows.push({ jti: 'old', user_id: 1n, family_id: 'f', revoked_at: null, expires_at: new Date(Date.now() + 1e9) });
  const tokens = await auth.changePassword(1n, PASSWORD, 'Another#2026');
  assert.ok(tokens.accessToken);
  assert.ok(fake.models.refresh_tokens.rows.find((r) => r.jti === 'old').revoked_at);
  assert.equal(fake.models.users.rows[0].token_version, 1);
});

test('the code from the email confirms the change and marks the email verified', async () => {
  seedUser({ email_verified_at: null });
  fake.models.auth_providers.rows.push({ id: 1n, user_id: 1n, provider: 'EMAIL', provider_id: 'attacker@example.com' });
  await auth.requestEmailChange(1n, 'mine@example.com', PASSWORD);
  const code = sent[0].html.match(/>(\d{6})</)[1];
  await auth.confirmEmailChange(1n, 'mine@example.com', code);
  const user = fake.models.users.rows[0];
  assert.equal(user.email, 'mine@example.com');
  assert.ok(user.email_verified_at);
  assert.equal(fake.models.auth_providers.rows[0].provider_id, 'mine@example.com');
  assert.equal(sent.at(-1).to, 'attacker@example.com', 'old address is told');
});
