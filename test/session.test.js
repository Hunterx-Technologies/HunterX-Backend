// Refresh-token rotation, reuse detection and logout (sessionService.js).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.JWT_SECRET = 'test-access-secret';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

const sessions = await import('../src/services/sessionService.js');
const { generateTokens } = await import('../src/utils/helpers.js');

const user = { id: 1n, role: 'USER', gender: null, token_version: 0, is_banned: false };

beforeEach(() => {
  fake.models.users.rows.splice(0, Infinity, { ...user });
  fake.models.refresh_tokens.rows.length = 0;
});

test('rotation revokes the presented token and issues a working one', async () => {
  const first = await sessions.issueSession(user);
  const second = await sessions.rotateSession(first.refreshToken);
  assert.ok(second.refreshToken && second.refreshToken !== first.refreshToken);
  await assert.rejects(sessions.rotateSession(first.refreshToken), /TOKEN_REVOKED/);
  const third = await sessions.rotateSession(second.refreshToken);
  assert.ok(third.accessToken);
});

test('replaying a token rotated long ago revokes the whole family', async () => {
  const first = await sessions.issueSession(user);
  const second = await sessions.rotateSession(first.refreshToken);
  // Pretend the first rotation happened a minute ago (past the retry grace).
  fake.models.refresh_tokens.rows.find((r) => r.revoked_at).revoked_at = new Date(Date.now() - 60_000);
  await assert.rejects(sessions.rotateSession(first.refreshToken), /TOKEN_REVOKED/);
  await assert.rejects(sessions.rotateSession(second.refreshToken), /TOKEN_REVOKED/);
});

test('logout revokes the family', async () => {
  const first = await sessions.issueSession(user);
  await sessions.revokeSession(first.refreshToken);
  await assert.rejects(sessions.rotateSession(first.refreshToken), /TOKEN_REVOKED/);
});

test('password change (token_version bump) revokes older tokens', async () => {
  const first = await sessions.issueSession(user);
  fake.models.users.rows[0].token_version = 1;
  await assert.rejects(sessions.rotateSession(first.refreshToken), /TOKEN_REVOKED/);
});

test('legacy tokens without a jti are accepted once and moved onto a tracked family', async () => {
  const { refreshToken } = generateTokens('1', 'USER', null, 0);
  const next = await sessions.rotateSession(refreshToken);
  assert.equal(fake.models.refresh_tokens.rows.length, 1);
  assert.ok(next.refreshToken);
});

test('a deleted user cannot refresh', async () => {
  const first = await sessions.issueSession(user);
  fake.models.users.rows.length = 0;
  await assert.rejects(sessions.rotateSession(first.refreshToken), /USER_NOT_FOUND/);
});
