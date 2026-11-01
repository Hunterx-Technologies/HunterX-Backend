// Per-key throttles (in-memory fallback: no REDIS_URL in tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.REDIS_URL;
const throttle = await import('../src/utils/throttle.js');

test('login locks after 10 failures and clears on success', async () => {
  const email = 'lock@example.com';
  for (let i = 0; i < 9; i++) await throttle.recordLoginFailure(email);
  assert.equal(await throttle.isLoginLocked(email), false);
  await throttle.recordLoginFailure(email);
  assert.equal(await throttle.isLoginLocked(email), true);
  await throttle.clearLoginFailures(email);
  assert.equal(await throttle.isLoginLocked(email), false);
});

test('one code email per minute per address and purpose', async () => {
  assert.equal(await throttle.allowCodeEmail('signup', 'a@example.com'), true);
  assert.equal(await throttle.allowCodeEmail('signup', 'a@example.com'), false);
  assert.equal(await throttle.allowCodeEmail('signup', 'b@example.com'), true);
  assert.equal(await throttle.allowCodeEmail('email-change', 'a@example.com'), true);
});
