// A deleted account's Cloudinary uploads (userMediaCleanupService.js):
// removed after the account is deleted, and retried by the hourly job when
// Cloudinary fails.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/services/leaderboardService.js', import.meta.url).href, {
  namedExports: { removeLeaderboardMember: async () => {}, syncLeaderboardMember: async () => {} },
});
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async () => ({}), mailTransporter: {} },
});

// In-memory Cloudinary: public ids and folders. `down` makes every call fail.
const cloud = { assets: [], folders: new Set(), down: false, calls: [] };
const PAGE = 2; // small, to exercise `partial`
const guard = (name) => {
  cloud.calls.push(name);
  if (cloud.down) throw Object.assign(new Error('Cloudinary unavailable'), { http_code: 503 });
};
mock.module(new URL('../src/config/cloudinary.js', import.meta.url).href, {
  defaultExport: {
    api: {
      delete_resources_by_prefix: async (prefix) => {
        guard('delete_resources_by_prefix');
        const hit = cloud.assets.filter((id) => id.startsWith(prefix)).slice(0, PAGE);
        cloud.assets = cloud.assets.filter((id) => !hit.includes(id));
        return { deleted: Object.fromEntries(hit.map((id) => [id, 'deleted'])), partial: cloud.assets.some((id) => id.startsWith(prefix)) };
      },
      resources: async ({ prefix }) => {
        guard('resources');
        return { resources: cloud.assets.filter((id) => id.startsWith(prefix)).map((public_id) => ({ public_id })) };
      },
      delete_folder: async (path) => {
        guard('delete_folder');
        if (!cloud.folders.delete(path)) throw Object.assign(new Error('Can\'t find folder'), { error: { http_code: 404 } });
        return { deleted: [path] };
      },
    },
    uploader: { destroy: async () => ({}) },
    utils: {},
  },
});

const deletion = await import('../src/services/accountDeletionService.js');
const media = await import('../src/services/userMediaCleanupService.js');

function seedUploads(userId) {
  const ids = [
    `hunterx/task-proof/${userId}/a`, `hunterx/task-proof/${userId}/b`, `hunterx/task-proof/${userId}/c`,
    `hunterx/avatars/${userId}/me`,
  ];
  cloud.assets.push(...ids);
  cloud.folders.add(`hunterx/task-proof/${userId}`);
  cloud.folders.add(`hunterx/avatars/${userId}`);
}

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  Object.assign(cloud, { assets: [], folders: new Set(), down: false, calls: [] });
  fake.models.users.rows.push(
    { id: 13n, email: 'gone@example.com', role: 'USER' },
    { id: 130n, email: 'stays@example.com', role: 'USER' },
  );
  seedUploads(13n);
  seedUploads(130n);
});

test('deleting an account empties and removes its Cloudinary folders, nobody else\'s', async () => {
  await deletion.deleteUserAccount(13n);

  assert.equal(cloud.assets.filter((id) => id.includes('/13/')).length, 0, 'no assets left for the purged user');
  assert.ok(![...cloud.folders].some((f) => f.endsWith('/13')), 'its folders are gone');
  assert.equal(cloud.assets.filter((id) => id.includes('/130/')).length, 4, 'user 130 (same prefix digits) untouched');
  assert.equal(fake.models.pending_media_cleanup.rows.length, 0, 'nothing left to retry');
});

test('a Cloudinary failure keeps the account deleted and is retried on the next run', async () => {
  cloud.down = true;
  await deletion.deleteUserAccount(13n); // must not throw

  assert.equal(fake.models.users.rows.some((u) => u.id === 13n), false, 'account still deleted');
  const [row] = fake.models.pending_media_cleanup.rows;
  assert.equal(row.user_id, 13n);
  assert.equal(row.attempts, 1);
  assert.match(row.last_error, /Cloudinary unavailable/);
  assert.ok(!row.last_error.includes('gone@example.com'), 'no personal data in the record');

  // Still down: the attempt count goes up, the row stays.
  assert.equal(await media.retryPendingMediaCleanup(), 0);
  assert.equal(fake.models.pending_media_cleanup.rows[0].attempts, 2);

  cloud.down = false;
  assert.equal(await media.retryPendingMediaCleanup(), 1);
  assert.equal(fake.models.pending_media_cleanup.rows.length, 0);
  assert.equal(cloud.assets.filter((id) => id.includes('/13/')).length, 0);
});

test('a user who never uploaded anything is cleaned up without errors', async () => {
  fake.models.users.rows.push({ id: 7n, email: 'empty@example.com', role: 'USER' });
  await deletion.deleteUserAccount(7n);
  assert.equal(fake.models.pending_media_cleanup.rows.length, 0);
});
