// src/services/pushDispatchService.js — Delivers the notifications outbox.
//
// runPushDispatch() (every minute):
//   1. requeue rows stuck in SENDING (process died mid-send)
//   2. expire PENDING rows that are too old to still be relevant
//   3. claim due PENDING rows with a per-run claim id — the conditional
//      updateMany is row-atomic, so overlapping runs / instances never
//      double-send
//   4. send one Expo message per (notification, device)
//   5. SENT if any device accepted; otherwise requeue with backoff or FAILED
//
// runPushReceiptCheck() (every 15 min): Expo only reports most delivery
// failures (e.g. app uninstalled → DeviceNotRegistered) in receipts, so
// dead tokens are pruned there.
//
// Timestamps are always passed from JS (never DB now()): the column type is
// TIMESTAMP without zone and a non-UTC DB session would skew comparisons.

import { randomUUID } from 'node:crypto';
import prisma from '../config/prisma.js';
import { getNotificationTypeConfig } from '../config/notificationTypes.js';
import { sendPushMessages, getPushReceipts, getTokensForUsers, removeTokens } from './pushService.js';
import { info, logError } from '../utils/logger.js';

const MINUTE_MS = 60 * 1000;

const BATCH_SIZE         = 500;
const MAX_ATTEMPTS       = 3;
const STALE_CLAIM_MS     = 10 * MINUTE_MS;
const MAX_AGE_MS         = 6 * 60 * MINUTE_MS; // past deliver_after — stop trying
const RETRY_BACKOFF_MS   = [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS];
const RECEIPT_DELAY_MS   = 15 * MINUTE_MS;     // Expo: receipts ready after ~15 min
const RECEIPT_MAX_AGE_MS = 24 * 60 * MINUTE_MS; // Expo drops receipts after ~24h

// Ticket/receipt errors that mean the token is dead, not the message.
const DEAD_TOKEN_ERRORS = new Set(['DeviceNotRegistered']);

function buildMessage(notification, token) {
  const config = getNotificationTypeConfig(notification.type);
  const data   = (notification.data && typeof notification.data === 'object') ? notification.data : {};
  return {
    to:        token,
    title:     notification.title,
    body:      notification.body,
    sound:     'default',
    priority:  'high',
    channelId: config.channel,
    ...(notification.image_url ? { richContent: { image: notification.image_url } } : {}),
    data: {
      ...data,
      notification_id: String(notification.id),
      type:            notification.type,
      url:             data.url || config.url,
    },
  };
}

async function claimDueNotifications(now) {
  const due = await prisma.notifications.findMany({
    where: {
      push_status:   'PENDING',
      deliver_after: { lte: now },
      user_id:       { not: null },
    },
    orderBy: { id: 'asc' },
    take:    BATCH_SIZE,
    select:  { id: true },
  });
  if (due.length === 0) return [];

  const claim = randomUUID();
  await prisma.notifications.updateMany({
    where: { id: { in: due.map((n) => n.id) }, push_status: 'PENDING' },
    data:  {
      push_status:     'SENDING',
      push_claim:      claim,
      push_claimed_at: now,
      push_attempts:   { increment: 1 },
    },
  });

  return prisma.notifications.findMany({
    where:  { push_claim: claim, push_status: 'SENDING' },
    select: {
      id: true, user_id: true, type: true, title: true, body: true,
      data: true, image_url: true, push_attempts: true,
    },
  });
}

export async function runPushDispatch() {
  const now = new Date();

  // 1. Requeue stale claims.
  await prisma.notifications.updateMany({
    where: { push_status: 'SENDING', push_claimed_at: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    data:  { push_status: 'PENDING', push_claim: null },
  });

  // 2. Expire stale backlog (e.g. after downtime) instead of blasting it.
  await prisma.notifications.updateMany({
    where: { push_status: 'PENDING', deliver_after: { lt: new Date(now.getTime() - MAX_AGE_MS) } },
    data:  { push_status: 'SKIPPED', push_error: 'expired' },
  });

  // 3. Claim.
  const notifications = await claimDueNotifications(now);
  if (notifications.length === 0) return { sent: 0, failed: 0, skipped: 0 };

  // 4. Fan out to devices.
  const tokens = await getTokensForUsers([...new Set(notifications.map((n) => n.user_id))]);
  const tokensByUser = new Map();
  for (const { user_id, token } of tokens) {
    const key = String(user_id);
    if (!tokensByUser.has(key)) tokensByUser.set(key, []);
    tokensByUser.get(key).push(token);
  }

  const messages = [];
  const targets  = []; // parallel to messages: { notificationId, token }
  const noDevice = [];
  for (const n of notifications) {
    const userTokens = tokensByUser.get(String(n.user_id)) ?? [];
    if (userTokens.length === 0) {
      noDevice.push(n.id);
      continue;
    }
    for (const token of userTokens) {
      messages.push(buildMessage(n, token));
      targets.push({ notificationId: n.id, token });
    }
  }

  const tickets = messages.length > 0 ? await sendPushMessages(messages) : [];

  // 5. Fold tickets back onto notifications.
  const outcome    = new Map(); // id → { ok, retryable, error }
  const receipts   = [];
  const deadTokens = [];
  tickets.forEach((ticket, i) => {
    const { notificationId, token } = targets[i];
    const key  = String(notificationId);
    const prev = outcome.get(key) ?? { ok: false, retryable: false, error: null };

    if (ticket.status === 'ok') {
      prev.ok = true;
      if (ticket.id) receipts.push({ ticket_id: ticket.id, token, notification_id: notificationId, created_at: now });
    } else {
      const code = ticket.details?.error;
      if (DEAD_TOKEN_ERRORS.has(code)) deadTokens.push(token);
      if (ticket.retryable) prev.retryable = true;
      prev.error = (code || ticket.message || 'unknown_error').slice(0, 500);
    }
    outcome.set(key, prev);
  });

  const sentIds = [];
  let failed = 0;
  for (const n of notifications) {
    const result = outcome.get(String(n.id));
    if (!result) continue; // no device — handled below
    if (result.ok) {
      sentIds.push(n.id);
    } else if (result.retryable && n.push_attempts < MAX_ATTEMPTS) {
      const backoff = RETRY_BACKOFF_MS[Math.min(n.push_attempts - 1, RETRY_BACKOFF_MS.length - 1)];
      await prisma.notifications.update({
        where: { id: n.id },
        data:  {
          push_status:   'PENDING',
          push_claim:    null,
          push_error:    result.error,
          deliver_after: new Date(now.getTime() + backoff),
        },
      });
    } else {
      failed += 1;
      await prisma.notifications.update({
        where: { id: n.id },
        data:  { push_status: 'FAILED', push_claim: null, push_error: result.error },
      });
    }
  }

  if (sentIds.length > 0) {
    await prisma.notifications.updateMany({
      where: { id: { in: sentIds } },
      data:  { push_status: 'SENT', push_claim: null, pushed_at: now, push_error: null },
    });
  }
  if (noDevice.length > 0) {
    await prisma.notifications.updateMany({
      where: { id: { in: noDevice } },
      data:  { push_status: 'SKIPPED', push_claim: null, push_error: 'no_device' },
    });
  }
  if (receipts.length > 0) {
    await prisma.push_receipts.createMany({ data: receipts, skipDuplicates: true });
  }
  if (deadTokens.length > 0) {
    await removeTokens(deadTokens);
  }

  const summary = { sent: sentIds.length, failed, skipped: noDevice.length };
  info(`Push dispatch: ${JSON.stringify(summary)} (${messages.length} message(s), ${deadTokens.length} dead token(s) pruned)`);
  return summary;
}

export async function runPushReceiptCheck() {
  const now = new Date();

  const pending = await prisma.push_receipts.findMany({
    where:   { created_at: { lte: new Date(now.getTime() - RECEIPT_DELAY_MS) } },
    orderBy: { id: 'asc' },
    take:    1000,
    select:  { id: true, ticket_id: true, token: true },
  });
  if (pending.length === 0) return;

  let receipts;
  try {
    receipts = await getPushReceipts(pending.map((r) => r.ticket_id));
  } catch (err) {
    logError(`Push receipt check failed: ${err.message}`);
    return;
  }

  const deadTokens = [];
  const checkedIds = [];
  for (const row of pending) {
    const receipt = receipts[row.ticket_id];
    if (!receipt) continue; // not ready yet — retried next run (or aged out below)
    checkedIds.push(row.id);
    if (receipt.status === 'error') {
      const code = receipt.details?.error;
      if (DEAD_TOKEN_ERRORS.has(code)) {
        deadTokens.push(row.token);
      } else {
        // MessageTooBig / MessageRateExceeded / MismatchSenderId /
        // InvalidCredentials — config problems worth surfacing.
        logError(`Push receipt error ${code || ''} for ticket ${row.ticket_id}: ${receipt.message || ''}`);
      }
    }
  }

  if (deadTokens.length > 0) await removeTokens(deadTokens);
  await prisma.push_receipts.deleteMany({
    where: {
      OR: [
        { id: { in: checkedIds } },
        { created_at: { lt: new Date(now.getTime() - RECEIPT_MAX_AGE_MS) } },
      ],
    },
  });

  info(`Push receipts: checked ${checkedIds.length}, pruned ${deadTokens.length} dead token(s)`);
}
