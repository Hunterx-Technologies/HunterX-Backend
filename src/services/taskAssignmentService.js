// src/services/taskAssignmentService.js — Automatic per-user task assignment
//
// Single source of truth for "what tasks does user X get on date Y". Called
// from all three trigger points:
//   A. the nightly cron (src/cron/midnight.js) — for every active user
//   B. the signup hook (src/services/authService.js#processOnboarding) — for
//      the one user who just finished onboarding
//   C. the request-time fallback (src/services/taskService.js#getTodayTasks)
//      — for whichever user just asked for their task list
//
// Idempotent by design: task_schedule has a UNIQUE(user_id, task_id,
// active_date) constraint, and inserts use skipDuplicates (ON CONFLICT DO
// NOTHING), so re-running this for a user/date that's already populated is
// always a safe no-op. It only ever adds rows — it never deletes or
// modifies a task a user has already been assigned.

import prisma from '../config/prisma.js';

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
