// src/services/broadcastService.js — Admin announcements (BROADCAST pushes).
//
// One broadcast = one notifications row per recipient, all sharing
// dedupe_key `broadcast:<uuid>` (so a retried request can't double-send
// and the history view can group them). Rows go through the normal outbox:
// per-user quiet hours are applied here up front, the push dispatcher
// delivers them, and they land in each user's inbox.
//
// Audiences:
//   all       — every onboarded, non-banned USER
//   inactive  — no active day in the last `inactive_days` IST days (or never)
// Users with notify_all / notify_announcements off are excluded.

import { randomUUID } from 'node:crypto';
import prisma from '../config/prisma.js';
import { computeDeliverAfter } from './notificationService.js';
import { isNotificationEnabled } from './userSettingsService.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { DEFAULT_TIMEZONE } from '../utils/timezone.js';
import { localToUtc } from '../utils/broadcastSchedule.js';
import { pageInfo } from '../utils/pageInfo.js';

export const BROADCAST_AUDIENCES = ['all', 'inactive'];

const MAX_TITLE      = 65;   // fits a lock-screen title line
const MAX_BODY       = 240;
const INSERT_CHUNK   = 1000;
const KEY_PREFIX     = 'broadcast:';

export function validateBroadcast({ title, body, url, audience, inactive_days }) {
  const cleanTitle = typeof title === 'string' ? title.trim() : '';
  const cleanBody  = typeof body === 'string' ? body.trim() : '';
  if (!cleanTitle) throw new Error('TITLE_REQUIRED');
  if (cleanTitle.length > MAX_TITLE) throw new Error('TITLE_TOO_LONG');
  if (!cleanBody) throw new Error('BODY_REQUIRED');
  if (cleanBody.length > MAX_BODY) throw new Error('BODY_TOO_LONG');

  const cleanUrl = typeof url === 'string' && url.trim() ? url.trim() : null;
  if (cleanUrl && (cleanUrl.length > 100 || !/^\/[\w\-()/[\]]*$/.test(cleanUrl))) throw new Error('INVALID_URL');

  if (!BROADCAST_AUDIENCES.includes(audience)) throw new Error('INVALID_AUDIENCE');

  let days = null;
  if (audience === 'inactive') {
    days = Number(inactive_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('INVALID_INACTIVE_DAYS');
  }

  return { title: cleanTitle, body: cleanBody, url: cleanUrl, audience, days };
}

function audienceWhere({ audience, days }) {
  // Accounts waiting to be deleted get no broadcasts (not even in the inbox).
  const where = { onboarding_done: true, is_banned: false, delete_at: null, role: 'USER' };
  if (audience === 'inactive') {
    const cutoff = getISTDateOnly(-days);
    where.OR = [
      { user_progression: { is: null } },
      { user_progression: { is: { last_active_date: null } } },
      { user_progression: { is: { last_active_date: { lt: cutoff } } } },
    ];
  }
  return where;
}

async function resolveRecipients(input) {
  const users = await prisma.users.findMany({
    where:  audienceWhere(input),
    select: {
      id: true,
      user_settings: { select: { notify_all: true, notify_announcements: true, timezone: true } },
      _count: { select: { user_push_tokens: true } },
    },
  });
  return users.filter((u) => !u.user_settings || isNotificationEnabled(u.user_settings, 'BROADCAST'));
}

// dry_run: true → counts only, nothing written.
export async function createBroadcast(adminId, payload) {
  const input = validateBroadcast(payload ?? {});
  if (payload?.dry_run === true) {
    const recipients = await resolveRecipients(input);
    return { dry_run: true, ...summarize(recipients) };
  }
  const broadcastId = randomUUID();
  const summary = await queueBroadcast(input, { broadcastId, sentBy: adminId });
  return { dry_run: false, broadcast_id: broadcastId, ...summary };
}

function summarize(recipients) {
  return {
    recipients:        recipients.length,
    reachable_by_push: recipients.filter((u) => u._count.user_push_tokens > 0).length,
  };
}

/**
 * Resolves the audience now and writes one PENDING notification per
 * recipient. Idempotent per broadcastId: re-running with the same id (a
 * scheduled run retried after a crash) skips everyone already written,
 * via UNIQUE (user_id, dedupe_key).
 *
 * localWall (scheduled broadcasts): a floating wall clock — each recipient
 * gets it when that time arrives in *their* timezone. deliver_after gates
 * both the push and the inbox (notificationService#inboxWhere), so nobody
 * sees it early; quiet hours still apply on top.
 */
export async function queueBroadcast(input, { broadcastId, sentBy, scheduleId = null, localWall = null }) {
  const recipients = await resolveRecipients(input);
  const now = new Date();
  const data = {
    event:        'BROADCAST',
    broadcast_id: broadcastId,
    sent_by:      sentBy == null ? null : String(sentBy),
    ...(scheduleId != null ? { schedule_id: String(scheduleId) } : {}),
    ...(input.url ? { url: input.url } : {}),
  };

  const rows = recipients.map((u) => {
    const tz = u.user_settings?.timezone || DEFAULT_TIMEZONE;
    const at = localWall ? localToUtc(localWall, tz) : now;
    return {
      user_id:       u.id,
      type:          'BROADCAST',
      title:         input.title,
      body:          input.body,
      data,
      dedupe_key:    broadcastDedupeKey(broadcastId),
      deliver_after: computeDeliverAfter('BROADCAST', tz, at),
      push_status:   'PENDING',
      // The inbox shows "sent" times — make them the hunter's local send time, not when the row was written.
      ...(localWall ? { sent_at: at, created_at: at } : {}),
    };
  });
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await prisma.notifications.createMany({ data: rows.slice(i, i + INSERT_CHUNK), skipDuplicates: true });
  }

  return summarize(recipients);
}

export function broadcastDedupeKey(broadcastId) {
  return `${KEY_PREFIX}${broadcastId}`;
}

// Newest first, with live delivery / read stats per broadcast.
export async function listBroadcasts({ limit, page } = {}) {
  const take = Math.max(1, Math.min(50, parseInt(limit) || 20));
  const pageNo = Math.max(1, parseInt(page) || 1);
  const base = { type: 'BROADCAST', dedupe_key: { startsWith: KEY_PREFIX } };

  const [all, groups] = await Promise.all([
    prisma.notifications.groupBy({ by: ['dedupe_key'], where: base }),
    prisma.notifications.groupBy({
      by:      ['dedupe_key', 'title', 'body'],
      where:   base,
      _count:  { _all: true },
      _min:    { created_at: true },
      orderBy: { _min: { created_at: 'desc' } },
      skip:    (pageNo - 1) * take,
      take,
    }),
  ]);
  const pagination = pageInfo(pageNo, take, all.length);
  if (groups.length === 0) return { broadcasts: [], pagination };

  const keys = groups.map((g) => g.dedupe_key);
  const [byStatus, readCounts] = await Promise.all([
    prisma.notifications.groupBy({ by: ['dedupe_key', 'push_status'], where: { ...base, dedupe_key: { in: keys } }, _count: { _all: true } }),
    prisma.notifications.groupBy({ by: ['dedupe_key'], where: { ...base, dedupe_key: { in: keys }, is_read: true }, _count: { _all: true } }),
  ]);

  const statusOf = (key, ...statuses) => byStatus
    .filter((s) => s.dedupe_key === key && statuses.includes(s.push_status))
    .reduce((sum, s) => sum + s._count._all, 0);

  const broadcasts = groups.map((g) => ({
    id:         g.dedupe_key.slice(KEY_PREFIX.length),
    title:      g.title,
    body:       g.body,
    created_at: g._min.created_at,
    recipients: g._count._all,
    pushed:     statusOf(g.dedupe_key, 'SENT'),
    pending:    statusOf(g.dedupe_key, 'PENDING', 'SENDING'),
    not_pushed: statusOf(g.dedupe_key, 'SKIPPED', 'FAILED'),
    read:       readCounts.find((r) => r.dedupe_key === g.dedupe_key)?._count._all ?? 0,
  }));
  return { broadcasts, pagination };
}
