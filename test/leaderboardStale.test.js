// A hunter whose account is gone (deleted outside the normal purge, or while
// Redis was down) must never be shown on the global leaderboard: the Redis
// path drops them the moment a page would include them, and ranks close up.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.WEBSITE_URL = 'https://www.example.com/';

// ── Tiny in-memory Redis: just what the leaderboard read path uses ──────
const zsets = new Map(); // key → Map(member → score)
const hashes = new Map();
const z = (key) => zsets.get(key) ?? new Map();
const ordered = (key) => [...z(key).entries()].sort((a, b) => b[1] - a[1]);
const commands = {
  zrevrange: (key, start, stop) => ordered(key).slice(start, stop + 1).flatMap(([m, s]) => [m, String(s)]),
  zscore: (key, m) => (z(key).has(m) ? String(z(key).get(m)) : null),
  zrevrank: (key, m) => { const i = ordered(key).findIndex(([x]) => x === m); return i < 0 ? null : i; },
  zcard: (key) => z(key).size,
  zrem: (key, m) => (z(key).delete(m) ? 1 : 0),
  del: (key) => (hashes.delete(key) ? 1 : 0),
  hgetall: (key) => hashes.get(key) ?? {},
  hset: (key, obj) => { hashes.set(key, { ...(hashes.get(key) ?? {}), ...obj }); return 1; },
  expire: () => 1,
  exists: () => 0,
};
const fakeRedis = {
  ...Object.fromEntries(Object.entries(commands).map(([k, fn]) => [k, async (...a) => fn(...a)])),
  pipeline() {
    const ops = [];
    const p = new Proxy({}, {
      get: (_, name) => (name === 'exec'
        ? async () => ops.map(([n, a]) => [null, commands[n](...a)])
        : (...a) => { ops.push([name, a]); return p; }),
    });
    return p;
  },
};
mock.module(new URL('../src/config/redis.js', import.meta.url).href, {
  defaultExport: fakeRedis,
  namedExports: { isRedisUp: () => true, waitForRedis: async () => true, assertScorePackingSafe: async () => {} },
});

// ── Postgres: hunters 1..5 exist and are eligible; 3 has been deleted ───
const fake = createFakePrisma();
let existing = new Set();
fake.client.users.findMany = async ({ where = {} } = {}) => {
  const ids = where.id?.in ?? [];
  return ids.filter((id) => existing.has(id)).map((id) => ({ id, name: `H${id}`, avatars: null }));
};
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async () => ({}), mailTransporter: {} },
});

const { getLeaderboard, encodeScore } = await import('../src/services/leaderboardService.js');
const meSnapshot = { name: 'Me', avatarThumbUrl: null, leaderboardVisible: true, totalXp: 0 };

beforeEach(() => {
  zsets.clear();
  hashes.clear();
  const board = new Map();
  for (let i = 1; i <= 5; i++) {
    board.set(String(i), encodeScore(1000 - i * 10, BigInt(i)));
    hashes.set(`lb:u:${i}`, { name: `H${i}`, avatarThumbUrl: '' });
  }
  zsets.set('lb:global', board);
  existing = new Set([1n, 2n, 4n, 5n]); // hunter 3 was deleted from the DB
});

test('a deleted hunter is not shown, and the ranks close up', async () => {
  const page = await getLeaderboard({ meId: 99n, meSnapshot, scope: 'global', cursorStr: null, limit: 10 });
  assert.deepEqual(page.entries.map((e) => [e.userId, e.rank]), [['1', 1], ['2', 2], ['4', 3], ['5', 4]]);
});

test('the stale entry is removed from Redis for good', async () => {
  await getLeaderboard({ meId: 99n, meSnapshot, scope: 'global', cursorStr: null, limit: 10 });
  assert.equal(zsets.get('lb:global').has('3'), false);
  assert.equal(hashes.has('lb:u:3'), false);
});
