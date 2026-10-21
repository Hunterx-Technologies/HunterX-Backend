// src/services/questNotificationService.js — Announcing admin-created
// quests (free DAILY_ADMIN / WEEKLY / MONTHLY and paid tasks) to users.
//
// The morning IST scheduled jobs (scheduledNotificationJobs.js: new_quest
// at 07:00, paid_quest_launch at 08:00) cover everything starting on a
// given day as long as it exists by then. This service covers what those
// jobs can't see:
//   - a task created (or moved to start today) after its job ran — announced
//     right away instead of never (the next morning it's no longer "new")
//   - a paid offer coming back on sale after an admin extends end_date
// Each announcement uses a per-task dedupe key, and new_quest skips tasks
// already announced this way, so nobody hears about the same task twice.

import prisma from '../config/prisma.js';
import { createNotification } from './notificationService.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { getLocalTime } from '../utils/timezone.js';
import { info, logError } from '../utils/logger.js';

const IST            = 'Asia/Kolkata';
const DAY_MS         = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS  = 5.5 * 60 * 60 * 1000;
const NEW_QUEST_SLOT_H  = 7; // new_quest runs at 07:00 IST
const PAID_LAUNCH_SLOT_H = 8; // paid_quest_launch runs at 08:00 IST

export const QUEST_LABELS = {
  DAILY_ADMIN: "Today's quest",
  WEEKLY:      'Weekly quest',
  MONTHLY:     'Monthly quest',
};

export function dateKey(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

// A @db.Date (UTC midnight standing for an IST day) → "21 Oct".
export function formatDay(date) {
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// getISTDateOnly()-style date → the real instant that IST day ends.
export function istDayEnd(istDate) {
  return new Date(istDate.getTime() + DAY_MS - IST_OFFSET_MS);
}

export function newQuestKey(taskId) {
  return `new_quest_task:${taskId}`;
}

export function paidLaunchKey(task) {
  return `paid_quest_launch:${task.id}:${dateKey(task.start_date)}`;
}

export function isOnSale(task, date) {
  return Boolean(
    task.is_paid && task.is_active && task.start_date &&
    task.start_date.getTime() <= date.getTime() &&
    (!task.end_date || task.end_date.getTime() >= date.getTime())
  );
}

export function paidLaunchMessage(task) {
  const label = QUEST_LABELS[task.task_type] ?? 'Quest';
  return {
    title: `🔒 New premium quest: ${task.title}`,
    body:  `${label} · +${task.xp_reward} XP · ₹${Number(task.price)}. Available until ${formatDay(task.end_date)}.`,
  };
}

// Users who can receive a push: finished onboarding, not banned, a device
// registered. DAILY_ADMIN subset targeting (task_admin_targets) narrows it.
async function audience(task) {
  const targets = await prisma.task_admin_targets.findMany({
    where:  { task_id: task.id },
    select: { user_id: true },
  });
  const users = await prisma.users.findMany({
    where: {
      onboarding_done:  true,
      is_banned:        false,
      user_push_tokens: { some: {} },
      ...(targets.length > 0 ? { id: { in: targets.map((t) => t.user_id) } } : {}),
      // Paid: never pitch the offer to someone who already bought it.
      ...(task.is_paid ? { task_purchases: { none: { task_id: task.id, status: 'PAID' } } } : {}),
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

async function fanOut(task, { title, body, event, dedupeKey, expiresAt = null }) {
  const userIds = await audience(task);
  let created = 0;
  for (const userId of userIds) {
    try {
      const n = await createNotification(
        prisma, userId, 'NEW_QUEST', title, body,
        { event, task_ids: [String(task.id)] },
        { dedupeKey, expiresAt }
      );
      if (n) created += 1;
    } catch (err) {
      logError(`Quest announcement ${dedupeKey} failed for user ${userId}: ${err.message}`);
    }
  }
  if (created > 0) info(`Quest announcement ${dedupeKey}: ${created} notification(s) queued`);
  return created;
}

function slotPassed(hour, now = new Date()) {
  return getLocalTime(IST, now).hour >= hour;
}

// Called after an admin creates (existing = null) or edits a task.
export async function announceTaskChange(saved, existing = null) {
  if (!saved.is_active) return 0;

  const today       = getISTDateOnly();
  const startsToday = dateKey(saved.start_date) === dateKey(today);

  if (saved.is_paid) {
    const nowOnSale = isOnSale(saved, today);
    const wasOnSale = existing ? isOnSale(existing, today) : false;
    if (!nowOnSale || wasOnSale) return 0;

    // Offered before (started on an earlier day) → it's coming back.
    if (existing && existing.start_date.getTime() < today.getTime()) {
      return fanOut(saved, {
        title:     `${saved.title} is back`,
        body:      `This premium quest is on offer again until ${formatDay(saved.end_date)}.`,
        event:     'PAID_QUEST_BACK',
        dedupeKey: `paid_quest_back:${saved.id}:${dateKey(saved.end_date)}`,
      });
    }
    // Starts today and missed the 08:00 launch job → launch now.
    if (startsToday && slotPassed(PAID_LAUNCH_SLOT_H)) {
      return fanOut(saved, { ...paidLaunchMessage(saved), event: 'PAID_QUEST_LAUNCH', dedupeKey: paidLaunchKey(saved) });
    }
    return 0;
  }

  // Free task: only the "starts today, after 07:00" case needs help.
  if (!startsToday || !slotPassed(NEW_QUEST_SLOT_H)) return 0;
  if (existing && existing.is_active && dateKey(existing.start_date) === dateKey(today)) return 0;

  const label = QUEST_LABELS[saved.task_type] ?? 'Quest';
  const lastDay = saved.end_date ?? null;
  return fanOut(saved, {
    title:     `New quest: ${saved.title}`,
    body:      `${label} · +${saved.xp_reward} XP. Accept the challenge.`,
    event:     'NEW_QUEST',
    dedupeKey: newQuestKey(saved.id),
    expiresAt: lastDay ? istDayEnd(lastDay) : null,
  });
}
