// Push dispatcher: accounts waiting to be deleted only get the deletion
// pushes; everything else stays in the inbox but is never pushed.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

const delivered = [];
mock.module(new URL('../src/services/pushService.js', import.meta.url).href, {
  namedExports: {
    sendPushMessages:  async (messages) => { delivered.push(...messages); return messages.map(() => ({ status: 'ok' })); },
    getPushReceipts:   async () => ({}),
    getTokensForUsers: async (ids) => ids.map((id) => ({ user_id: id, token: `ExponentPushToken[${id}]` })),
    removeTokens:      async () => {},
  },
});

const { runPushDispatch } = await import('../src/services/pushDispatchService.js');

let nextId = 1n;
const notify = (user_id, type) => ({
  id: nextId++, user_id, type, title: type, body: type, data: {}, push_status: 'PENDING', deliver_after: new Date(Date.now() - 1000),
});

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  delivered.length = 0;
  fake.models.users.rows.push(
    { id: 1n, role: 'USER', delete_at: new Date(Date.now() + 5 * 86_400_000) }, // pending deletion
    { id: 2n, role: 'USER', delete_at: null },
  );
});

test('a pending-deletion account gets the deletion pushes but not reminders or broadcasts', async () => {
  fake.models.notifications.rows.push(
    notify(1n, 'TASK_REMINDER'),
    notify(1n, 'BROADCAST'),
    notify(1n, 'ACCOUNT_DELETION'),
    notify(1n, 'ACCOUNT_DELETION_REMINDER'),
    notify(2n, 'TASK_REMINDER'),
  );

  const summary = await runPushDispatch();

  assert.deepEqual(
    delivered.map((m) => `${m.to}:${m.data.type}`).sort(),
    [
      'ExponentPushToken[1]:ACCOUNT_DELETION',
      'ExponentPushToken[1]:ACCOUNT_DELETION_REMINDER',
      'ExponentPushToken[2]:TASK_REMINDER',
    ],
  );
  const held = fake.models.notifications.rows.filter((n) => n.push_error === 'pending_deletion');
  assert.deepEqual(held.map((n) => n.type).sort(), ['BROADCAST', 'TASK_REMINDER']);
  assert.ok(held.every((n) => n.push_status === 'SKIPPED'));
  assert.equal(summary.sent, 3);
  assert.equal(summary.skipped, 2);
});

test('a deletion push opens Profile', async () => {
  fake.models.notifications.rows.push(notify(1n, 'ACCOUNT_DELETION'));
  await runPushDispatch();
  assert.equal(delivered[0].data.url, '/(tabs)/profile');
  assert.equal(delivered[0].channelId, 'system');
});
