// Scheduled / recurring broadcasts: local-time occurrence math, and the
// scheduler lifecycle — each hunter gets it at the chosen wall clock in
// their own timezone; claimed once, queued with retries, SENT only after
// delivery, recurring advance, pause/resume, cancel, missed runs, cleanup.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { model } from './support/fakePrisma.js';

// ── In-memory prisma for the schedule tables, notifications, user_settings ──
const schedules = model([]);
const runs = model([]);
const notifications = model([]);
let hunterZones = []; // distinct user_settings.timezone values

const withRuns = (row, include) => {
  if (!row || !include?.runs) return row;
  const take = include.runs.take ?? Infinity;
  const own = runs.rows
    .filter((r) => r.schedule_id === row.id)
    .sort((a, b) => b.run_for - a.run_for)
    .slice(0, take)
    .map((r) => ({ ...r }));
  return { ...row, runs: own };
};

const client = {
  broadcast_schedules: {
    ...schedules,
    findMany: async (args = {}) => (await schedules.findMany(args)).map((r) => withRuns(r, args.include)),
    findUnique: async (args) => withRuns(await schedules.findUnique(args), args.include),
    deleteMany: async (args) => {
      const doomed = schedules.rows.filter((r) => (args.where.status.in.includes(r.status) && r.completed_at < args.where.completed_at.lt));
      for (const s of doomed) runs.rows.filter((r) => r.schedule_id === s.id).forEach((r) => { r.schedule_id = null; });
      return schedules.deleteMany(args);
    },
  },
  broadcast_schedule_runs: {
    ...runs,
    findMany: async (args = {}) => (await runs.findMany(args)).map((r) => (
      args.include?.schedule ? { ...r, schedule: schedules.rows.find((s) => s.id === r.schedule_id) ?? null } : r
    )),
    createMany: async ({ data, skipDuplicates }) => {
      let count = 0;
      for (const row of data) {
        const dup = runs.rows.some((r) => r.schedule_id === row.schedule_id && r.run_for.getTime() === row.run_for.getTime());
        if (dup && skipDuplicates) continue;
        if (dup) throw new Error('unique violation');
        await runs.create({ data: { attempts: 0, ...row } });
        count++;
      }
      return { count };
    },
  },
  notifications: {
    ...notifications,
    groupBy: async ({ by, where }) => {
      const groups = new Map();
      for (const n of await notifications.findMany({ where })) {
        const key = by.map((k) => n[k]).join('|');
        const g = groups.get(key) ?? { ...Object.fromEntries(by.map((k) => [k, n[k]])), _count: { _all: 0 } };
        g._count._all++;
        groups.set(key, g);
      }
      return [...groups.values()];
    },
  },
  user_settings: { findMany: async () => hunterZones.map((timezone) => ({ timezone })) },
  $transaction: async (arg) => (typeof arg === 'function' ? arg(client) : Promise.all(arg)),
};
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: client });

// ── broadcastService stand-in: one recipient per hunter timezone ──
const queued = [];
let failQueue = 0;
const { localToUtc, nextOccurrence, wallClock, adminWallNow } = await import('../src/utils/broadcastSchedule.js');
mock.module(new URL('../src/services/broadcastService.js', import.meta.url).href, {
  namedExports: {
    BROADCAST_AUDIENCES: ['all', 'inactive'],
    broadcastDedupeKey: (id) => `broadcast:${id}`,
    validateBroadcast: ({ title, body, url, audience, inactive_days }) => {
      if (!title) throw new Error('TITLE_REQUIRED');
      if (!['all', 'inactive'].includes(audience)) throw new Error('INVALID_AUDIENCE');
      return { title, body, url: url ?? null, audience, days: audience === 'inactive' ? inactive_days : null };
    },
    queueBroadcast: async (input, { broadcastId, localWall }) => {
      if (failQueue > 0) {
        failQueue--;
        throw new Error('db down');
      }
      queued.push({ broadcastId, localWall });
      const zones = ['Asia/Kolkata', ...hunterZones];
      for (const [i, tz] of zones.entries()) {
        await notifications.create({
          data: {
            user_id: BigInt(i + 1), tz, type: 'BROADCAST', dedupe_key: `broadcast:${broadcastId}`,
            push_status: 'PENDING', deliver_after: localToUtc(localWall, tz),
          },
        });
      }
      return { recipients: zones.length, reachable_by_push: zones.length };
    },
  },
});

const svc = await import('../src/services/broadcastScheduleService.js');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const content = { title: 'Season 2', body: 'Go', audience: 'all' };
const iso = (d) => new Date(d).toISOString();

beforeEach(() => {
  schedules.rows.length = 0;
  runs.rows.length = 0;
  notifications.rows.length = 0;
  queued.length = 0;
  failQueue = 0;
  hunterZones = [];
});

// Create with a clock well before any send time used below.
const create = (payload) => svc.createSchedule('1', { ...content, ...payload }, new Date('2026-01-01T00:00:00Z'));

// ── Local-time math ──────────────────────────────────────

test('a wall clock maps to each timezone’s own instant (DST-aware)', () => {
  const wall = wallClock('2026-11-10', '09:00');
  assert.equal(iso(localToUtc(wall, 'Asia/Kolkata')), '2026-11-10T03:30:00.000Z');
  assert.equal(iso(localToUtc(wall, 'Europe/London')), '2026-11-10T09:00:00.000Z'); // GMT in Nov
  assert.equal(iso(localToUtc(wall, 'America/New_York')), '2026-11-10T14:00:00.000Z'); // EST
  assert.equal(iso(localToUtc(wall, 'Australia/Sydney')), '2026-11-09T22:00:00.000Z'); // AEDT
  const summer = wallClock('2026-07-10', '09:00');
  assert.equal(iso(localToUtc(summer, 'Europe/London')), '2026-07-10T08:00:00.000Z'); // BST
  assert.equal(iso(localToUtc(wall, 'Not/AZone')), '2026-11-10T03:30:00.000Z', 'bad zone → IST');
});

test('admin "now" is the IST wall clock', () => {
  assert.equal(iso(adminWallNow(new Date('2026-11-10T03:30:00Z'))), '2026-11-10T09:00:00.000Z');
});

test('one-time: the anchor if still ahead, otherwise nothing', () => {
  const s = { startDate: '2026-11-12', sendTime: '09:00', recurrence: 'NONE' };
  assert.equal(iso(nextOccurrence(s, wallClock('2026-11-12', '08:59'))), '2026-11-12T09:00:00.000Z');
  assert.equal(nextOccurrence(s, wallClock('2026-11-12', '09:00')), null);
});

test('daily and weekly step from the anchor', () => {
  const daily = { startDate: '2026-11-01', sendTime: '09:00', recurrence: 'DAILY' };
  assert.equal(iso(nextOccurrence(daily, wallClock('2026-11-08', '09:00'))), '2026-11-09T09:00:00.000Z');
  assert.equal(iso(nextOccurrence(daily, wallClock('2026-11-08', '08:30'))), '2026-11-08T09:00:00.000Z');
  const weekly = { startDate: '2026-11-02', sendTime: '20:15', recurrence: 'WEEKLY' }; // a Monday
  assert.equal(iso(nextOccurrence(weekly, wallClock('2026-11-20', '00:00'))), '2026-11-23T20:15:00.000Z');
});

test('monthly keeps its day, clamping to short months without drifting', () => {
  const s = { startDate: '2026-01-31', sendTime: '10:00', recurrence: 'MONTHLY' };
  const feb = nextOccurrence(s, wallClock('2026-02-01', '00:00'));
  assert.equal(iso(feb).slice(0, 10), '2026-02-28');
  assert.equal(iso(nextOccurrence(s, feb)).slice(0, 10), '2026-03-31');
  assert.equal(iso(nextOccurrence(s, wallClock('2028-02-01', '00:00'))).slice(0, 10), '2028-02-29');
});

// ── Admin actions ────────────────────────────────────────

test('a send time in the past (on the admin’s IST clock) is refused', async () => {
  await assert.rejects(svc.createSchedule('1', { ...content, send_date: '2020-01-01', send_time: '09:00' }), /SEND_TIME_IN_PAST/);
  // 08:00 UTC = 13:30 IST, so 10:00 that day has passed for the admin.
  await assert.rejects(
    svc.createSchedule('1', { ...content, send_date: '2026-11-10', send_time: '10:00' }, new Date('2026-11-10T08:00:00Z')),
    /SEND_TIME_IN_PAST/
  );
});

test('invalid timing is refused', async () => {
  await assert.rejects(create({ send_date: '2026-02-30', send_time: '09:00' }), /INVALID_SEND_DATE/);
  await assert.rejects(create({ send_date: '2026-02-01', send_time: '9am' }), /INVALID_SEND_TIME/);
  await assert.rejects(create({ send_date: '2026-02-01', send_time: '09:00', recurrence: 'HOURLY' }), /INVALID_RECURRENCE/);
});

// ── Scheduler lifecycle ──────────────────────────────────

test('every hunter gets it at 09:00 their own time — Sydney, India, London, New York', async () => {
  hunterZones = ['Australia/Sydney', 'Europe/London', 'America/New_York'];
  const s = await create({ send_date: '2026-11-10', send_time: '09:00' });
  assert.equal(s.next_send_local, '2026-11-10T09:00');

  // Nothing before the earliest hunter timezone (Sydney, 22:00 UTC the day before) gets there.
  await svc.runBroadcastScheduler(new Date('2026-11-09T21:59:00Z'));
  assert.equal(queued.length, 0);

  await svc.runBroadcastScheduler(new Date('2026-11-09T22:00:00Z'));
  assert.equal(queued.length, 1, 'claimed when Sydney reaches 09:00');
  assert.equal(iso(queued[0].localWall), '2026-11-10T09:00:00.000Z');
  const due = Object.fromEntries(notifications.rows.map((n) => [n.tz, iso(n.deliver_after)]));
  assert.deepEqual(due, {
    'Australia/Sydney': '2026-11-09T22:00:00.000Z',
    'Asia/Kolkata':     '2026-11-10T03:30:00.000Z',
    'Europe/London':    '2026-11-10T09:00:00.000Z',
    'America/New_York': '2026-11-10T14:00:00.000Z',
  });
  assert.equal(schedules.rows[0].status, 'SENDING');

  // Still SENDING while New York hasn't been reached.
  notifications.rows.filter((n) => n.tz !== 'America/New_York').forEach((n) => { n.push_status = 'SENT'; });
  await svc.runBroadcastScheduler(new Date('2026-11-10T10:00:00Z'));
  assert.equal(schedules.rows[0].status, 'SENDING');

  notifications.rows.forEach((n) => { n.push_status = 'SENT'; });
  await svc.runBroadcastScheduler(new Date('2026-11-10T14:01:00Z'));
  assert.equal(schedules.rows[0].status, 'SENT');
  assert.equal(queued.length, 1, 'sent exactly once');
});

test('one-time: sent once, SENT only after delivery, cleaned up a week later', async () => {
  const s = await create({ send_date: '2026-11-12', send_time: '09:00' });
  assert.equal(s.status, 'SCHEDULED');
  const due = new Date('2026-11-12T03:30:00Z'); // 09:00 IST — only IST hunters

  await svc.runBroadcastScheduler(new Date(due.getTime() - MIN));
  assert.equal(queued.length, 0);

  await svc.runBroadcastScheduler(due);
  await svc.runBroadcastScheduler(new Date(due.getTime() + 30 * 1000)); // a second tick in the same minute
  assert.equal(queued.length, 1, 'queued exactly once');
  assert.equal(runs.rows.length, 1);
  assert.equal(runs.rows[0].status, 'QUEUED');
  assert.equal(schedules.rows[0].status, 'SENDING', 'still active while pushes are pending');

  notifications.rows.forEach((n) => { n.push_status = 'SENT'; });
  await svc.runBroadcastScheduler(new Date(due.getTime() + 2 * MIN));
  assert.equal(schedules.rows[0].status, 'SENT');
  assert.equal((await svc.listSchedules()).schedules.length, 0, 'gone from the active list');

  await svc.runBroadcastScheduler(new Date(due.getTime() + 6 * DAY));
  assert.equal(schedules.rows.length, 1, 'kept for a week');
  await svc.runBroadcastScheduler(new Date(due.getTime() + 7 * DAY + 3 * MIN));
  assert.equal(schedules.rows.length, 0, 'deleted after a week');
  assert.equal(runs.rows.length, 1, 'delivery log kept');
  assert.equal(runs.rows[0].schedule_id, null);
});

test('one-time: a failed queue is retried, then FAILED — never SENT or cleaned up', async () => {
  await create({ send_date: '2026-11-12', send_time: '09:00' });
  const due = new Date('2026-11-12T03:30:00Z');
  failQueue = 3;
  await svc.runBroadcastScheduler(due);
  assert.equal(runs.rows[0].status, 'QUEUING', 'retried next tick');
  await svc.runBroadcastScheduler(new Date(due.getTime() + MIN));
  await svc.runBroadcastScheduler(new Date(due.getTime() + 2 * MIN));
  assert.equal(runs.rows[0].status, 'FAILED');
  assert.equal(schedules.rows[0].status, 'FAILED');
  await svc.runBroadcastScheduler(new Date(due.getTime() + 30 * DAY));
  assert.equal(schedules.rows.length, 1, 'a failed schedule is never auto-deleted');
});

test('one-time: a transient failure recovers on retry', async () => {
  await create({ send_date: '2026-11-12', send_time: '09:00' });
  const due = new Date('2026-11-12T03:30:00Z');
  failQueue = 1;
  await svc.runBroadcastScheduler(due);
  await svc.runBroadcastScheduler(new Date(due.getTime() + MIN));
  assert.equal(runs.rows[0].status, 'QUEUED');
  assert.equal(queued.length, 1);
});

test('recurring daily: one run per occurrence, next occurrence advances, stays active', async () => {
  await create({ send_date: '2026-11-12', send_time: '09:00', recurrence: 'DAILY' });
  const day1 = new Date('2026-11-12T03:30:00Z');
  await svc.runBroadcastScheduler(day1);
  await svc.runBroadcastScheduler(new Date(day1.getTime() + MIN));
  assert.equal(queued.length, 1);
  assert.equal(schedules.rows[0].status, 'SCHEDULED');
  assert.equal(iso(schedules.rows[0].next_run_at), '2026-11-13T09:00:00.000Z');

  await svc.runBroadcastScheduler(new Date(day1.getTime() + DAY));
  assert.equal(queued.length, 2);
  assert.equal(schedules.rows[0].run_count, 2);
  assert.equal(new Set(queued.map((q) => q.broadcastId)).size, 2, 'each run has its own broadcast id');
});

test('recurring: pause stops sends, resume skips to the next future occurrence', async () => {
  const s = await create({ send_date: '2026-11-12', send_time: '09:00', recurrence: 'DAILY' });
  await svc.pauseSchedule(s.id);
  await svc.runBroadcastScheduler(new Date('2026-11-14T04:00:00Z'));
  assert.equal(queued.length, 0);

  const resumed = await svc.resumeSchedule(s.id, new Date('2026-11-14T04:00:00Z')); // 09:30 IST
  assert.equal(resumed.status, 'SCHEDULED');
  assert.equal(resumed.next_send_local, '2026-11-15T09:00');
});

test('recurring: an occurrence missed by more than 6 hours is logged as skipped, not sent late', async () => {
  await create({ send_date: '2026-11-12', send_time: '09:00', recurrence: 'DAILY' });
  await svc.runBroadcastScheduler(new Date('2026-11-12T12:00:00Z')); // 8.5 h after IST's 09:00
  assert.equal(queued.length, 0);
  assert.equal(runs.rows[0].status, 'SKIPPED');
  assert.equal(iso(schedules.rows[0].next_run_at), '2026-11-13T09:00:00.000Z');
});

test('cancelling mid-delivery withdraws timezones not reached yet; finished ones cannot be edited', async () => {
  hunterZones = ['America/New_York'];
  const s = await create({ send_date: '2026-11-12', send_time: '09:00' });
  await svc.runBroadcastScheduler(new Date('2026-11-12T03:30:00Z')); // India due now, New York later
  await assert.rejects(
    svc.updateSchedule(s.id, { ...content, send_date: '2027-01-01', send_time: '09:00' }, new Date('2026-11-12T03:31:00Z')),
    /SCHEDULE_NOT_EDITABLE/
  );
  const cancelled = await svc.cancelSchedule(s.id, new Date('2026-11-12T03:31:00Z'));
  assert.equal(cancelled.status, 'CANCELLED');
  assert.deepEqual(notifications.rows.map((n) => n.tz), ['Asia/Kolkata'], 'New York row withdrawn, India kept');
});

test('a cancelled recurring schedule never sends', async () => {
  const r = await create({ send_date: '2026-12-01', send_time: '09:00', recurrence: 'WEEKLY' });
  await svc.cancelSchedule(r.id);
  await svc.runBroadcastScheduler(new Date('2026-12-01T03:30:00Z'));
  assert.equal(queued.length, 0);
});

test('a run claimed just before a pause is skipped, not sent', async () => {
  await create({ send_date: '2026-11-12', send_time: '09:00', recurrence: 'DAILY' });
  failQueue = 1; // first attempt fails, leaving the run QUEUING
  await svc.runBroadcastScheduler(new Date('2026-11-12T03:30:00Z'));
  schedules.rows[0].status = 'PAUSED';
  await svc.runBroadcastScheduler(new Date('2026-11-12T03:31:00Z'));
  assert.equal(queued.length, 0);
  assert.equal(runs.rows[0].status, 'SKIPPED');
});
