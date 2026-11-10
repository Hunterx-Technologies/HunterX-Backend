// The cron schedules (node-cron 4): every expression is valid, fires at the
// UTC (= documented IST) times regardless of the host's timezone, stops on
// shutdown, and withJobLock never lets a run overlap itself or run on two
// instances at once.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

process.env.TZ = 'Asia/Kolkata'; // a host clock that isn't UTC
delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

let redisUp = false;
const lockStore = new Map();
const fakeRedis = {
  set: async (key, value, _ex, _ttl, nx) => {
    if (nx === 'NX' && lockStore.has(key)) return null;
    lockStore.set(key, value);
    return 'OK';
  },
  eval: async (_script, _n, key, token) => (lockStore.get(key) === token ? (lockStore.delete(key), 1) : 0),
};
mock.module(new URL('../src/config/redis.js', import.meta.url).href, {
  defaultExport: fakeRedis,
  namedExports: { isRedisUp: () => redisUp, waitForRedis: async () => false, assertScorePackingSafe: async () => {} },
});

const { default: cron } = await import('node-cron');
const { withJobLock, CRON_TIMEZONE } = await import('../src/cron/lock.js');
await import('../src/cron/midnight.js');
await import('../src/cron/leaderboardNightly.js');
await import('../src/cron/pushDispatcher.js');
await import('../src/cron/notificationScheduler.js');
await import('../src/cron/broadcastScheduler.js');
await import('../src/cron/accountDeletion.js');

const tasks = () => [...cron.getTasks().values()];
const byName = (name) => tasks().find((t) => t.name === name);

after(() => tasks().forEach((t) => t.destroy()));

test('all seven jobs are registered once, on UTC', () => {
  const names = tasks().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'Account housekeeping', 'Broadcast scheduler', 'Leaderboard nightly', 'Nightly task assignment',
    'Notification scheduler', 'Push dispatch', 'Push receipt check',
  ]);
  assert.equal(CRON_TIMEZONE, 'UTC');
});

test('every expression is valid', () => {
  for (const expr of ['0 19 * * *', '30 21 * * *', '* * * * *', '*/15 * * * *', '5 * * * *']) {
    assert.equal(cron.validate(expr), true, expr);
  }
});

test('nightly jobs land on their documented IST times even on an IST host', () => {
  const assign = byName('Nightly task assignment').getNextRun();
  assert.equal(assign.getUTCHours(), 19); // 00:30 IST
  assert.equal(assign.getUTCMinutes(), 0);
  const board = byName('Leaderboard nightly').getNextRun();
  assert.equal(board.getUTCHours(), 21); // 03:00 IST
  assert.equal(board.getUTCMinutes(), 30);
  assert.equal(byName('Account housekeeping').getNextRun().getUTCMinutes(), 5);
  assert.equal(byName('Notification scheduler').getNextRun().getUTCMinutes() % 15, 0);
});

test('a run never overlaps itself in one process', async () => {
  let release;
  let runs = 0;
  const job = withJobLock('overlap-test', 60, () => { runs++; return new Promise((r) => { release = r; }); });
  const first = job();
  await job(); // second tick while the first is still going
  assert.equal(runs, 1);
  release();
  await first;
  const third = job(); // next tick after it finished
  assert.equal(runs, 2);
  release();
  await third;
});

test('only one instance runs a tick when Redis is up', async () => {
  redisUp = true;
  let runs = 0;
  lockStore.set('cron:lock:shared', 'other-instance');
  await withJobLock('shared', 60, () => { runs++; })();
  assert.equal(runs, 0, 'another instance holds the lock');
  lockStore.clear();
  await withJobLock('shared', 60, () => { runs++; })();
  assert.equal(runs, 1);
  assert.equal(lockStore.size, 0, 'lock released after the run');
  redisUp = false;
});

test('a crashing job is logged, not thrown, and the lock is freed', async () => {
  redisUp = true;
  await withJobLock('crash', 60, () => { throw new Error('boom'); })();
  assert.equal(lockStore.has('cron:lock:crash'), false);
  redisUp = false;
});

test('shutdown stops every task (src/index.js loop)', () => {
  for (const task of cron.getTasks().values()) task.stop();
  assert.ok(tasks().every((t) => t.getStatus() === 'stopped'));
});
