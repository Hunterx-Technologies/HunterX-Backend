// Today's quest lists come back highest XP first (taskService.sortByXpDesc).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

delete process.env.REDIS_URL;
const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

const { sortByXpDesc } = await import('../src/services/taskService.js');

test('highest XP first, equal XP by title then id', () => {
  const tasks = [
    { id: 5n, title: 'Daily Journaling', xp_reward: 5 },
    { id: 1n, title: 'Sleep 8 Hours',    xp_reward: 10 },
    { id: 2n, title: 'Drink Water',      xp_reward: 10 },
    { id: 9n, title: 'Drink Water',      xp_reward: 10 },
    { id: 7n, title: 'Cold Shower',      xp_reward: 8 },
  ];
  assert.deepEqual(sortByXpDesc(tasks).map((t) => t.id), [2n, 9n, 1n, 7n, 5n]);
  assert.equal(tasks[0].id, 5n); // input left as it was
});
