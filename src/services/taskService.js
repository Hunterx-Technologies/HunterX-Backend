// src/services/taskService.js — Daily, weekly & monthly task fetching + completion logic

import prisma from '../config/prisma.js';
import { getISTDateOnly, getISTWeekStart } from '../utils/helpers.js';
import { assignDailyTasks } from './taskAssignmentService.js';
import { bumpDailyStreak, getStreakRiskStatus, reconcileStreak } from './streakService.js';
import { checkLevelUp } from './xpService.js';
import { syncLeaderboardMember } from './leaderboardService.js';
import {
  getLockedTasks, getActivePurchase, markPurchaseCompleted, getCompletedPaidTaskIds,
} from './taskPurchaseService.js';
import { createNotification } from './notificationService.js';
import { istDayEnd } from './questNotificationService.js';
import { logError } from '../utils/logger.js';

const DAILY_TYPES     = ['DAILY_FIXED', 'DAILY_ADMIN'];
const VALID_STATUSES  = ['COMPLETED', 'PARTIAL', 'SKIPPED'];

const MS_PER_DAY  = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { WEEKLY: 7, MONTHLY: 30 };

// The period a task's completion is tracked against — { start, end }.
// Daily tasks: today. WEEKLY / MONTHLY: rolling 7 / 30-day blocks counted
// from when the task started for this user (tasks.start_date for free
// tasks, the purchase day for paid ones), so a 7-day window running Wed ->
// Tue is one period (one completion), not two calendar weeks. `end` is
// capped at the last day the user has the task (end_date / access_end).
// period.start is the task_completions.schedule_date key.
export async function getTaskPeriod(bUserId, task, today = getISTDateOnly()) {
  const length = PERIOD_DAYS[task.task_type];
  if (!length) return { start: today, end: today };

  let anchor = task.start_date ?? today;
  let lastDay = task.end_date;
  if (task.is_paid) {
    const purchase = await getActivePurchase(bUserId, task.id, today);
    if (purchase) {
      anchor  = purchase.access_start;
      lastDay = purchase.access_end;
    }
  }
  const elapsedDays = Math.max(0, Math.floor((today.getTime() - anchor.getTime()) / MS_PER_DAY));
  const start = new Date(anchor.getTime() + Math.floor(elapsedDays / length) * length * MS_PER_DAY);
  let end = new Date(start.getTime() + (length - 1) * MS_PER_DAY);
  if (lastDay && lastDay.getTime() < end.getTime()) end = lastDay;
  return { start, end };
}

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

// Convention: a task with target_value = null pulls its target from a
// user-specific calculated goal instead of a fixed value on the task row,
// keyed off the task's tag (see prisma/seed.js).
const DYNAMIC_TARGET_FIELD_BY_TAG = {
  NUTRITION: 'daily_protein_goal', // grams — weight + activity level
  HYDRATE:   'daily_water_goal',   // liters — 35ml/kg bodyweight
  STEPS:     'daily_steps_goal',   // step count — BMI + age
};

function resolveTarget(task, user) {
  if (task.target_value !== null) return task.target_value;
  const field = DYNAMIC_TARGET_FIELD_BY_TAG[task.tag];
  return field ? (user[field] ?? null) : null;
}

// ─────────────────────────────────────────────────────────────
// GET — today's daily tasks + this week's weekly quests, each
// with the user's completion status/XP for the current period
// ─────────────────────────────────────────────────────────────

export async function getTodayTasks(userId, overrideGender = null) {
  const bUserId = BigInt(userId);

  const user = await prisma.users.findUnique({
    where:  { id: bUserId },
    select: { daily_protein_goal: true, daily_water_goal: true, daily_steps_goal: true, gender: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');

  const effectiveGender = (overrideGender ?? user.gender ?? '').toString().toUpperCase();

  const todayDate     = getISTDateOnly();
  const weekStartDate = getISTWeekStart();

  // Trigger C — request-time fallback. If this user has no task_schedule
  // rows for today yet (cron didn't run, server was down, timezone edge
  // case, brand-new user whose signup hook failed, etc.), assign them now
  // so they're never shown an empty list. Idempotent — safe even if the
  // nightly cron already ran for this user today.
  const alreadyAssigned = await prisma.task_schedule.count({
    where: { user_id: bUserId, active_date: todayDate },
  });
  if (alreadyAssigned === 0) {
    await assignDailyTasks(bUserId, todayDate);
  }

  // Daily: whatever was assigned to this user for today.
  const dailySchedule = await prisma.task_schedule.findMany({
    where: {
      user_id:     bUserId,
      active_date: todayDate,
      tasks:       { is_active: true, task_type: { in: DAILY_TYPES } },
    },
    include: { tasks: true },
  });

  // Weekly + monthly: assigned every day of the task's window (or the
  // user's access window, if paid), so today's row is enough.
  const periodSchedule = await prisma.task_schedule.findMany({
    where: {
      user_id:     bUserId,
      active_date: todayDate,
      tasks:       { is_active: true, task_type: { in: ['WEEKLY', 'MONTHLY'] } },
    },
    include: { tasks: true },
  });

  // A paid task the user has COMPLETED is closed for them — hidden even
  // though today's task_schedule row still exists.
  const completedPaid = await getCompletedPaidTaskIds(bUserId);
  const eligible = [...dailySchedule, ...periodSchedule]
    .map(s => s.tasks)
    .filter(t => !completedPaid.has(t.id));

  const periodByTask = new Map();
  for (const task of eligible) periodByTask.set(task.id, await getTaskPeriod(bUserId, task, todayDate));

  const periodKeys = [...new Set([...periodByTask.values()].map(p => p.start.getTime()))];
  const completions = await prisma.task_completions.findMany({
    where: {
      user_id:       bUserId,
      task_id:       { in: eligible.map(t => t.id) },
      schedule_date: { in: periodKeys.map(t => new Date(t)) },
    },
  });
  const completionMap = new Map(
    completions.map(c => [`${c.task_id}_${dateKey(c.schedule_date)}`, c])
  );

  function serialize(task) {
    const period = periodByTask.get(task.id);
    const completion = period ? completionMap.get(`${task.id}_${dateKey(period.start)}`) || null : null;
    const isFemale = effectiveGender === 'FEMALE';
    const resolvedImageUrl = isFemale
      ? (task.image_url_female ?? task.image_url_male ?? task.image_url)
      : (task.image_url_male ?? task.image_url);

    return {
      id:               task.id,
      title:            task.title,
      description:      task.description,
      tag:              task.tag,
      image_url:        resolvedImageUrl,
      image_url_male:   task.image_url_male,
      image_url_female: task.image_url_female,
      task_type:        task.task_type,
      xp_reward:        task.xp_reward,
      xp_partial:       task.xp_partial,
      allows_partial:   task.allows_partial,
      target_value:     resolveTarget(task, user),
      target_unit:      task.target_unit,
      is_recurring:     task.is_recurring,
      // null for DAILY_FIXED (no admin-set window); otherwise the task's
      // window — for paid tasks, when the offer runs (see adminTaskService.js)
      start_date:       task.start_date ? dateKey(task.start_date) : null,
      end_date:         task.end_date ? dateKey(task.end_date) : null,
      is_paid:          task.is_paid,
      // Not a DB value — PENDING just means "no completion row yet"
      status:           completion?.status ?? 'PENDING',
      progress_value:   completion?.progress_value ?? null,
      xp_earned:        completion?.xp_earned ?? 0,
      completed_at:     completion?.completed_at ?? null,
    };
  }

  const daily  = eligible.filter(t => DAILY_TYPES.includes(t.task_type)).map(serialize);
  // period_start..period_end: the current 7 / 30-day block the task can be
  // completed once in.
  const withPeriod = task => ({
    ...serialize(task),
    period_start: dateKey(periodByTask.get(task.id).start),
    period_end:   dateKey(periodByTask.get(task.id).end),
  });
  const weekly  = eligible.filter(t => t.task_type === 'WEEKLY').map(withPeriod);
  const monthly = eligible.filter(t => t.task_type === 'MONTHLY').map(withPeriod);

  // Paid tasks (any type) on sale that this user hasn't bought — shown with
  // a buy button until end_date, not completable (no task_schedule row)
  // and not in XP totals. Buying unlocks access from that day to end_date.
  const locked = (await getLockedTasks(bUserId, todayDate)).map(task => ({
    ...serialize(task),
    status:        'LOCKED',
    price:         Number(task.price),
    currency:      task.currency,
  }));

  const streak = await getStreakRiskStatus(bUserId);

  return {
    date:               dateKey(todayDate),
    week_start:         dateKey(weekStartDate),
    daily,
    weekly,
    monthly,
    locked,
    daily_xp_earned:    daily.reduce((s, t) => s + t.xp_earned, 0),
    daily_xp_possible:  daily.reduce((s, t) => s + t.xp_reward, 0),
    weekly_xp_earned:   weekly.reduce((s, t) => s + t.xp_earned, 0),
    weekly_xp_possible: weekly.reduce((s, t) => s + t.xp_reward, 0),
    monthly_xp_earned:   monthly.reduce((s, t) => s + t.xp_earned, 0),
    monthly_xp_possible: monthly.reduce((s, t) => s + t.xp_reward, 0),
    // streak.at_risk true = show the "use a life or let it drop?" prompt;
    // see POST /api/tasks/streak/resolve
    streak,
  };
}

// ─────────────────────────────────────────────────────────────
// GET — Mon–Sun status strip for the current IST week, e.g. for a
// streak-calendar UI. Always keyed off getISTWeekStart()/getISTDateOnly()
// live, so it needs no reset job — it's just a different week's Monday
// once the calendar rolls over.
// "Done" mirrors the streak's own definition of an active day
// (bumpDailyStreak): a DAILY_FIXED/DAILY_ADMIN completion with status
// COMPLETED or PARTIAL. WEEKLY quests aren't day-keyed so they don't
// factor in here.
// ─────────────────────────────────────────────────────────────

const WEEK_DAY_NAMES = [
  'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY',
];

export async function getWeekStatus(userId) {
  const bUserId = BigInt(userId);

  const weekStart = getISTWeekStart();
  const weekEnd    = new Date(weekStart);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6); // Sunday of this ISO week
  const today = getISTDateOnly();

  const completions = await prisma.task_completions.findMany({
    where: {
      user_id:       bUserId,
      schedule_date: { gte: weekStart, lte: weekEnd },
      status:        { in: ['COMPLETED', 'PARTIAL'] },
      tasks:         { task_type: { in: DAILY_TYPES } },
    },
    select: { schedule_date: true },
  });
  const doneDates = new Set(completions.map(c => dateKey(c.schedule_date)));

  const days = WEEK_DAY_NAMES.map((day, i) => {
    const date = new Date(weekStart);
    date.setUTCDate(date.getUTCDate() + i);
    const key = dateKey(date);

    const status = doneDates.has(key)          ? 'DONE'
                 : date.getTime() === today.getTime() ? 'CURRENT'
                 : date.getTime() < today.getTime()    ? 'MISSED'
                 :                                        'NOT_STARTED';

    return { date: key, day, status };
  });

  return { week_start: dateKey(weekStart), week_end: dateKey(weekEnd), days };
}

// ─────────────────────────────────────────────────────────────
// PUT — set this task's completion status for the current period
// Idempotent: same (status, progress_value) always ends in the
// same state; XP is adjusted by the delta from whatever the row
// previously held (so flipping COMPLETED -> PARTIAL -> SKIPPED
// -> COMPLETED never double-counts or under-counts XP).
// ─────────────────────────────────────────────────────────────

// Authorization gate: a task only being active isn't enough — the caller
// must actually have it on their list for the current period, i.e. a
// task_schedule row exists for them (same source of truth GET /today
// reads from). Without this, any logged-in user could mark XP-earning
// completions on a task never assigned to them — another user's targeted
// DAILY_ADMIN task, or one whose date window hasn't opened/has already
// closed.
// Every task type is assigned for each day it's available, so today's row
// is the check.
async function assertAssignedToUser(bUserId, task) {
  const row = await prisma.task_schedule.findUnique({
    where: {
      user_id_task_id_active_date: {
        user_id:     bUserId,
        task_id:     task.id,
        active_date: getISTDateOnly(),
      },
    },
    select: { id: true },
  });
  if (!row) throw new Error('TASK_NOT_ASSIGNED');
}

export async function setTaskCompletion(userId, taskId, { status, progressValue }) {
  if (!VALID_STATUSES.includes(status)) throw new Error('INVALID_STATUS');

  if (
    progressValue !== undefined && progressValue !== null &&
    (typeof progressValue !== 'number' || !Number.isFinite(progressValue) || progressValue < 0)
  ) {
    throw new Error('INVALID_PROGRESS_VALUE');
  }

  const bUserId = BigInt(userId);
  const bTaskId = BigInt(taskId);

  const task = await prisma.tasks.findUnique({ where: { id: bTaskId } });
  if (!task || !task.is_active) throw new Error('TASK_NOT_FOUND');

  if (status === 'PARTIAL' && !task.allows_partial) throw new Error('PARTIAL_NOT_ALLOWED');

  await assertAssignedToUser(bUserId, task);

  const periodDate = (await getTaskPeriod(bUserId, task)).start;

  // Flat XP per status — the schema tracks one xp_partial amount per task,
  // not a sliding scale off progress_value.
  const xpEarned = status === 'COMPLETED' ? task.xp_reward
                  : status === 'PARTIAL'  ? task.xp_partial
                  : /* SKIPPED */           0;

  const completion = await prisma.$transaction(async (tx) => {
    // Serialize this user's completions on their progression row. Without
    // the lock, two concurrent requests (a double-tap) both read "no
    // completion yet" below and both pay out the full XP delta. (The row
    // is created at signup; the upserts below still cover it if missing.)
    await tx.$queryRaw`SELECT 1 FROM user_progression WHERE user_id = ${bUserId} FOR UPDATE`;

    const existing = await tx.task_completions.findUnique({
      where: {
        user_id_task_id_schedule_date: {
          user_id:       bUserId,
          task_id:       bTaskId,
          schedule_date: periodDate,
        },
      },
    });

    // Once COMPLETED, a task is locked — no more status changes for this
    // period. Resending COMPLETED again is still a no-op success (same
    // idempotent rule as always); only switching AWAY from it is blocked.
    if (existing?.status === 'COMPLETED' && status !== 'COMPLETED') {
      throw new Error('TASK_ALREADY_COMPLETED');
    }

    const upserted = await tx.task_completions.upsert({
      where: {
        user_id_task_id_schedule_date: {
          user_id:       bUserId,
          task_id:       bTaskId,
          schedule_date: periodDate,
        },
      },
      create: {
        user_id:        bUserId,
        task_id:        bTaskId,
        schedule_date:  periodDate,
        status,
        progress_value: progressValue ?? null, // not sent by the client yet — stored if it ever is
        xp_earned:      xpEarned,
        completed_at:   status === 'SKIPPED' ? null : new Date(),
      },
      update: {
        status,
        progress_value: progressValue ?? null,
        xp_earned:      xpEarned,
        completed_at:   status === 'SKIPPED' ? null : new Date(),
      },
    });

    const delta = xpEarned - (existing?.xp_earned ?? 0);

    if (delta !== 0) {
      await tx.xp_transactions.create({
        data: {
          user_id: bUserId,
          task_id: bTaskId,
          amount:  delta,
          reason:  `TASK_${status}: ${task.title}`,
        },
      });

      await tx.user_progression.upsert({
        where:  { user_id: bUserId },
        create: { user_id: bUserId, total_xp: Math.max(delta, 0) },
        update: { total_xp: { increment: delta } },
      });

      // Level-ups only ever move forward — a status flip that lowers XP
      // (COMPLETED -> PARTIAL) never un-levels a user, so this only runs
      // on a net gain. Leveling and streaks are independent systems:
      // this never touches any streak field, same as bumpDailyStreak
      // below never touches XP/level.
      if (delta > 0) {
        await checkLevelUp(tx, bUserId);
      }
    }

    // Streak is a daily-tasks concept only, and only COMPLETED/PARTIAL
    // count as "active today" — marking a task SKIPPED must not extend
    // the streak. (If a task is flipped from COMPLETED to SKIPPED later
    // the same day, the streak already bumped for that day stays bumped —
    // the user genuinely was active that day, this just isn't the call
    // that should be granting it.)
    if (DAILY_TYPES.includes(task.task_type) && status !== 'SKIPPED') {
      await bumpDailyStreak(tx, bUserId);
    }

    // Completing a paid task closes the purchase: the reward is claimed,
    // and the task is no longer assigned, listed, or offered to this user.
    if (task.is_paid && status === 'COMPLETED') {
      const closed = await markPurchaseCompleted(tx, bUserId, task.id);
      if (closed) {
        await createNotification(
          tx, bUserId, 'QUEST_COMPLETED',
          `🏆 Premium quest cleared: ${task.title}`,
          `+${task.xp_reward} XP earned. Well hunted, Hunter.`,
          { event: 'PAID_QUEST_COMPLETED', task_id: String(task.id), xp: task.xp_reward }
        );
      }
    }

    return upserted;
  });

  const progression = await prisma.user_progression.findUnique({ where: { user_id: bUserId } });

  // Outside the transaction (it already committed) — total_xp may have
  // changed, which can move this user in/out of the leaderboard or shift
  // their rank. Never let a leaderboard hiccup fail a task completion.
  await syncLeaderboardMember(bUserId);

  if (DAILY_TYPES.includes(task.task_type) && status !== 'SKIPPED') {
    await notifyIfDayCleared(bUserId, progression?.daily_streak ?? 0).catch((err) =>
      logError(`Day-complete push failed for user ${bUserId}: ${err.message}`)
    );
  }

  return {
    task_id:        task.id,
    title:          task.title,
    task_type:      task.task_type,
    status:         completion.status,
    progress_value: completion.progress_value,
    target_value:   task.target_value,
    target_unit:    task.target_unit,
    xp_reward:      task.xp_reward,
    xp_partial:     task.xp_partial,
    xp_earned:      completion.xp_earned,
    completed_at:   completion.completed_at,
    total_xp:       progression?.total_xp ?? 0,
    daily_streak:   progression?.daily_streak ?? 0,
    longest_streak: progression?.longest_streak ?? 0,
  };
}

// "Day secured" push once every daily task scheduled for today is
// COMPLETED or PARTIAL (a SKIPPED one means the day wasn't fully cleared).
// Outside the completion transaction: the dedupe key makes it once a day.
async function notifyIfDayCleared(bUserId, streak) {
  const today = getISTDateOnly();
  const scheduled = await prisma.task_schedule.findMany({
    where:    { user_id: bUserId, active_date: today, tasks: { is_active: true, task_type: { in: DAILY_TYPES } } },
    select:   { task_id: true },
    distinct: ['task_id'],
  });
  if (scheduled.length === 0) return;

  const cleared = await prisma.task_completions.count({
    where: {
      user_id:       bUserId,
      task_id:       { in: scheduled.map(s => s.task_id) },
      schedule_date: today,
      status:        { in: ['COMPLETED', 'PARTIAL'] },
    },
  });
  if (cleared < scheduled.length) return;

  await createNotification(
    prisma, bUserId, 'DAY_COMPLETE',
    streak > 0 ? `🔥 Day ${streak} secured` : '🔥 Day secured',
    'All daily quests cleared. See you tomorrow, Hunter.',
    { event: 'DAY_COMPLETE', daily_streak: streak },
    { dedupeKey: `day_complete:${dateKey(today)}`, expiresAt: istDayEnd(today) }
  );
}

// ─────────────────────────────────────────────────────────────
// PUT — reopen a task: SKIPPED -> PENDING, the only direction this
// goes. There's no "PENDING" completion_status to set (PENDING is just
// the absence of a task_completions row), so reopening deletes the row.
// COMPLETED is locked (setTaskCompletion already rejects switching away
// from it), and PARTIAL isn't reopenable through this endpoint either —
// only a SKIPPED row can be undone. No XP or streak side effects: a
// SKIPPED row always held xp_earned=0 and never bumped the streak, so
// there's nothing to reverse.
// ─────────────────────────────────────────────────────────────

export async function reopenTask(userId, taskId) {
  const bUserId = BigInt(userId);
  const bTaskId = BigInt(taskId);

  const task = await prisma.tasks.findUnique({ where: { id: bTaskId } });
  if (!task || !task.is_active) throw new Error('TASK_NOT_FOUND');

  await assertAssignedToUser(bUserId, task);

  const periodDate = (await getTaskPeriod(bUserId, task)).start;
  const where = {
    user_id_task_id_schedule_date: {
      user_id:       bUserId,
      task_id:       bTaskId,
      schedule_date: periodDate,
    },
  };

  const existing = await prisma.task_completions.findUnique({ where });
  if (!existing) throw new Error('TASK_ALREADY_PENDING'); // nothing to undo
  if (existing.status !== 'SKIPPED') throw new Error('TASK_NOT_SKIPPED');

  await prisma.task_completions.delete({ where });

  return {
    task_id:   task.id,
    title:     task.title,
    task_type: task.task_type,
    status:    'PENDING',
  };
}

// ─────────────────────────────────────────────────────────────
// GET /api/users/activity — Summary metrics & paginated quest logs
// ─────────────────────────────────────────────────────────────

function formatDateLabel(completionDate) {
  if (!completionDate) return '';
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const compIST = new Date(completionDate.getTime() + IST_OFFSET_MS);

  const todayMidnight = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()));
  const compMidnight = new Date(Date.UTC(compIST.getUTCFullYear(), compIST.getUTCMonth(), compIST.getUTCDate()));

  const diffMs = todayMidnight.getTime() - compMidnight.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays > 1 && diffDays < 7) return `${diffDays}d ago`;

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${compMidnight.getUTCDate()} ${months[compMidnight.getUTCMonth()]}`;
}

export async function getUserActivity(userId, pageParam = 1, limitParam = 10) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  const page = Math.max(1, parseInt(pageParam) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(limitParam) || 10));
  const skip = (page - 1) * limit;

  // Collapses an unprotected gap to a broken streak before reading it
  // below, so current_streak doesn't show a stale pre-gap value.
  await reconcileStreak(bUserId);

  // 1. Fetch user & progression data for summary cards
  const user = await prisma.users.findUnique({
    where: { id: bUserId },
    select: {
      id: true,
      created_at: true,
      user_progression: {
        select: {
          daily_streak: true,
          longest_streak: true,
        },
      },
    },
  });

  if (!user) throw new Error('USER_NOT_FOUND');

  // Total count of completed quests
  const totalCompletions = await prisma.task_completions.count({
    where: {
      user_id: bUserId,
      status: 'COMPLETED',
    },
  });

  // 2. Fetch paginated completed task logs
  const rawLogs = await prisma.task_completions.findMany({
    where: {
      user_id: bUserId,
      status: 'COMPLETED',
    },
    orderBy: [
      { completed_at: 'desc' },
      { id: 'desc' },
    ],
    skip,
    take: limit,
    include: {
      tasks: {
        select: {
          id: true,
          title: true,
          task_type: true,
          tag: true,
          xp_reward: true,
        },
      },
    },
  });

  // 3. Format quest logs
  const logs = rawLogs.map(log => {
    const compDate = log.completed_at || log.created_at || log.schedule_date;
    const dateObj = new Date(compDate);
    const dayNumber = log.schedule_date ? new Date(log.schedule_date).getUTCDate() : dateObj.getUTCDate();

    return {
      id: log.id,
      task_id: log.task_id,
      title: log.tasks?.title || 'Completed Task',
      xp_earned: log.xp_earned,
      schedule_date: log.schedule_date ? log.schedule_date.toISOString().slice(0, 10) : null,
      completed_at: log.completed_at || log.created_at,
      day_number: dayNumber,
      date_label: formatDateLabel(compDate),
    };
  });

  const totalPages = Math.ceil(totalCompletions / limit) || 0;

  return {
    summary: {
      member_since: user.created_at,
      current_streak: user.user_progression?.daily_streak ?? 0,
      best_record: user.user_progression?.longest_streak ?? 0,
      total_quests_cleared: totalCompletions,
    },
    logs,
    pagination: {
      page,
      limit,
      total_count: totalCompletions,
      total_pages: totalPages,
      has_next_page: page < totalPages,
    },
  };
}

