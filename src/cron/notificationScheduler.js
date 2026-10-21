// src/cron/notificationScheduler.js — Time-of-day scheduled notifications.
//
// Ticks every 15 minutes and, for every active user with a registered
// device, asks each job in SCHEDULED_NOTIFICATION_JOBS
// (src/services/scheduledNotificationJobs.js) whether its slot falls in
// this tick. Jobs create rows via createNotification(prisma, ..., { dedupeKey })
// so a re-run of the same tick never double-notifies; the push dispatcher
// delivers them.
//
// Job shape:
//   {
//     name:      'task_reminder',
//     type:      'TASK_REMINDER',          // users with it switched off are skipped up front
//     timezone?: 'Asia/Kolkata',           // fixed clock; omitted = the user's own timezone
//     audience?: 'onboarding',             // only users who haven't finished onboarding;
//                                          // omitted = only onboarded users
//     slot:      (settings, clock) => 'HH:MM' | null,   // null = not today
//     run:       async ({ userId, user, settings, local, clock }) => notification | null,
//   }
// `local` = getLocalTime(user timezone), `clock` = the job's clock (same as
// `local` unless the job sets `timezone`) → { dateStr, weekday, hour, minute, minutesOfDay }.

import cron from 'node-cron';
import prisma from '../config/prisma.js';
import { SCHEDULED_NOTIFICATION_JOBS } from '../services/scheduledNotificationJobs.js';
import { isNotificationEnabled } from '../services/userSettingsService.js';
import { getLocalTime, timeOfDayToMinutes, DEFAULT_TIMEZONE } from '../utils/timezone.js';
import { info, logError } from '../utils/logger.js';

const TICK_MINUTES = 15;

function isInTick(clock, slot) {
  const start = timeOfDayToMinutes(slot);
  const t     = clock.minutesOfDay;
  return t >= start && t < start + TICK_MINUTES;
}

export async function runNotificationScheduler(now = new Date()) {
  if (SCHEDULED_NOTIFICATION_JOBS.length === 0) return;

  const users = await prisma.users.findMany({
    where: {
      is_banned:        false,
      user_push_tokens: { some: {} },
    },
    select: { id: true, onboarding_done: true, created_at: true, user_settings: true },
  });

  const fixedClocks = new Map(); // job timezone → clock, computed once per tick
  let created = 0;

  for (const user of users) {
    const stored   = user.user_settings;
    const settings = stored ?? { timezone: DEFAULT_TIMEZONE, reminder_time: '19:00' };
    const local    = getLocalTime(settings.timezone, now);

    for (const job of SCHEDULED_NOTIFICATION_JOBS) {
      try {
        if ((job.audience === 'onboarding') === user.onboarding_done) continue;
        if (stored && !isNotificationEnabled(stored, job.type)) continue;

        let clock = local;
        if (job.timezone) {
          if (!fixedClocks.has(job.timezone)) fixedClocks.set(job.timezone, getLocalTime(job.timezone, now));
          clock = fixedClocks.get(job.timezone);
        }

        const slot = job.slot(settings, clock);
        if (!slot || !isInTick(clock, slot)) continue;

        const result = await job.run({ userId: user.id, user, settings, local, clock });
        if (result) created += 1;
      } catch (err) {
        logError(`Scheduled notification job ${job.name} failed for user ${user.id}: ${err.message}`);
      }
    }
  }

  if (created > 0) info(`Notification scheduler: ${created} notification(s) queued`);
}

// Fires at :00/:15/:30/:45 UTC — every whole-hour, :30 and :45 offset zone
// lands on a local quarter-hour too.
export const notificationSchedulerJob = cron.schedule('*/15 * * * *', () => {
  runNotificationScheduler().catch((err) =>
    logError(`Notification scheduler run crashed: ${err.message}`)
  );
});

export default notificationSchedulerJob;
