// src/services/taskAssignmentService.js — Automatic per-user task assignment
//
// Single source of truth for "what tasks does user X get on date Y". Called
// from these trigger points:
//   A. the nightly cron (src/cron/midnight.js) — for every active user
//   B. the signup hook (src/services/authService.js#processOnboarding) — for
//      the one user who just finished onboarding
//   C. the request-time fallback (src/services/taskService.js#getTodayTasks)
//      — for whichever user just asked for their task list
//   D. an admin creating or changing a task (syncTaskForToday, below) —
//      today's lists for that one task, so the change shows right away
//
// Idempotent by design: task_schedule has a UNIQUE(user_id, task_id,
// active_date) constraint, and inserts use skipDuplicates (ON CONFLICT DO
// NOTHING), so re-running this for a user/date that's already populated is
// always a safe no-op. A–C only ever add rows; D can also take a task off
// today's lists when an admin moves it out of today (never one a hunter
// already acted on).

import prisma from '../config/prisma.js';
import { getISTDateOnly } from '../utils/helpers.js';

// The routine + admin-dated task lists are the same for every user on a
// given date — the nightly cron loads them once (loadSharedTasks) and
// passes them in, instead of re-querying both per user.
export async function loadSharedTasks(date) {
  const [routine, adminDated] = await Promise.all([
    // 1. Routine tasks (tasks.is_routine) — every active one in its date
    //    window (the built-in ones have none; admin ones marked routine
    //    do); assignDailyTasks keeps only the ones each user selected.
    prisma.tasks.findMany({
      where: routineTaskWhere(date),
      select: { id: true },
    }),
    // 2. Admin-created free DAILY_ADMIN / WEEKLY / MONTHLY tasks whose
    //    [start_date, end_date] window covers this date — every type is
    //    assigned on every day of its window; WEEKLY / MONTHLY are then
    //    completable once per 7 / 30-day period (taskService.getTaskPeriod).
    //    See adminTaskService.js#createTask for how the window is derived.
    //    DAILY_ADMIN can target only a subset of users (no targets rows =
    //    all users); new tasks no longer set targets.
    prisma.tasks.findMany({
      where: {
        is_active:  true,
        is_paid:    false,
        // Routine-marked admin tasks come through (1) instead — optional.
        is_routine: false,
        task_type:  { in: ['DAILY_ADMIN', 'WEEKLY', 'MONTHLY'] },
        start_date: { lte: date },
        OR: [{ end_date: { gte: date } }, { end_date: null }],
      },
      select: {
        id: true,
        task_admin_targets: { select: { user_id: true } },
      },
    }),
  ]);
  return { routine, adminDated };
}

// Routine tasks live on `date`: active, flagged is_routine and inside
// their [start_date, end_date] window, where one is set.
export function routineTaskWhere(date) {
  return {
    is_active:  true,
    is_routine: true,
    AND: [
      { OR: [{ start_date: null }, { start_date: { lte: date } }] },
      { OR: [{ end_date: null }, { end_date: { gte: date } }] },
    ],
  };
}

// The routine task ids a user does, out of `activeIds` (active routine
// task ids): every one they haven't turned off (user_routine_tasks.selected
// = false, see routineTaskService.js). No row = on, so a new routine task
// reaches everyone until they turn it off.
export async function selectedRoutineIds(userId, activeIds, client = prisma) {
  const turnedOff = await client.user_routine_tasks.findMany({
    where:  { user_id: userId, selected: false },
    select: { task_id: true },
  });
  const off = new Set(turnedOff.map((p) => p.task_id));
  return activeIds.filter((id) => !off.has(id));
}

// date is a UTC-midnight Date representing an IST calendar day — same
// convention as getISTDateOnly()/getISTWeekStart() in utils/helpers.js.
// `shared` is an optional loadSharedTasks(date) result.
export async function assignDailyTasks(userId, date, shared = null) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  const [{ routine, adminDated }, purchased] = await Promise.all([
    shared ?? loadSharedTasks(date),
    // 3. Paid tasks this user bought, whose access window (purchase day ..
    //    their access_end, see taskPurchaseService.js) covers this date and
    //    that they haven't already completed.
    prisma.task_purchases.findMany({
      where: {
        user_id:      bUserId,
        status:       'PAID',
        completed_at: null,
        access_start: { lte: date },
        access_end:   { gte: date },
        tasks:        { is_active: true },
      },
      select: { task_id: true },
    }),
  ]);

  // The routine tasks this user hasn't turned off.
  const routineIds = await selectedRoutineIds(bUserId, routine.map(t => t.id));

  const purchasedIds = purchased.map(p => p.task_id);

  const eligibleAdminIds = adminDated
    .filter(t => t.task_admin_targets.length === 0 || t.task_admin_targets.some(x => x.user_id === bUserId))
    .map(t => t.id);

  const taskIds = [
    ...routineIds,
    ...eligibleAdminIds,
    ...purchasedIds,
  ];

  if (taskIds.length === 0) return { assigned: 0 };

  const result = await prisma.$transaction(tx =>
    tx.task_schedule.createMany({
      data: taskIds.map(task_id => ({
        user_id:     bUserId,
        task_id,
        active_date: date,
      })),
      skipDuplicates: true, // -> ON CONFLICT DO NOTHING on (user_id, task_id, active_date)
    })
  );

  return { assigned: result.count };
}

// ─────────────────────────────────────────────────────────────
// Trigger D — an admin created or changed a task. The nightly cron has
// usually built today's lists already (and the request-time fallback only
// fills an EMPTY list), so without this a task created or switched on at
// noon would reach nobody until tomorrow. syncTaskForToday makes today's
// lists match the task right away:
//   - live today → added for every hunter the nightly cron would give it
//     to (routine: everyone who hasn't turned it off; admin-dated: everyone,
//     or its targets)
//   - still active but no longer live today (dates moved, made paid) →
//     taken off today's lists, except for hunters who already completed,
//     partly did or skipped it this period, so progress and streaks stand
//   - deactivated → left alone: the list query hides inactive tasks, and
//     switching it back on the same day restores it as it was
// Paid tasks reach buyers through their purchase (trigger 3 above), so
// they're never added or removed here.
// ─────────────────────────────────────────────────────────────

const ADMIN_DATED_TYPES = ['DAILY_ADMIN', 'WEEKLY', 'MONTHLY'];
const PERIOD_DAYS       = { WEEKLY: 7, MONTHLY: 30 };
const DAY_MS            = 24 * 60 * 60 * 1000;
const INSERT_CHUNK      = 1000;

// Would loadSharedTasks(date) include `task`? Same rules, for one task.
export function isTaskLiveOn(task, date) {
  if (!task.is_active) return false;
  const t = date.getTime();
  if (task.end_date && task.end_date.getTime() < t) return false;
  if (task.is_routine) return !task.start_date || task.start_date.getTime() <= t;
  return !task.is_paid &&
    ADMIN_DATED_TYPES.includes(task.task_type) &&
    Boolean(task.start_date) && task.start_date.getTime() <= t;
}

// The hunters the nightly cron gives `task` to (assuming it's live).
async function audienceFor(task) {
  const users = await prisma.users.findMany({
    where:  { onboarding_done: true, is_banned: false },
    select: { id: true },
  });
  let ids = users.map((u) => u.id);

  if (task.is_routine) {
    const off = await prisma.user_routine_tasks.findMany({
      where:  { task_id: task.id, selected: false },
      select: { user_id: true },
    });
    const turnedOff = new Set(off.map((r) => r.user_id));
    return ids.filter((id) => !turnedOff.has(id));
  }

  const targets = await prisma.task_admin_targets.findMany({
    where:  { task_id: task.id },
    select: { user_id: true },
  });
  if (targets.length > 0) {
    const targeted = new Set(targets.map((r) => r.user_id));
    ids = ids.filter((id) => targeted.has(id));
  }
  return ids;
}

export async function syncTaskForToday(taskId, date = getISTDateOnly()) {
  const task = await prisma.tasks.findUnique({ where: { id: BigInt(taskId) } });
  if (!task || !task.is_active) return { added: 0, removed: 0 };

  if (isTaskLiveOn(task, date)) {
    const userIds = await audienceFor(task);
    let added = 0;
    for (let i = 0; i < userIds.length; i += INSERT_CHUNK) {
      const { count } = await prisma.task_schedule.createMany({
        data: userIds.slice(i, i + INSERT_CHUNK).map((user_id) => ({ user_id, task_id: task.id, active_date: date })),
        skipDuplicates: true,
      });
      added += count;
    }
    return { added, removed: 0 };
  }

  if (task.is_paid) return { added: 0, removed: 0 };

  const onToday = await prisma.task_schedule.findMany({
    where:  { task_id: task.id, active_date: date },
    select: { user_id: true },
  });
  if (onToday.length === 0) return { added: 0, removed: 0 };

  // Acted on this period: a completion row (COMPLETED / PARTIAL / SKIPPED /
  // proof in review) dated within the task's current period window.
  const since = new Date(date.getTime() - ((PERIOD_DAYS[task.task_type] ?? 1) - 1) * DAY_MS);
  const acted = await prisma.task_completions.findMany({
    where:  { task_id: task.id, schedule_date: { gte: since, lte: date } },
    select: { user_id: true },
  });
  const keep   = new Set(acted.map((c) => c.user_id));
  const remove = onToday.map((r) => r.user_id).filter((id) => !keep.has(id));
  if (remove.length === 0) return { added: 0, removed: 0 };

  const { count } = await prisma.task_schedule.deleteMany({
    where: { task_id: task.id, active_date: date, user_id: { in: remove } },
  });
  return { added: 0, removed: count };
}
