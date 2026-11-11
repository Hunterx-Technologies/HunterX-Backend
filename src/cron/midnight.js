// src/cron/midnight.js — Nightly task-assignment cron, scheduled for
// 00:30 IST (19:00 UTC), ahead of the 6 AM DAILY_MOTIVATION push.
//
// Trigger A of the automatic task-assignment system (see
// src/services/taskAssignmentService.js): for every active user, assigns
// today's routine daily tasks + any weekly task recurring today + any
// admin one-off task scheduled for today. Covers all EXISTING users so
// their tasks are ready before they even open the app.
//
// Safe to re-run / overlap with the request-time fallback (trigger C) —
// assignDailyTasks() is idempotent per user/date.

import { scheduleJob } from './lock.js';
import prisma from '../config/prisma.js';
import { assignDailyTasks, loadSharedTasks } from '../services/taskAssignmentService.js';
import { deactivateExpiredPaidTasks } from '../services/taskPurchaseService.js';
import { expireRewards, grantBirthdayCards } from '../services/rewardService.js';
import { deleteOldNotifications, NOTIFICATION_RETENTION_DAYS } from '../services/notificationService.js';
import { getISTDateOnly, calculateStepsGoal } from '../utils/helpers.js';
import { info, logError } from '../utils/logger.js';

export async function syncUserAgesForBirthdays(today) {
  // Only users whose stored age no longer matches their birthday — usually
  // just today's birthdays, but also anyone missed by an earlier run — so
  // this stays small however many users there are. The loop below
  // recomputes and double-checks each one exactly as before.
  const todayKey = today.toISOString().slice(0, 10);
  const usersWithDob = await prisma.$queryRaw`
    SELECT id, date_of_birth, age, bmi
    FROM users
    WHERE date_of_birth IS NOT NULL
      AND (age IS NULL OR age <> date_part('year', age(${todayKey}::date, date_of_birth))::int)
  `;

  let updatedCount = 0;

  for (const user of usersWithDob) {
    try {
      const dob = user.date_of_birth;
      let calculatedAge = today.getUTCFullYear() - dob.getUTCFullYear();
      const monthDiff = today.getUTCMonth() - dob.getUTCMonth();
      const dayDiff = today.getUTCDate() - dob.getUTCDate();
      if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
        calculatedAge--;
      }

      if (user.age !== calculatedAge) {
        const data = { age: calculatedAge };

        // daily_steps_goal is age-banded (steps down at 50/65) — keep it
        // in sync with the birthday instead of only reacting to a manual
        // profile edit (see helpers.js#calculateStepsGoal).
        if (user.bmi != null) {
          data.daily_steps_goal = calculateStepsGoal(user.bmi, calculatedAge);
        }

        await prisma.users.update({
          where: { id: user.id },
          data,
        });
        updatedCount++;
      }
    } catch (err) {
      logError(`Failed to update age for user ${user.id}: ${err.message}`);
    }
  }

  if (updatedCount > 0) {
    info(`Daily birthday age sync completed: updated ${updatedCount} user(s)`);
  }
}

// Users assigned in parallel by the nightly job.
const ASSIGN_CONCURRENCY = 4;

export async function runNightlyTaskAssignment() {
  const today = getISTDateOnly();

  // Run daily birthday sync first — its failure must not cost every user
  // today's task assignment.
  try {
    await syncUserAgesForBirthdays(today);
  } catch (err) {
    logError(`Birthday age sync failed: ${err.message}`);
  }

  // Birthday scratch cards (only once an admin has put coupons on the
  // birthday trigger) — see rewardService.js#grantBirthdayCards.
  try {
    const granted = await grantBirthdayCards(today);
    if (granted > 0) info(`Granted ${granted} birthday scratch card(s)`);
  } catch (err) {
    logError(`Birthday scratch cards failed: ${err.message}`);
  }

  // Paid tasks whose sale (end_date) is over and whose last buyer's access
  // has ended are switched off.
  try {
    const deactivated = await deactivateExpiredPaidTasks(today);
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

  const users = await prisma.users.findMany({
    where:  { onboarding_done: true, is_banned: false },
    select: { id: true },
  });

  let assignedTotal = 0;
  let failedCount   = 0;
  const shared      = await loadSharedTasks(today);

  // A few users at a time: each assignment is independent and idempotent,
  // and the cap leaves most of the DB pool free for app traffic.
  let next = 0;
  const worker = async () => {
    while (next < users.length) {
      const user = users[next++];
      try {
        const { assigned } = await assignDailyTasks(user.id, today, shared);
        assignedTotal += assigned;
      } catch (err) {
        failedCount += 1;
        logError(`Nightly task assignment failed for user ${user.id}: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ASSIGN_CONCURRENCY, users.length) }, worker));

  info(
    `Nightly task assignment done — ${users.length} active users, ` +
    `${assignedTotal} task_schedule rows created, ${failedCount} user(s) failed`
  );
}

// Cron schedule: 0 19 * * * corresponding to 00:30 IST (19:00 UTC)
export const midnightJob = scheduleJob('Nightly task assignment', '0 19 * * *', 2 * 60 * 60, runNightlyTaskAssignment);

export default midnightJob;
