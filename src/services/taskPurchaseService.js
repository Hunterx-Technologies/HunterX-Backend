// src/services/taskPurchaseService.js — Paid task access
//
// A paid task (tasks.is_paid) is shown locked to every user while it's on
// sale (tasks.start_date .. tasks.end_date). Buying it gives that user
// their own access window — access_start = the IST day they paid,
// access_end = tasks.end_date — and only then does taskAssignmentService
// assign it to them. Once end_date passes the nightly cron deactivates
// the task (deactivateExpiredPaidTasks).
//
// access_end is fixed at purchase time: an admin edit moving end_date
// (adminTaskService.updateTask) only extends the offer for users who haven't bought it. A buyer
// who COMPLETES the task closes it for themselves (completed_at) — it's
// no longer assigned, listed, or offered to them again.
//
// No payment gateway is wired yet: markPurchasePaid() is meant to be
// called by the gateway's verified callback/webhook, never directly from
// a client request, since it's what unlocks the task.

import prisma from '../config/prisma.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { assignDailyTasks } from './taskAssignmentService.js';
import { createNotification } from './notificationService.js';
import { formatDay } from './questNotificationService.js';
import { logError } from '../utils/logger.js';

function onSaleOn(task, date) {
  return task.is_paid && task.is_active &&
    task.start_date && task.start_date.getTime() <= date.getTime() &&
    (!task.end_date || task.end_date.getTime() >= date.getTime());
}

// Purchases that still count for this user on `date`: either access is
// running, or they already completed it (closed for good).
function activeOrCompleted(date) {
  return {
    status: 'PAID',
    OR: [
      { completed_at: { not: null } },
      { access_start: { lte: date }, access_end: { gte: date } },
    ],
  };
}

// The user's PAID, not-yet-completed purchase covering `date`, if any.
export async function getActivePurchase(bUserId, taskId, date = getISTDateOnly()) {
  return prisma.task_purchases.findFirst({
    where: {
      user_id:      bUserId,
      task_id:      BigInt(taskId),
      status:       'PAID',
      completed_at: null,
      access_start: { lte: date },
      access_end:   { gte: date },
    },
  });
}

// Called inside setTaskCompletion's transaction when a buyer marks a paid
// task COMPLETED. Returns true only the first time (the purchase was still
// open), so a resent COMPLETED doesn't announce the clear twice.
export async function markPurchaseCompleted(tx, bUserId, taskId, date = getISTDateOnly()) {
  const { count } = await tx.task_purchases.updateMany({
    where: {
      user_id:      bUserId,
      task_id:      BigInt(taskId),
      status:       'PAID',
      completed_at: null,
      access_start: { lte: date },
      access_end:   { gte: date },
    },
    data: { completed_at: new Date(), updated_at: new Date() },
  });
  return count > 0;
}

// Paid task ids this user has completed — hidden from their task lists.
export async function getCompletedPaidTaskIds(bUserId) {
  const rows = await prisma.task_purchases.findMany({
    where:  { user_id: bUserId, status: 'PAID', completed_at: { not: null } },
    select: { task_id: true },
  });
  return new Set(rows.map(r => r.task_id));
}

// Creates the PENDING purchase row a payment is taken against. The amount
// is copied from the task so a later price change can't alter it.
export async function createPendingPurchase(userId, taskId, { provider = null } = {}) {
  const bUserId = BigInt(userId);
  const today = getISTDateOnly();

  const task = await prisma.tasks.findUnique({ where: { id: BigInt(taskId) } });
  if (!task) throw new Error('TASK_NOT_FOUND');
  if (!task.is_paid) throw new Error('TASK_NOT_PAID');
  if (!onSaleOn(task, today)) throw new Error('TASK_NOT_ON_SALE');
  const existing = await prisma.task_purchases.findFirst({
    where:  { user_id: bUserId, task_id: task.id, ...activeOrCompleted(today) },
    select: { completed_at: true },
  });
  if (existing?.completed_at) throw new Error('ALREADY_COMPLETED');
  if (existing) throw new Error('ALREADY_PURCHASED');

  return prisma.task_purchases.create({
    data: {
      user_id:          bUserId,
      task_id:          task.id,
      amount:           task.price,
      currency:         task.currency,
      payment_provider: provider,
    },
  });
}

// Called once the gateway confirms payment. Idempotent on an already-PAID
// row, so a retried webhook doesn't shift the access window.
export async function markPurchasePaid(purchaseId, { paymentRef = null } = {}) {
  const purchase = await prisma.task_purchases.findUnique({
    where:   { id: BigInt(purchaseId) },
    include: { tasks: { select: { title: true, end_date: true, is_active: true } } },
  });
  if (!purchase) throw new Error('PURCHASE_NOT_FOUND');
  if (purchase.status === 'PAID') return purchase;
  if (purchase.status !== 'PENDING') throw new Error('PURCHASE_NOT_PENDING');

  const accessStart = getISTDateOnly();
  const accessEnd = purchase.tasks.end_date;
  if (!purchase.tasks.is_active || !accessEnd || accessEnd.getTime() < accessStart.getTime())
    throw new Error('TASK_NOT_ON_SALE'); // offer ended between checkout and payment

  const paid = await prisma.task_purchases.update({
    where: { id: purchase.id },
    data: {
      status:       'PAID',
      payment_ref:  paymentRef,
      access_start: accessStart,
      access_end:   accessEnd,
      paid_at:      new Date(),
      updated_at:   new Date(),
    },
  });

  // Unlock immediately instead of waiting for the nightly cron.
  await assignDailyTasks(purchase.user_id, accessStart);

  // Receipt push. The payment already went through, so a push failure
  // must never fail the webhook.
  await createNotification(
    prisma, purchase.user_id, 'PURCHASE_CONFIRMED',
    `✅ Quest unlocked: ${purchase.tasks.title}`,
    `Payment received. Your quest is ready — complete it by ${formatDay(accessEnd)}.`,
    { event: 'PURCHASE_CONFIRMED', purchase_id: String(purchase.id), task_id: String(purchase.task_id) },
    { dedupeKey: `purchase_paid:${purchase.id}` }
  ).catch((err) => logError(`Purchase push failed for purchase ${purchase.id}: ${err.message}`));

  return paid;
}

// Paid tasks on sale today that this user hasn't got access to — shown
// locked on the task list.
export async function getLockedTasks(bUserId, date = getISTDateOnly()) {
  return prisma.tasks.findMany({
    where: {
      is_active:  true,
      is_paid:    true,
      start_date: { lte: date },
      OR: [{ end_date: { gte: date } }, { end_date: null }],
      task_purchases: { none: { user_id: bUserId, ...activeOrCompleted(date) } },
    },
    orderBy: { created_at: 'desc' },
  });
}

// Nightly: a paid task stops being offered (and every buyer's access ends)
// after its end_date, so flip it inactive.
export async function deactivateExpiredPaidTasks(today = getISTDateOnly()) {
  const { count } = await prisma.tasks.updateMany({
    where: { is_paid: true, is_active: true, end_date: { lt: today } },
    data:  { is_active: false, updated_at: new Date() },
  });
  return count;
}
