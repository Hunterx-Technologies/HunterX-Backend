// Banning (adminUserService.banUser): every session ends, and the "account
// suspended" push is written with the ban and sent at once — the admin sees
// whether it reached a phone.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

delete process.env.REDIS_URL;
const fake = createFakePrisma();

const pushTokens = [];
let dispatchRuns = 0;
mock.module(new URL('../src/services/pushDispatchService.js', import.meta.url).href, {
  namedExports: {
    // Stand-in for the real dispatcher: SENT when the hunter has a device.
    runPushDispatch: async () => {
      dispatchRuns += 1;
      for (const n of fake.models.notifications.rows) {
        if (n.push_status !== 'PENDING') continue;
        const has = pushTokens.some((t) => t.user_id === n.user_id);
        Object.assign(n, has ? { push_status: 'SENT' } : { push_status: 'SKIPPED', push_error: 'no_device' });
      }
    },
  },
});
mock.module(new URL('../src/services/leaderboardService.js', import.meta.url).href, {
  namedExports: { syncLeaderboardMember: async () => {} },
});

// user_push_tokens and admin_user_actions aren't in the fake by default.
const extra = {
  user_push_tokens: { count: async ({ where }) => pushTokens.filter((t) => t.user_id === where.user_id).length },
  admin_user_actions: { create: async ({ data }) => data },
};
// Transactions run on this same client, extras included.
const client = new Proxy(fake.client, {
  get: (t, p) => (p === '$transaction' ? async (fn) => fn(client) : extra[p] ?? t[p]),
});
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: client });

const { banUser, deliverNow } = await import('../src/services/adminUserService.js');

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  pushTokens.length = 0;
  dispatchRuns = 0;
  fake.models.users.rows.push({ id: 7n, role: 'USER', is_banned: false, name: 'Hunter', delete_at: null });
  fake.models.refresh_tokens.rows.push({ jti: 'a', user_id: 7n, family_id: 'f', revoked_at: null, expires_at: new Date(Date.now() + 1e9) });
});

test('a ban ends every session and sends the push straight away', async () => {
  pushTokens.push({ user_id: 7n, token: 'ExponentPushToken[x]' });
  // getUserDetail (the admin's view, after the ban) reads more than the fake
  // holds; everything checked here is done before it runs.
  await banUser(1n, '7', 'Cheating on quests').catch((err) => {
    if (!(err instanceof TypeError)) throw err;
  });
  assert.equal(fake.models.users.rows[0].is_banned, true);
  assert.ok(fake.models.refresh_tokens.rows[0].revoked_at, 'session revoked');
  const notice = fake.models.notifications.rows[0];
  assert.equal(notice.type, 'ACCOUNT_UPDATE');
  assert.deepEqual(notice.data, { event: 'ACCOUNT_BANNED', reason: 'Cheating on quests' });
  assert.equal(dispatchRuns, 1, 'sent at once, not on the next tick');
});

test('the admin hears whether the push reached a phone', async () => {
  pushTokens.push({ user_id: 7n, token: 'ExponentPushToken[x]' });
  fake.models.notifications.rows.push({ id: 1n, user_id: 7n, push_status: 'PENDING' });
  assert.deepEqual(await deliverNow({ id: 1n, user_id: 7n }), { status: 'SENT', devices: 1 });
});

test('no registered device is reported, not hidden', async () => {
  fake.models.notifications.rows.push({ id: 2n, user_id: 7n, push_status: 'PENDING' });
  assert.deepEqual(await deliverNow({ id: 2n, user_id: 7n }), { status: 'NO_DEVICE', devices: 0 });
});
