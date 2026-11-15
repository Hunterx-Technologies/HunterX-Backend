// Per-user calendar days (utils/userClock.js): "today" is the hunter's own
// local day, weeks start on their Monday, and a day ends at their midnight
// (DST included).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

const settings = new Map(); // userId string → timezone
const upserts = [];
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, {
  defaultExport: {
    user_settings: {
      findUnique: async ({ where }) => (settings.has(String(where.user_id)) ? { timezone: settings.get(String(where.user_id)) } : null),
      findMany: async ({ where }) => where.user_id.in
        .filter((id) => settings.has(String(id)))
        .map((id) => ({ user_id: id, timezone: settings.get(String(id)) })),
      upsert: async ({ where, update }) => { upserts.push(update.timezone); settings.set(String(where.user_id), update.timezone); },
    },
  },
});

const clock = await import('../src/utils/userClock.js');
const day = (s) => new Date(`${s}T00:00:00.000Z`);

test('the same instant is a different calendar day in different zones', () => {
  const at = new Date('2026-11-15T20:00:00Z'); // 01:30 on the 16th in India, 15:00 on the 15th in New York
  assert.equal(clock.getLocalDateOnly('Asia/Kolkata', 0, at).getTime(), day('2026-11-16').getTime());
  assert.equal(clock.getLocalDateOnly('America/New_York', 0, at).getTime(), day('2026-11-15').getTime());
  assert.equal(clock.getLocalDateOnly('Asia/Kolkata', -1, at).getTime(), day('2026-11-15').getTime());
});

test('the week starts on the local Monday', () => {
  const sundayNightUtc = new Date('2026-11-15T22:00:00Z'); // already Monday 16th in Tokyo
  assert.equal(clock.getLocalWeekStart('Asia/Tokyo', sundayNightUtc).getTime(), day('2026-11-16').getTime());
  assert.equal(clock.getLocalWeekStart('Europe/London', sundayNightUtc).getTime(), day('2026-11-09').getTime());
});

test('a local day ends at that zone\'s midnight, DST and :45 offsets included', () => {
  assert.equal(clock.localDayEnd(day('2026-11-15'), 'Asia/Kolkata').toISOString(), '2026-11-15T18:30:00.000Z');
  assert.equal(clock.localDayEnd(day('2026-11-15'), 'Asia/Kathmandu').toISOString(), '2026-11-15T18:15:00.000Z');
  // New York: EDT (UTC−4) until 1 Nov 2026, EST (UTC−5) after.
  assert.equal(clock.localDayEnd(day('2026-10-20'), 'America/New_York').toISOString(), '2026-10-21T04:00:00.000Z');
  assert.equal(clock.localDayEnd(day('2026-11-20'), 'America/New_York').toISOString(), '2026-11-21T05:00:00.000Z');
});

test('localDayOf puts an instant on the hunter\'s calendar', () => {
  const lateNightUs = new Date('2026-11-16T03:00:00Z'); // 22:00 on the 15th in New York
  assert.equal(clock.localDayOf(lateNightUs, 'America/New_York').getTime(), day('2026-11-15').getTime());
  assert.equal(clock.localDayOf(lateNightUs, 'Asia/Kolkata').getTime(), day('2026-11-16').getTime());
});

test('a user with no saved zone falls back to IST; an invalid header is ignored', async () => {
  assert.equal(await clock.getUserTimezone(1n), 'Asia/Kolkata');
  await clock.rememberUserTimezone(2n, 'Not/AZone');
  assert.equal(upserts.length, 0);
});

test('the X-Timezone zone is saved once and then served from the cache', async () => {
  await clock.rememberUserTimezone(3n, 'America/New_York');
  await clock.rememberUserTimezone(3n, 'America/New_York');
  assert.deepEqual(upserts, ['America/New_York']);
  assert.equal(await clock.getUserTimezone(3n), 'America/New_York');

  settings.set('4', 'Europe/Paris');
  const zones = await clock.getUserTimezones([3n, 4n, 5n]);
  assert.equal(zones.get('3'), 'America/New_York');
  assert.equal(zones.get('4'), 'Europe/Paris');
  assert.equal(zones.get('5'), 'Asia/Kolkata');
});
