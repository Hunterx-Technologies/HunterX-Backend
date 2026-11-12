// The streak is frozen while an account waits to be deleted (quests are
// refused then), and "Keep my account" carries it past the pause.
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
// 10:00 IST on 1 Nov 2026.
const START = Date.UTC(2026, 10, 1, 4, 30);
const istDay = (ms) => {
  const d = new Date(ms + 5.5 * 3_600_000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
};

const streak = await import('../src/services/streakService.js');
const deletion = await import('../src/services/accountDeletionService.js');

const progression = () => fake.models.user_progression.rows[0];
const user = () => fake.models.users.rows[0];

function requestDeletion(atMs) {
  Object.assign(user(), { deletion_requested_at: new Date(atMs), delete_at: new Date(atMs + 30 * DAY) });
}

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  mock.timers.enable({ apis: ['Date'], now: START });
  fake.models.users.rows.push({ id: 1n, email: 'hunter@example.com', role: 'USER', delete_at: null, deletion_requested_at: null });
  // A 10-day streak, active today, 2 lives banked.
  fake.models.user_progression.rows.push({
    id: 1n, user_id: 1n, daily_streak: 10, longest_streak: 10, streak_lives: 2,
    consecutive_miss_days: 0, last_active_date: istDay(START),
  });
});

afterEach(() => mock.timers.reset());

test('10-day streak, 5 days pending, restore: still 10 with the same lives', async () => {
  requestDeletion(START);

  mock.timers.setTime(START + 5 * DAY);
  // The app loading /tasks/today while pending doesn't break or spend anything.
  const pending = await streak.getStreakRiskStatus(1n);
  assert.equal(pending.daily_streak, 10);
  assert.equal(pending.at_risk, false);
  assert.equal(fake.models.streak_events.rows.length, 0);

  await deletion.cancelDeletion(1n);

  // First load after restoring (same day).
  const after = await streak.getStreakRiskStatus(1n);
  assert.equal(after.daily_streak, 10);
  assert.equal(after.streak_lives, 2);
  assert.equal(after.at_risk, false);
  assert.equal(fake.models.streak_events.rows.length, 0, 'no LIFE_USED / STREAK_BROKEN card');
  assert.deepEqual(progression().last_active_date, istDay(START + 4 * DAY), 'yesterday: today still counts when they play');
});

test('a gap that existed before the request is kept, not forgiven', async () => {
  // Last active 2 days before the request (1 missed day, already at risk).
  progression().last_active_date = istDay(START - 2 * DAY);
  requestDeletion(START);
  mock.timers.setTime(START + 5 * DAY);
  await deletion.cancelDeletion(1n);

  assert.deepEqual(progression().last_active_date, istDay(START + 3 * DAY), 'shifted by the 5 paused days');
  const after = await streak.getStreakRiskStatus(1n);
  // The one missed day is covered by a life, exactly as it would have been.
  assert.equal(after.daily_streak, 10);
  assert.equal(after.streak_lives, 1);
});

test('restoring on the same day leaves the streak untouched', async () => {
  requestDeletion(START);
  mock.timers.setTime(START + 2 * 3_600_000);
  await deletion.cancelDeletion(1n);
  assert.deepEqual(progression().last_active_date, istDay(START));
});

test('no request time on record: falls back to yesterday', async () => {
  requestDeletion(START);
  user().deletion_requested_at = null;
  mock.timers.setTime(START + 5 * DAY);
  await deletion.cancelDeletion(1n);
  assert.deepEqual(progression().last_active_date, istDay(START + 4 * DAY));
  assert.equal((await streak.getStreakRiskStatus(1n)).daily_streak, 10);
});

test('the website cancel path restores the streak the same way', async () => {
  process.env.WEBSITE_URL = 'https://www.example.com/';
  requestDeletion(START);
  mock.timers.setTime(START + 5 * DAY);
  const { createAccountOtp, OTP_PURPOSES } = await import('../src/services/accountOtpService.js');
  const code = await createAccountOtp(1n, OTP_PURPOSES.CANCEL_DELETION, 'hunter@example.com');
  await deletion.cancelDeletionByCode('hunter@example.com', code);
  assert.equal(user().delete_at, null);
  assert.deepEqual(progression().last_active_date, istDay(START + 4 * DAY));
});

test('normal accounts are unchanged: a long gap still breaks the streak', async () => {
  mock.timers.setTime(START + 5 * DAY);
  const status = await streak.getStreakRiskStatus(1n);
  assert.equal(status.daily_streak, 0);
  assert.equal(fake.models.streak_events.rows[0].type, 'STREAK_BROKEN');
});
