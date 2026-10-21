// src/services/notificationService.js — Notification creation with user settings gating.
//
// Every notification row doubles as a push outbox entry: it is written
// PENDING here (usually inside the caller's transaction) and delivered after
// commit by the push dispatcher (pushDispatchService.js), so a rolled-back
// level-up never pushes. Guardrails applied at write time:
//   - settings gating (notify_all + the type's notify_* column)
//   - quiet hours: deliver_after is pushed to QUIET_HOURS_END local time
//   - daily cap: capped types past DAILY_PUSH_CAP stay in the inbox but
//     are marked SKIPPED (never pushed)
//   - dedupeKey: one row per (user, key) — makes scheduled jobs re-runnable.
//     Only pass it from non-transactional callers: a unique violation inside
//     a Postgres transaction aborts the whole transaction.
//   - expiresAt: if quiet hours would defer delivery past this moment the
//     notification is dropped entirely ("4h left" is worthless at 7 AM).

import prisma from '../config/prisma.js';
import { getUserSettings, isNotificationEnabled } from './userSettingsService.js';
import {
  getNotificationTypeConfig,
  CAPPED_TYPES,
  DAILY_PUSH_CAP,
  QUIET_HOURS_START,
  QUIET_HOURS_END,
} from '../config/notificationTypes.js';
import { getLocalTime, isWithinHours, minutesUntilLocalHour } from '../utils/timezone.js';

const DAY_MS    = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// When a notification of `type` created at `now` may be pushed to a user in
// `timezone`: now, or QUIET_HOURS_END local if now is inside quiet hours.
export function computeDeliverAfter(type, timezone, now = new Date()) {
  if (!getNotificationTypeConfig(type).quietHours) return now;
  const local = getLocalTime(timezone, now);
  if (!isWithinHours(local, QUIET_HOURS_START, QUIET_HOURS_END)) return now;
  return new Date(now.getTime() + minutesUntilLocalHour(local, QUIET_HOURS_END) * MINUTE_MS);
}

export async function createNotification(client, userId, type, title, body, data = null, options = {}) {
  const { dedupeKey = null, imageUrl = null, quoteId = null, expiresAt = null } = options;
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  let settings = null;
  try {
    settings = await getUserSettings(bUserId);
  } catch {
    // Settings lookup failing shouldn't swallow a level-up — fall through
    // with defaults (all on, default timezone).
  }
  if (settings && !isNotificationEnabled(settings, type)) {
    return null;
  }

  if (dedupeKey) {
    const existing = await client.notifications.findFirst({
      where:  { user_id: bUserId, dedupe_key: dedupeKey },
      select: { id: true },
    });
    if (existing) return null;
  }

  const config = getNotificationTypeConfig(type);
  const now    = new Date();

  const deliverAfter = computeDeliverAfter(type, settings?.timezone, now);
  if (expiresAt && deliverAfter >= expiresAt) {
    return null;
  }

  let pushStatus = 'PENDING';
  let pushError  = null;
  if (config.capped) {
    const recent = await client.notifications.count({
      where: {
        user_id:       bUserId,
        type:          { in: CAPPED_TYPES },
        push_status:   { in: ['PENDING', 'SENDING', 'SENT'] },
        deliver_after: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (recent >= DAILY_PUSH_CAP) {
      pushStatus = 'SKIPPED';
      pushError  = 'daily_cap';
    }
  }

  try {
    return await client.notifications.create({
      data: {
        user_id:       bUserId,
        type,
        title,
        body,
        data,
        image_url:     imageUrl,
        quote_id:      quoteId,
        dedupe_key:    dedupeKey,
        deliver_after: deliverAfter,
        push_status:   pushStatus,
        push_error:    pushError,
      },
    });
  } catch (err) {
    // Lost a race with another run of the same scheduled job.
    if (dedupeKey && err.code === 'P2002') return null;
    throw err;
  }
}

// ── Inbox (GET/POST /api/notifications) ───────────────────
// A row shows up in the inbox once it's due (deliver_after <= now) — a
// notification held back by quiet hours appears when its push goes out,
// not before. Rows the cap SKIPPED from push still show: the inbox is the
// full history, push is the interruption.

const INBOX_DEFAULT_LIMIT = 20;
const INBOX_MAX_LIMIT     = 50;

function inboxWhere(bUserId, now) {
  return { user_id: bUserId, deliver_after: { lte: now } };
}

function formatInboxItem(n) {
  const data = (n.data && typeof n.data === 'object') ? n.data : {};
  return {
    id:         String(n.id),
    type:       n.type,
    title:      n.title,
    body:       n.body,
    image_url:  n.image_url,
    url:        data.url || getNotificationTypeConfig(n.type).url,
    data,
    is_read:    n.is_read,
    created_at: n.created_at,
  };
}

export async function listNotifications(userId, { cursor, limit } = {}) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const take    = Math.max(1, Math.min(INBOX_MAX_LIMIT, parseInt(limit) || INBOX_DEFAULT_LIMIT));
  const now     = new Date();

  let cursorId = null;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    if (!/^\d+$/.test(String(cursor))) throw new Error('INVALID_CURSOR');
    cursorId = BigInt(cursor);
  }

  const [rows, unreadCount] = await Promise.all([
    prisma.notifications.findMany({
      where:   { ...inboxWhere(bUserId, now), ...(cursorId ? { id: { lt: cursorId } } : {}) },
      orderBy: { id: 'desc' },
      take:    take + 1,
      select:  { id: true, type: true, title: true, body: true, image_url: true, data: true, is_read: true, created_at: true },
    }),
    getUnreadCount(bUserId, now),
  ]);

  const page = rows.slice(0, take);
  return {
    notifications: page.map(formatInboxItem),
    next_cursor:   rows.length > take ? String(page[page.length - 1].id) : null,
    unread_count:  unreadCount,
  };
}

export async function getUnreadCount(userId, now = new Date()) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  return prisma.notifications.count({ where: { ...inboxWhere(bUserId, now), is_read: false } });
}

// ids: array of notification ids, or all: true. Only ever touches the
// caller's own rows. Returns the new unread count for the bell badge.
export async function markNotificationsRead(userId, { ids, all } = {}) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const now     = new Date();

  const where = { ...inboxWhere(bUserId, now), is_read: false };
  if (!all) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 100 || ids.some((id) => !/^\d+$/.test(String(id)))) {
      throw new Error('INVALID_IDS');
    }
    where.id = { in: ids.map((id) => BigInt(id)) };
  }

  await prisma.notifications.updateMany({ where, data: { is_read: true, read_at: now } });
  return { unread_count: await getUnreadCount(bUserId, now) };
}

// ── Retention ─────────────────────────────────────────────
// Nightly (src/cron/midnight.js): notifications older than RETENTION_DAYS
// are deleted — inbox history, push outbox state and broadcast stats
// alike. Safe for dedupe: every scheduled job keys on a specific day or
// one-time event (≤14 days out), so a deleted row can't make its job fire
// again. Deleted in batches so the table is never locked for long.
// sent_at is the insert time (never updated) and is indexed.

export const NOTIFICATION_RETENTION_DAYS = 60;
const RETENTION_BATCH = 5000;

export async function deleteOldNotifications(now = new Date()) {
  const cutoff = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
  let total = 0;
  for (;;) {
    const deleted = await prisma.$executeRaw`
      DELETE FROM notifications WHERE id IN (
        SELECT id FROM notifications WHERE sent_at < ${cutoff} LIMIT ${RETENTION_BATCH}
      )`;
    total += deleted;
    if (deleted < RETENTION_BATCH) return total;
  }
}
