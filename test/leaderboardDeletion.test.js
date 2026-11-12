// Accounts waiting to be deleted are off the leaderboards, and come back
// the moment they keep the account.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.WEBSITE_URL = 'https://www.example.com/';
delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async () => ({}), mailTransporter: {} },
});

const leaderboard = await import('../src/services/leaderboardService.js');

const base = { onboarding_done: true, is_banned: false, role: 'USER', leaderboard_visible: true, total_xp: 500 };

test('eligibility excludes pending-deletion accounts and keeps everyone else', () => {
  assert.equal(leaderboard.computeEligibility({ ...base, delete_at: null }).global, true);
  assert.equal(leaderboard.computeEligibility({ ...base, delete_at: new Date() }).global, false);
  assert.equal(leaderboard.eligibilityWhere().delete_at, null, 'Postgres fallback and rank pushes filter them too');
});

test('scheduling and cancelling resync the leaderboard member', async () => {
  const synced = [];
  const lbUrl = new URL('../src/services/leaderboardService.js', import.meta.url).href;
  // Fresh copy of the deletion service wired to a spy.
  mock.module(lbUrl, {
    namedExports: {
      ...leaderboard,
      syncLeaderboardMember: async (id) => { synced.push(id); },
      removeLeaderboardMember: async () => {},
    },
  });
  const deletion = await import(`../src/services/accountDeletionService.js?spy=${Date.now()}`);

  fake.models.users.rows.push({ id: 1n, email: 'h@example.com', role: 'USER', delete_at: null });
  const { url } = await deletion.createDeletionLink(1n);
  await deletion.confirmDeletionByToken(new URL(url).searchParams.get('t'));
  assert.deepEqual(synced, [1n], 'dropped when scheduled');

  await deletion.cancelDeletion(1n);
  assert.deepEqual(synced, [1n, 1n], 'back when kept');
});
