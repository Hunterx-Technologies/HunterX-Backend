// Hunters I blocked are left out of my global leaderboard; everyone else
// keeps their real rank, pages still fill, and paging doesn't skip or
// repeat anyone. Exercised on the Postgres path (no Redis in tests).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.WEBSITE_URL = 'https://www.example.com/';
delete process.env.REDIS_URL;

const fake = createFakePrisma();
// Ranked hunters 1..10, highest XP first (id 1 has the most).
const ranked = Array.from({ length: 10 }, (_, i) => ({
  id: BigInt(i + 1), name: `H${i + 1}`, avatars: null, user_progression: { total_xp: 1000 - i * 10 },
}));
// Stands in for the eligibility + keyset query: resumes after the cursor row.
fake.client.users.findMany = async ({ where = {}, take } = {}) => {
  let rows = ranked;
  const after = where.OR?.[1]?.AND?.[1]?.id?.gt;
  if (after != null) rows = rows.slice(rows.findIndex((r) => r.id === after) + 1);
  return rows.slice(0, take);
};
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/utils/mailer.js', import.meta.url).href, {
  namedExports: { sendMail: async () => ({}), mailTransporter: {} },
});

const { getLeaderboard } = await import('../src/services/leaderboardService.js');
const meSnapshot = { name: 'Me', avatarThumbUrl: null, leaderboardVisible: true, totalXp: 0 };
const meId = 99n;

beforeEach(() => { fake.models.user_blocks.rows.length = 0; });

const block = (...ids) => ids.forEach((id) => fake.models.user_blocks.rows.push({ id: BigInt(id), blocker_id: meId, blocked_id: BigInt(id) }));

async function readAll(limit) {
  const seen = [];
  let cursorStr = null;
  do {
    const page = await getLeaderboard({ meId, meSnapshot, scope: 'global', cursorStr, limit });
    seen.push(page.entries.map((e) => [e.userId, e.rank]));
    cursorStr = page.nextCursor;
  } while (cursorStr);
  return seen;
}

test('no blocks: unchanged', async () => {
  const pages = await readAll(4);
  assert.deepEqual(pages.flat().map(([, r]) => r), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test('blocked hunters are hidden, others keep their real rank, pages stay full', async () => {
  block(2, 3, 6);
  const pages = await readAll(3);
  assert.deepEqual(pages, [
    [['1', 1], ['4', 4], ['5', 5]],
    [['7', 7], ['8', 8], ['9', 9]],
    [['10', 10]],
  ]);
});

test('someone else\'s blocks don\'t hide anyone from me', async () => {
  fake.models.user_blocks.rows.push({ id: 50n, blocker_id: 5n, blocked_id: 1n });
  const pages = await readAll(10);
  assert.equal(pages.flat().length, 10);
});
