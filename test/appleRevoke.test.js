// Sign in with Apple revocation (Guideline 5.1.1(v)): sign-in stores Apple's
// refresh token from the app's authorization code; account deletion revokes it.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

delete process.env.REDIS_URL;
process.env.APPLE_CLIENT_ID = 'com.hunterx.mobile';
process.env.APPLE_TEAM_ID = 'TEAM123456';
process.env.APPLE_KEY_ID = 'KEY1234567';
process.env.APPLE_PRIVATE_KEY = 'fake-key';

const calls = { exchange: [], revoke: [] };
let revokeFails = false;
const appleMock = {
  getClientSecret: () => 'client-secret',
  getAuthorizationToken: async (code) => {
    calls.exchange.push(code);
    return code === 'bad-code' ? { error: 'invalid_grant' } : { refresh_token: `rt-${code}` };
  },
  revokeAuthorizationToken: async (token, opts) => {
    calls.revoke.push({ token, hint: opts.tokenTypeHint });
    if (revokeFails) throw new Error('apple down');
    return '';
  },
  verifyIdToken: async () => ({ sub: 'apple-sub-1', email: 'hunter@example.com', email_verified: 'true' }),
};
mock.module('apple-signin-auth', { defaultExport: appleMock });

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async () => ({}), mailTransporter: {} },
});

// No uploads here (Cloudinary cleanup is covered by mediaCleanup.test.js).
const noMedia = async () => ({ partial: false, resources: [] });
mock.module(new URL('../src/config/cloudinary.js', import.meta.url).href, {
  defaultExport: { api: { delete_resources_by_prefix: noMedia, resources: noMedia, delete_folder: noMedia }, uploader: {}, utils: {} },
});

const appleTokens = await import('../src/services/appleTokenService.js');
const deletion = await import('../src/services/accountDeletionService.js');

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  calls.exchange.length = 0;
  calls.revoke.length = 0;
  revokeFails = false;
  fake.models.users.rows.push({ id: 1n, email: 'hunter@example.com', role: 'USER' });
});

test('an authorization code is exchanged for Apple\'s refresh token', async () => {
  assert.equal(await appleTokens.exchangeAppleAuthorizationCode('code-1'), 'rt-code-1');
  assert.equal(await appleTokens.exchangeAppleAuthorizationCode('bad-code'), null);
  assert.equal(await appleTokens.exchangeAppleAuthorizationCode(null), null);
  assert.deepEqual(calls.exchange, ['code-1', 'bad-code']);
});

test('deleting an account revokes its stored Apple refresh token', async () => {
  fake.models.auth_providers.rows.push(
    { id: 1n, user_id: 1n, provider: 'APPLE', provider_id: 'apple-sub-1', apple_refresh_token: 'rt-stored' },
    { id: 2n, user_id: 1n, provider: 'GOOGLE', provider_id: 'g-1', apple_refresh_token: null },
  );
  await deletion.deleteUserAccount(1n);
  assert.deepEqual(calls.revoke, [{ token: 'rt-stored', hint: 'refresh_token' }]);
  assert.equal(fake.models.users.rows.length, 0);
});

test('an Apple outage does not block account deletion', async () => {
  revokeFails = true;
  fake.models.auth_providers.rows.push(
    { id: 1n, user_id: 1n, provider: 'APPLE', provider_id: 'apple-sub-1', apple_refresh_token: 'rt-stored' },
  );
  await deletion.deleteUserAccount(1n);
  assert.equal(fake.models.users.rows.length, 0);
  assert.equal(calls.revoke.length, 1);
});

test('without the Apple key, revocation is skipped rather than failing', async () => {
  const saved = process.env.APPLE_PRIVATE_KEY;
  delete process.env.APPLE_PRIVATE_KEY;
  try {
    assert.equal(await appleTokens.revokeAppleRefreshToken('rt-x'), false);
    assert.equal(calls.revoke.length, 0);
  } finally {
    process.env.APPLE_PRIVATE_KEY = saved;
  }
});
