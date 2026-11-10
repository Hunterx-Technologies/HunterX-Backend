// src/services/broadcastScheduleService.js — Scheduled + recurring broadcasts.
//
// The admin picks a date + time that every hunter receives in their OWN
// timezone ("10 Nov 09:00" = 09:00 in India, then 09:00 in London, then
// 09:00 in New York). next_run_at holds that wall clock with no zone (see
// utils/broadcastSchedule.js). An occurrence is claimed when the earliest
// timezone any hunter is in reaches it; every recipient's row is written
// then, with deliver_after = their own local instant, so the push outbox
// and the inbox each release it at the right moment per hunter.
//
// Lifecycle (status on broadcast_schedules):
//   one-time:  SCHEDULED → SENDING → SENT → deleted CLEANUP_AFTER_MS later
//   recurring: SCHEDULED → (run, next_run_at advances) → … until PAUSED/CANCELLED
//   FAILED:    a one-time run that could not be queued (or was missed while
//              the server was down) — editable, so the admin can reschedule.
//
// runBroadcastScheduler() runs every minute (cron/broadcastScheduler.js,
// one instance per tick via the Redis job lock):
//   1. claim due schedules (earliest hunter timezone has reached the
//      wall clock) — a conditional update on (id, status,
//      next_run_at) advances the schedule and inserts its run row in one
//      transaction; UNIQUE (schedule_id, run_for) makes a second claim of
//      the same occurrence a no-op, so nothing is sent twice
//   2. queue QUEUING runs into the notifications outbox (broadcastService.
//      queueBroadcast — idempotent per broadcast_id, so a crash mid-run is
//      safely retried); up to MAX_RUN_ATTEMPTS, then FAILED
//   3. mark one-time schedules SENT once none of their pushes are still
//      PENDING/SENDING (the push dispatcher retries / expires failures)
//   4. delete SENT / CANCELLED schedules CLEANUP_AFTER_MS after they
//      finished; their run rows (the delivery log) are kept
//
// Delivery itself (quiet hours, retries, receipts) is the existing push
// outbox — see pushDispatchService.js.

import { randomUUID } from 'node:crypto';
import prisma from '../config/prisma.js';
import { validateBroadcast, queueBroadcast, broadcastDedupeKey } from './broadcastService.js';
import { pageInfo } from '../utils/pageInfo.js';
import {
  RECURRENCES, EARLIEST_AHEAD_MS, adminWallNow, formatWall, localToUtc, nextOccurrence, wallClock,
} from '../utils/broadcastSchedule.js';
import { DEFAULT_TIMEZONE } from '../utils/timezone.js';
import { parseDateOnly } from '../utils/helpers.js';
import { isValidTimeOfDay } from '../utils/timezone.js';
import { info, logError } from '../utils/logger.js';

const MINUTE_MS          = 60 * 1000;
const DAY_MS             = 24 * 60 * MINUTE_MS;
const MISSED_GRACE_MS    = 6 * 60 * MINUTE_MS; // last timezone passed it longer ago than this → skip (matches the push outbox max age)
const CLEANUP_AFTER_MS   = 7 * DAY_MS;
const MAX_RUN_ATTEMPTS   = 3;
const CLAIM_BATCH        = 20;
const RUN_BATCH          = 5;

export const ACTIVE_STATUSES   = ['SCHEDULED', 'PAUSED', 'SENDING', 'FAILED'];
const EDITABLE_STATUSES        = ['SCHEDULED', 'PAUSED', 'FAILED'];
const CANCELLABLE_STATUSES     = ['SCHEDULED', 'PAUSED', 'SENDING', 'FAILED'];

// ── Validation ─────────────────────────────────────────────

function parseId(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('SCHEDULE_NOT_FOUND');
  return BigInt(id);
}

function validateSchedule(payload) {
  const content = validateBroadcast(payload);

  const recurrence = payload.recurrence ?? 'NONE';
  if (!RECURRENCES.includes(recurrence)) throw new Error('INVALID_RECURRENCE');

  const startDate = parseDateOnly(payload.send_date);
  if (!startDate) throw new Error('INVALID_SEND_DATE');
  if (!isValidTimeOfDay(payload.send_time)) throw new Error('INVALID_SEND_TIME');

  return {
    content,
    timing: { startDate, sendTime: payload.send_time, recurrence },
  };
}

function scheduleFields({ content, timing }) {
  return {
    title:         content.title,
    body:          content.body,
    url:           content.url,
    audience:      content.audience,
    inactive_days: content.days,
    recurrence:    timing.recurrence,
    start_date:    timing.startDate,
    send_time:     timing.sendTime,
  };
}

function toTiming(row) {
  return { startDate: row.start_date, sendTime: row.send_time, recurrence: row.recurrence };
}

// ── Admin actions ──────────────────────────────────────────

// `now` is injectable for tests; routes never pass it.
export async function createSchedule(adminId, payload, now = new Date()) {
  const parsed = validateSchedule(payload ?? {});
  const first = wallClock(parsed.timing.startDate, parsed.timing.sendTime);
  if (first <= adminWallNow(now)) throw new Error('SEND_TIME_IN_PAST');

  const row = await prisma.broadcast_schedules.create({
    data: {
      ...scheduleFields(parsed),
      next_run_at: first,
      status:      'SCHEDULED',
      created_by:  adminId == null ? null : BigInt(adminId),
      created_at:  now,
      updated_at:  now,
    },
  });
  return getSchedule(row.id);
}

// Edits content and/or timing. The conditional on updated_at stops an edit
// from overwriting a run the scheduler claimed since the admin loaded it.
export async function updateSchedule(id, payload, now = new Date()) {
  const existing = await findOrThrow(id);
  if (!EDITABLE_STATUSES.includes(existing.status)) throw new Error('SCHEDULE_NOT_EDITABLE');

  const parsed = validateSchedule(payload ?? {});
  let status = existing.status === 'PAUSED' ? 'PAUSED' : 'SCHEDULED';
  let nextRunAt = null;

  if (parsed.timing.recurrence === 'NONE') {
    // A paused schedule switched to one-time just becomes scheduled again.
    status = 'SCHEDULED';
    nextRunAt = wallClock(parsed.timing.startDate, parsed.timing.sendTime);
    if (nextRunAt <= adminWallNow(now)) throw new Error('SEND_TIME_IN_PAST');
  } else if (status === 'SCHEDULED') {
    nextRunAt = nextOccurrence(parsed.timing, adminWallNow(now));
  }

  const { count } = await prisma.broadcast_schedules.updateMany({
    where: { id: existing.id, updated_at: existing.updated_at, status: existing.status },
    data:  { ...scheduleFields(parsed), status, next_run_at: nextRunAt, last_error: null, updated_at: now },
  });
  if (count === 0) throw new Error('SCHEDULE_CHANGED');
  return getSchedule(existing.id);
}

export async function pauseSchedule(id) {
  const existing = await findOrThrow(id);
  if (existing.recurrence === 'NONE') throw new Error('NOT_RECURRING');
  if (existing.status !== 'SCHEDULED') throw new Error('SCHEDULE_NOT_ACTIVE');
  await transition(existing, { status: 'PAUSED', next_run_at: null });
  return getSchedule(existing.id);
}

export async function resumeSchedule(id, now = new Date()) {
  const existing = await findOrThrow(id);
  if (existing.recurrence === 'NONE') throw new Error('NOT_RECURRING');
  if (existing.status !== 'PAUSED') throw new Error('SCHEDULE_NOT_PAUSED');
  // Occurrences that fell inside the pause are skipped, not caught up.
  const next = nextOccurrence(toTiming(existing), adminWallNow(now));
  await transition(existing, { status: 'SCHEDULED', next_run_at: next, last_error: null });
  return getSchedule(existing.id);
}

// Cancelling also withdraws deliveries already written but not yet due —
// timezones the send hasn't reached yet. Hunters who got it keep it.
export async function cancelSchedule(id, now = new Date()) {
  const existing = await findOrThrow(id);
  if (!CANCELLABLE_STATUSES.includes(existing.status)) throw new Error('SCHEDULE_NOT_CANCELLABLE');
  await transition(existing, { status: 'CANCELLED', next_run_at: null, completed_at: now });

  const runs = await prisma.broadcast_schedule_runs.findMany({
    where:  { schedule_id: existing.id, status: 'QUEUED' },
    select: { broadcast_id: true },
  });
  if (runs.length > 0) {
    await prisma.notifications.deleteMany({
      where: {
        type:          'BROADCAST',
        dedupe_key:    { in: runs.map((r) => broadcastDedupeKey(r.broadcast_id)) },
        push_status:   'PENDING',
        deliver_after: { gt: now },
      },
    });
  }
  return getSchedule(existing.id);
}

async function findOrThrow(id) {
  const row = await prisma.broadcast_schedules.findUnique({ where: { id: parseId(id) } });
  if (!row) throw new Error('SCHEDULE_NOT_FOUND');
  return row;
}

async function transition(existing, data) {
  const { count } = await prisma.broadcast_schedules.updateMany({
    where: { id: existing.id, updated_at: existing.updated_at, status: existing.status },
    data:  { ...data, updated_at: new Date() },
  });
  if (count === 0) throw new Error('SCHEDULE_CHANGED');
}

// ── Listing ────────────────────────────────────────────────

const RUNS_PER_SCHEDULE = 5;

export async function listSchedules({ scope, page, limit } = {}) {
  const take = Math.max(1, Math.min(50, parseInt(limit) || 10));
  const pageNo = Math.max(1, parseInt(page) || 1);
  const where = scope === 'all' ? {} : { status: { in: ACTIVE_STATUSES } };
  const [total, rows] = await Promise.all([
    prisma.broadcast_schedules.count({ where }),
    prisma.broadcast_schedules.findMany({
      where,
      orderBy: [{ next_run_at: { sort: 'asc', nulls: 'last' } }, { id: 'desc' }],
      skip:    (pageNo - 1) * take,
      take,
      include: { runs: { orderBy: { run_for: 'desc' }, take: RUNS_PER_SCHEDULE } },
    }),
  ]);
  const stats = await deliveryStats(rows.flatMap((r) => r.runs));
  return { schedules: rows.map((r) => serialize(r, stats)), pagination: pageInfo(pageNo, take, total) };
}

export async function getSchedule(id) {
  const row = await prisma.broadcast_schedules.findUnique({
    where:   { id: typeof id === 'bigint' ? id : parseId(id) },
    include: { runs: { orderBy: { run_for: 'desc' }, take: RUNS_PER_SCHEDULE } },
  });
  if (!row) throw new Error('SCHEDULE_NOT_FOUND');
  return serialize(row, await deliveryStats(row.runs));
}

// Push status counts per run, from the notifications rows it wrote.
async function deliveryStats(runs) {
  const keys = runs.filter((r) => r.status === 'QUEUED').map((r) => broadcastDedupeKey(r.broadcast_id));
  if (keys.length === 0) return new Map();
  const groups = await prisma.notifications.groupBy({
    by:     ['dedupe_key', 'push_status'],
    where:  { type: 'BROADCAST', dedupe_key: { in: keys } },
    _count: { _all: true },
  });
  const out = new Map();
  for (const g of groups) {
    const s = out.get(g.dedupe_key) ?? { pushed: 0, pending: 0, not_pushed: 0 };
    if (g.push_status === 'SENT') s.pushed += g._count._all;
    else if (g.push_status === 'PENDING' || g.push_status === 'SENDING') s.pending += g._count._all;
    else s.not_pushed += g._count._all;
    out.set(g.dedupe_key, s);
  }
  return out;
}

function serialize(row, stats) {
  return {
    id:            String(row.id),
    title:         row.title,
    body:          row.body,
    url:           row.url,
    audience:      row.audience,
    inactive_days: row.inactive_days,
    recurrence:    row.recurrence,
    send_date:     row.start_date.toISOString().slice(0, 10),
    send_time:     row.send_time,
    next_send_local: formatWall(row.next_run_at), // wall clock, each hunter's own timezone
    status:        row.status,
    run_count:     row.run_count,
    last_run_at:   row.last_run_at,
    completed_at:  row.completed_at,
    last_error:    row.last_error,
    created_at:    row.created_at,
    runs: row.runs.map((run) => ({
      id:                String(run.id),
      broadcast_id:      run.broadcast_id,
      run_for_local:     formatWall(run.run_for),
      status:            run.status,
      recipients:        run.recipients,
      reachable_by_push: run.reachable_by_push,
      error:             run.error,
      queued_at:         run.queued_at,
      ...(stats.get(broadcastDedupeKey(run.broadcast_id)) ?? { pushed: 0, pending: 0, not_pushed: 0 }),
    })),
  };
}

// ── Scheduler tick ─────────────────────────────────────────

export async function runBroadcastScheduler(now = new Date()) {
  const claimed   = await claimDueSchedules(now);
  const queued    = await processQueuingRuns();
  const completed = await completeSentSchedules(now);
  const cleaned   = await cleanupFinishedSchedules(now);
  if (claimed || queued || completed || cleaned) {
    info(`Broadcast scheduler: claimed ${claimed}, queued ${queued}, completed ${completed}, cleaned ${cleaned}`);
  }
  return { claimed, queued, completed, cleaned };
}

// Distinct hunter timezones (plus the default for hunters without
// settings) — tells when each occurrence starts and stops arriving.
async function hunterTimezones() {
  const rows = await prisma.user_settings.findMany({ distinct: ['timezone'], select: { timezone: true } });
  return [...new Set([DEFAULT_TIMEZONE, ...rows.map((r) => r.timezone).filter(Boolean)])];
}

function arrivalWindow(wall, timezones) {
  let first = Infinity;
  let last = -Infinity;
  for (const tz of timezones) {
    const at = localToUtc(wall, tz).getTime();
    if (at < first) first = at;
    if (at > last) last = at;
  }
  return { first, last };
}

async function claimDueSchedules(now) {
  // Cheap pre-filter: no timezone reaches a wall clock more than 14 h early.
  const candidates = await prisma.broadcast_schedules.findMany({
    where:   { status: 'SCHEDULED', next_run_at: { lte: new Date(now.getTime() + EARLIEST_AHEAD_MS) } },
    orderBy: { next_run_at: 'asc' },
    take:    CLAIM_BATCH,
  });
  if (candidates.length === 0) return 0;

  const timezones = await hunterTimezones();
  let claimed = 0;
  for (const s of candidates) {
    const runFor = s.next_run_at; // wall clock
    const { first, last } = arrivalWindow(runFor, timezones);
    if (now.getTime() < first) continue; // no hunter's clock has reached it yet

    const missed    = now.getTime() - last > MISSED_GRACE_MS;
    const oneTime   = s.recurrence === 'NONE';
    const missedMsg = 'Missed its send time while the server was unavailable';
    // Recurring: the next occurrence not already fully missed (catching up
    // after downtime would otherwise log a skipped run per tick).
    const resumeAfter = new Date(Math.max(runFor.getTime(), now.getTime() - EARLIEST_AHEAD_MS - MISSED_GRACE_MS));

    const scheduleUpdate = oneTime
      ? { status: missed ? 'FAILED' : 'SENDING', next_run_at: null, last_error: missed ? missedMsg : null }
      : { next_run_at: nextOccurrence(toTiming(s), resumeAfter), ...(missed ? { last_error: missedMsg } : {}) };

    try {
      await prisma.$transaction(async (tx) => {
        const { count } = await tx.broadcast_schedules.updateMany({
          where: { id: s.id, status: 'SCHEDULED', next_run_at: runFor },
          data:  {
            ...scheduleUpdate,
            ...(missed ? {} : { run_count: { increment: 1 }, last_run_at: now }),
            updated_at: now,
          },
        });
        if (count === 0) return; // edited / paused / claimed meanwhile
        await tx.broadcast_schedule_runs.createMany({
          data: [{
            schedule_id:  s.id,
            run_for:      runFor,
            broadcast_id: randomUUID(),
            title:        s.title,
            status:       missed ? 'SKIPPED' : 'QUEUING',
            error:        missed ? missedMsg : null,
            created_at:   now,
          }],
          skipDuplicates: true, // occurrence already has a run → never a second one
        });
        if (!missed) claimed += 1;
      });
    } catch (err) {
      logError(`Broadcast scheduler: claiming schedule ${s.id} failed: ${err.message}`);
    }
  }
  return claimed;
}

async function processQueuingRuns() {
  const runs = await prisma.broadcast_schedule_runs.findMany({
    where:   { status: 'QUEUING' },
    orderBy: { run_for: 'asc' },
    take:    RUN_BATCH,
    include: { schedule: true },
  });

  let queued = 0;
  for (const run of runs) {
    const s = run.schedule;
    // Paused / cancelled (or cleaned up) after the claim → don't send.
    if (!s || s.status === 'PAUSED' || s.status === 'CANCELLED') {
      await prisma.broadcast_schedule_runs.updateMany({
        where: { id: run.id, status: 'QUEUING' },
        data:  { status: 'SKIPPED', error: s ? `Schedule ${s.status.toLowerCase()} before sending` : 'Schedule removed' },
      });
      continue;
    }

    const { count } = await prisma.broadcast_schedule_runs.updateMany({
      where: { id: run.id, status: 'QUEUING', attempts: run.attempts },
      data:  { attempts: { increment: 1 } },
    });
    if (count === 0) continue;

    try {
      const input = validateBroadcast({
        title: s.title, body: s.body, url: s.url, audience: s.audience, inactive_days: s.inactive_days,
      });
      const summary = await queueBroadcast(input, {
        broadcastId: run.broadcast_id, sentBy: s.created_by, scheduleId: s.id, localWall: run.run_for,
      });
      await prisma.broadcast_schedule_runs.update({
        where: { id: run.id },
        data:  {
          status:            'QUEUED',
          recipients:        summary.recipients,
          reachable_by_push: summary.reachable_by_push,
          error:             null,
          queued_at:         new Date(),
        },
      });
      queued += 1;
    } catch (err) {
      const message = (err.message || 'unknown_error').slice(0, 500);
      logError(`Broadcast scheduler: run ${run.id} (schedule ${s.id}) attempt ${run.attempts + 1} failed: ${message}`);
      if (run.attempts + 1 < MAX_RUN_ATTEMPTS) {
        await prisma.broadcast_schedule_runs.update({ where: { id: run.id }, data: { error: message } });
        continue; // retried next tick
      }
      await prisma.$transaction([
        prisma.broadcast_schedule_runs.update({ where: { id: run.id }, data: { status: 'FAILED', error: message } }),
        prisma.broadcast_schedules.update({
          where: { id: s.id },
          data:  s.recurrence === 'NONE'
            ? { status: 'FAILED', last_error: message, updated_at: new Date() }
            : { last_error: message, updated_at: new Date() },
        }),
      ]);
    }
  }
  return queued;
}

// A one-time schedule is SENT only once its run is queued and no push is
// still waiting (PENDING / SENDING) — so it never leaves the active list
// while delivery is in flight.
async function completeSentSchedules(now) {
  const sending = await prisma.broadcast_schedules.findMany({
    where:   { status: 'SENDING' },
    include: { runs: { orderBy: { run_for: 'desc' }, take: 1 } },
    take:    50,
  });

  let completed = 0;
  for (const s of sending) {
    const run = s.runs[0];
    if (!run || run.status !== 'QUEUED') continue;
    const inFlight = await prisma.notifications.count({
      where: { dedupe_key: broadcastDedupeKey(run.broadcast_id), type: 'BROADCAST', push_status: { in: ['PENDING', 'SENDING'] } },
    });
    if (inFlight > 0) continue;
    const { count } = await prisma.broadcast_schedules.updateMany({
      where: { id: s.id, status: 'SENDING' },
      data:  { status: 'SENT', completed_at: now, updated_at: now },
    });
    completed += count;
  }
  return completed;
}

async function cleanupFinishedSchedules(now) {
  const { count } = await prisma.broadcast_schedules.deleteMany({
    where: {
      status:       { in: ['SENT', 'CANCELLED'] },
      completed_at: { lt: new Date(now.getTime() - CLEANUP_AFTER_MS) },
    },
  });
  return count;
}
