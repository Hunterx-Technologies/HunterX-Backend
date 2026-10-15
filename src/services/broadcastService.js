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
//   users     — explicit user ids
// Users with notify_all / notify_announcements off are excluded.

import { randomUUID } from 'node:crypto';
import prisma from '../config/prisma.js';
import { computeDeliverAfter } from './notificationService.js';
import { isNotificationEnabled } from './userSettingsService.js';
import { getISTDateOnly } from '../utils/helpers.js';

export const BROADCAST_AUDIENCES = ['all', 'inactive', 'users'];

const MAX_TITLE      = 65;   // fits a lock-screen title line
const MAX_BODY       = 240;
const MAX_USER_IDS   = 5000;
const INSERT_CHUNK   = 1000;
const KEY_PREFIX     = 'broadcast:';

function validate({ title, body, url, audience, inactive_days, user_ids }) {
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

  let ids = null;
  if (audience === 'users') {
    if (!Array.isArray(user_ids) || user_ids.length === 0 || user_ids.length > MAX_USER_IDS
        || user_ids.some((id) => !/^\d+$/.test(String(id)))) {
      throw new Error('INVALID_USER_IDS');
    }
    ids = [...new Set(user_ids.map((id) => BigInt(id)))];
  }

  return { title: cleanTitle, body: cleanBody, url: cleanUrl, audience, days, ids };
}

function audienceWhere({ audience, days, ids }) {
  const where = { onboarding_done: true, is_banned: false, role: 'USER' };
  if (audience === 'users') where.id = { in: ids };
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
  const input      = validate(payload ?? {});
  const recipients = await resolveRecipients(input);
  const summary = {
    recipients:         recipients.length,
    reachable_by_push:  recipients.filter((u) => u._count.user_push_tokens > 0).length,
  };
  if (payload?.dry_run === true) return { dry_run: true, ...summary };

  const broadcastId = randomUUID();
  const now = new Date();
  const data = {
    event:        'BROADCAST',
    broadcast_id: broadcastId,
    sent_by:      String(adminId),
    ...(input.url ? { url: input.url } : {}),
  };

  const rows = recipients.map((u) => ({
    user_id:       u.id,
    type:          'BROADCAST',
    title:         input.title,
    body:          input.body,
    data,
    dedupe_key:    `${KEY_PREFIX}${broadcastId}`,
    deliver_after: computeDeliverAfter('BROADCAST', u.user_settings?.timezone, now),
    push_status:   'PENDING',
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await prisma.notifications.createMany({ data: rows.slice(i, i + INSERT_CHUNK), skipDuplicates: true });
  }

  return { dry_run: false, broadcast_id: broadcastId, ...summary };
}

// Newest first, with live delivery / read stats per broadcast.
export async function listBroadcasts({ limit } = {}) {
  const take = Math.max(1, Math.min(50, parseInt(limit) || 20));
  const base = { type: 'BROADCAST', dedupe_key: { startsWith: KEY_PREFIX } };

  const groups = await prisma.notifications.groupBy({
    by:      ['dedupe_key', 'title', 'body'],
    where:   base,
    _count:  { _all: true },
    _min:    { created_at: true },
    orderBy: { _min: { created_at: 'desc' } },
    take,
  });
  if (groups.length === 0) return [];

  const keys = groups.map((g) => g.dedupe_key);
  const [byStatus, readCounts] = await Promise.all([
    prisma.notifications.groupBy({ by: ['dedupe_key', 'push_status'], where: { ...base, dedupe_key: { in: keys } }, _count: { _all: true } }),
    prisma.notifications.groupBy({ by: ['dedupe_key'], where: { ...base, dedupe_key: { in: keys }, is_read: true }, _count: { _all: true } }),
  ]);

  const statusOf = (key, ...statuses) => byStatus
    .filter((s) => s.dedupe_key === key && statuses.includes(s.push_status))
    .reduce((sum, s) => sum + s._count._all, 0);

  return groups.map((g) => ({
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
}
