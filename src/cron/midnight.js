// src/cron/midnight.js — Day rollover jobs.
//
// Every hunter's day starts at their OWN local midnight (utils/userClock.js),
// so the per-user work runs every 15 minutes for whoever just reached it:
//
//   Local midnight (every 15 min) — for each active user whose local time is
//   00:00–00:14: trigger A of the automatic task-assignment system (see
//   src/services/taskAssignmentService.js: today's routine daily tasks, any
//   weekly task recurring today, any admin task scheduled for today), the
//   birthday age update and the birthday scratch card. Every zone offset is
//   a multiple of 15 minutes and the cron fires on UTC quarter-hours, so
//   each user lands in exactly one tick a day.
//
//   Nightly housekeeping (00:30 IST, 19:00 UTC) — shared cleanup with no
//   per-user day: ended paid sales, expired OTPs, old notifications,
//   expired rewards.
//
// Safe to re-run / overlap with the request-time fallback (trigger C) —
// assignDailyTasks() is idempotent per user/date, birthday cards once a year.

import { scheduleJob } from './lock.js';
import prisma from '../config/prisma.js';
import { assignDailyTasks, loadSharedTasks } from '../services/taskAssignmentService.js';
import { deactivateExpiredPaidTasks } from '../services/taskPurchaseService.js';
import { expireRewards, ensureBirthdayCard, isBirthdayOn } from '../services/rewardService.js';
import { deleteOldNotifications, NOTIFICATION_RETENTION_DAYS } from '../services/notificationService.js';
import { calculateStepsGoal } from '../utils/helpers.js';
import { getLocalTime, DEFAULT_TIMEZONE } from '../utils/timezone.js';
import { getLocalDateOnly } from '../utils/userClock.js';
import { info, logError } from '../utils/logger.js';

// Age on `today` (UTC-midnight Date of the user's local day).
export function ageOn(dob, today) {
  let age = today.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - dob.getUTCMonth();
  const dayDiff   = today.getUTCDate() - dob.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age--;
  return age;
}

// Keeps users.age (and the age-banded daily_steps_goal, which steps down at
// 50/65 — see helpers.js#calculateStepsGoal) in step with the birthday.
async function syncAge(user, today) {
  const age = ageOn(user.date_of_birth, today);
  if (user.age === age) return false;
  const data = { age };
  if (user.bmi != null) data.daily_steps_goal = calculateStepsGoal(user.bmi, age);
  await prisma.users.update({ where: { id: user.id }, data });
  return true;
}

// Users assigned in parallel per tick.
const ASSIGN_CONCURRENCY = 4;
const TICK_MINUTES = 15;

export async function runLocalMidnight(now = new Date()) {
  const users = await prisma.users.findMany({
    where:  { onboarding_done: true, is_banned: false },
    select: {
      id: true, date_of_birth: true, age: true, bmi: true,
      user_settings: { select: { timezone: true } },
    },
  });

  // Just past local midnight, with that user's local day.
  const due = [];
  for (const user of users) {
    const tz = user.user_settings?.timezone ?? DEFAULT_TIMEZONE;
    if (getLocalTime(tz, now).minutesOfDay < TICK_MINUTES) {
      due.push({ user, today: getLocalDateOnly(tz, 0, now) });
    }
  }
  if (due.length === 0) return;

  // Shared task lists, once per calendar date in this tick.
  const sharedByDate = new Map();
  const sharedFor = (today) => {
    const key = today.toISOString().slice(0, 10);
    if (!sharedByDate.has(key)) sharedByDate.set(key, loadSharedTasks(today));
    return sharedByDate.get(key);
  };

  let assignedTotal = 0;
  let failedCount   = 0;
  let agesUpdated   = 0;
  let birthdayCards = 0;

  let next = 0;
  const worker = async () => {
    while (next < due.length) {
      const { user, today } = due[next++];
      try {
        if (user.date_of_birth) {
          if (await syncAge(user, today)) agesUpdated += 1;
          if (isBirthdayOn(user.date_of_birth, today) && await ensureBirthdayCard(user.id)) birthdayCards += 1;
        }
      } catch (err) {
        logError(`Birthday update failed for user ${user.id}: ${err.message}`);
      }
      try {
        const { assigned } = await assignDailyTasks(user.id, today, await sharedFor(today));
        assignedTotal += assigned;
      } catch (err) {
        failedCount += 1;
        logError(`Local-midnight task assignment failed for user ${user.id}: ${err.message}`);
      }
    }
  };
  // A few users at a time: each is independent and idempotent, and the cap
  // leaves most of the DB pool free for app traffic.
  await Promise.all(Array.from({ length: Math.min(ASSIGN_CONCURRENCY, due.length) }, worker));

  info(
    `Local midnight — ${due.length} user(s): ${assignedTotal} task_schedule rows created, ` +
    `${agesUpdated} age(s) updated, ${birthdayCards} birthday card(s), ${failedCount} failed`
  );
}

export async function runNightlyHousekeeping() {
  // Paid tasks whose sale (end_date) is over and whose last buyer's access
  // has ended are switched off.
  try {
    const deactivated = await deactivateExpiredPaidTasks();
    if (deactivated > 0) info(`Deactivated ${deactivated} expired paid task(s)`);
  } catch (err) {
    logError(`Expired paid task deactivation failed: ${err.message}`);
  }

  // Spent/expired email verification codes are never read again.
  try {
    const { count } = await prisma.email_otps.deleteMany({ where: { expires_at: { lt: new Date() } } });
    if (count > 0) info(`Deleted ${count} expired email OTP(s)`);
  } catch (err) {
    logError(`Expired OTP cleanup failed: ${err.message}`);
  }

  // Notification retention — see notificationService.js#deleteOldNotifications.
  try {
    const deleted = await deleteOldNotifications();
    if (deleted > 0) info(`Deleted ${deleted} notification(s) older than ${NOTIFICATION_RETENTION_DAYS} days`);
  } catch (err) {
    logError(`Notification retention cleanup failed: ${err.message}`);
  }

  // Rewards past their expiry become EXPIRED (with a push for recent ones).
  try {
    const expired = await expireRewards();
    if (expired > 0) info(`Expired ${expired} reward(s)`);
  } catch (err) {
    logError(`Reward expiry failed: ${err.message}`);
  }
}

// UTC quarter-hours: every whole-hour, :30 and :45 offset zone's local
// midnight falls on one of them.
export const localMidnightJob = scheduleJob('Local midnight', '*/15 * * * *', 14 * 60, runLocalMidnight);

// 0 19 * * * = 00:30 IST (19:00 UTC).
export const housekeepingJob = scheduleJob('Nightly housekeeping', '0 19 * * *', 2 * 60 * 60, runNightlyHousekeeping);

export default localMidnightJob;
