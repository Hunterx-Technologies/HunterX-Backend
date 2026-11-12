// Reward expiry is paused while an account waits to be deleted, and
// "Keep my account" gives the paused time back.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async () => ({}), mailTransporter: {} },
});

const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 1, 4, 30);

const rewards = await import('../src/services/rewardService.js');
const deletion = await import('../src/services/accountDeletionService.js');

const card = (id) => fake.models.user_rewards.rows.find((r) => r.id === id);

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  mock.timers.enable({ apis: ['Date'], now: START });
  fake.models.users.rows.push(
    { id: 1n, email: 'pending@example.com', role: 'USER', delete_at: null, deletion_requested_at: null },
    { id: 2n, email: 'normal@example.com', role: 'USER', delete_at: null, deletion_requested_at: null },
  );
  fake.models.user_rewards.rows.push(
    { id: 10n, user_id: 1n, status: 'ACTIVE', expires_at: new Date(START + 2 * DAY), reward_text: '10% off' },
    { id: 20n, user_id: 2n, status: 'ACTIVE', expires_at: new Date(START + 2 * DAY), reward_text: '10% off' },
  );
  Object.assign(fake.models.users.rows[0], { deletion_requested_at: new Date(START), delete_at: new Date(START + 30 * DAY) });
});

afterEach(() => mock.timers.reset());

test('card with 2 days left, 5 days pending, restore: active and 2 days left', async () => {
  mock.timers.setTime(START + 5 * DAY);
  await rewards.expireRewards(new Date());
  assert.equal(card(10n).status, 'ACTIVE', 'the nightly job skips the pending account');
  assert.equal(card(20n).status, 'EXPIRED', 'normal accounts still expire');

  await deletion.cancelDeletion(1n);

  const restoredAt = START + 5 * DAY;
  assert.equal(card(10n).expires_at.getTime(), restoredAt + 2 * DAY);
  assert.equal(rewards.apiStatus(card(10n), new Date()), 'UNSEEN');
  await rewards.expireRewards(new Date());
  assert.equal(card(10n).status, 'ACTIVE');
});

test('never past the coupon\'s own valid_until', async () => {
  card(10n).reward_coupons = { valid_until: new Date(START + 4 * DAY) };
  mock.timers.setTime(START + 5 * DAY);
  await deletion.cancelDeletion(1n);
  assert.equal(card(10n).expires_at.getTime(), START + 4 * DAY);
});

test('cards already expired before the request, and used cards, are left alone', async () => {
  fake.models.user_rewards.rows.push(
    { id: 11n, user_id: 1n, status: 'ACTIVE', expires_at: new Date(START - DAY) },
    { id: 12n, user_id: 1n, status: 'CLAIMED', expires_at: new Date(START + DAY) },
  );
  mock.timers.setTime(START + 5 * DAY);
  await deletion.cancelDeletion(1n);
  assert.equal(card(11n).expires_at.getTime(), START - DAY);
  assert.equal(card(12n).expires_at.getTime(), START + DAY);
});

test('no request time on record: the pause is worked out from delete_at', async () => {
  fake.models.users.rows[0].deletion_requested_at = null;
  mock.timers.setTime(START + 5 * DAY);
  await deletion.cancelDeletion(1n);
  assert.equal(card(10n).expires_at.getTime(), START + 7 * DAY);
});

test('no birthday card while pending', async () => {
  const today = new Date(START);
  Object.assign(fake.models.users.rows[0], { date_of_birth: new Date(Date.UTC(1995, today.getUTCMonth(), today.getUTCDate())), is_banned: false });
  assert.equal(await rewards.ensureBirthdayCard(1n), null);
});
