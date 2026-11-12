// src/services/friendService.js — Friends between existing hunters.
//
// One friendships row per pair, smaller id first (user_low < user_high):
//   PENDING   a request from requested_by, waiting for the other hunter
//   ACCEPTED  friends (both see each other on the Friends leaderboard)
//   DECLINED  turned down; the sender can ask again after REQUEST_COOLDOWN_DAYS
// Signing up with someone's invite code makes the pair friends straight away
// (source INVITE, see linkInvitePair); so does an existing hunter opening
// someone's invite link and tapping Add friend (source LINK) — sharing your
// link is already the invitation. A request from the leaderboard or a pasted
// code (source REQUEST) needs the other hunter to accept.
//
// A block (user_blocks) removes any friendship or request between the pair
// and stops new ones in either direction. To the blocked hunter the blocker
// simply isn't found.
//
// Pushes: FRIEND_REQUEST to the receiver, FRIEND_ACCEPTED back to the sender.
// Declines, cancels and removals are silent.

import prisma from '../config/prisma.js';
import { createNotification } from './notificationService.js';
import { getLevelInfo, buildAvatarThumbUrl } from './leaderboardService.js';
import { computeGap } from './streakService.js';
import { getISTDateOnly, normalizeReferralCode } from '../utils/helpers.js';
import { logError } from '../utils/logger.js';
import { FRIENDS_REFERRAL_CAP as FRIENDS_CAP } from '../config/leaderboardConfig.js';

export const DAILY_REQUEST_LIMIT = 30;       // requests one hunter can send per 24h
export const REQUEST_COOLDOWN_DAYS = 7;      // before asking again after a decline
const DAY_MS = 86_400_000;
const FRIENDS_URL = '/(tabs)/leaderboard?tab=friends';

const toBig = (id) => (typeof id === 'bigint' ? id : BigInt(id));

/** The pair's key, smaller id first. */
export function pairKey(a, b) {
  const x = toBig(a);
  const y = toBig(b);
  return x < y ? { user_low: x, user_high: y } : { user_low: y, user_high: x };
}

function findPair(client, a, b) {
  return client.friendships.findUnique({ where: { user_low_user_high: pairKey(a, b) } });
}

/**
 * Inside the sign-up / late-referral transaction: the inviter and the new
 * hunter are friends from the start. Upgrades a pending or declined row.
 */
export async function linkInvitePair(tx, inviterId, inviteeId) {
  if (toBig(inviterId) === toBig(inviteeId)) return;
  const now = new Date();
  const key = pairKey(inviterId, inviteeId);
  await tx.friendships.upsert({
    where:  { user_low_user_high: key },
    create: { ...key, requested_by: toBig(inviterId), status: 'ACCEPTED', source: 'INVITE', accepted_at: now },
    update: { status: 'ACCEPTED', accepted_at: now, updated_at: now },
  });
}

/** Ids of everyone `userId` is friends with (not including themselves). */
export async function getFriendIds(userId, client = prisma, cap = FRIENDS_CAP) {
  const me = toBig(userId);
  const rows = await client.friendships.findMany({
    where:   { status: 'ACCEPTED', OR: [{ user_low: me }, { user_high: me }] },
    orderBy: { accepted_at: 'desc' },
    take:    cap,
    select:  { user_low: true, user_high: true },
  });
  return rows.map((r) => (r.user_low === me ? r.user_high : r.user_low));
}

// ── Who can be shown / asked ──────────────────────────────

const PROFILE_SELECT = {
  id: true, name: true, role: true, is_banned: true, delete_at: true, onboarding_done: true,
  created_at: true, referral_code: true,
  avatars:          { select: { image_url: true } },
  user_settings:    { select: { leaderboard_visible: true } },
  user_progression: { select: { total_xp: true, daily_streak: true, longest_streak: true, streak_lives: true, last_active_date: true } },
};

// Banned, admin, mid-onboarding and pending-deletion accounts can't be
// friended and aren't shown.
function isActiveHunter(u) {
  return Boolean(u) && u.role === 'USER' && !u.is_banned && !u.delete_at && Boolean(u.onboarding_done);
}

async function blockBetween(meId, otherId) {
  const rows = await prisma.user_blocks.findMany({
    where:  { OR: [{ blocker_id: meId, blocked_id: otherId }, { blocker_id: otherId, blocked_id: meId }] },
    select: { blocker_id: true },
  });
  return {
    iBlocked:      rows.some((r) => r.blocker_id === meId),
    theyBlockedMe: rows.some((r) => r.blocker_id === otherId),
  };
}

/**
 * How `meId` stands with the other hunter, for the card's button:
 *   self | none | friends | requested (I asked) | incoming (they asked) | blocked (I blocked them)
 * A declined request reads as none for both.
 */
function relationshipFrom(meId, row, iBlocked) {
  if (iBlocked) return 'blocked';
  if (!row || row.status === 'DECLINED') return 'none';
  if (row.status === 'ACCEPTED') return 'friends';
  return row.requested_by === meId ? 'requested' : 'incoming';
}

// Same "broken if the gap is longer than the lives" rule as the leaderboard.
function currentStreak(p) {
  if (!p) return 0;
  const { missedDays, coveredByLives } = computeGap(p, getISTDateOnly());
  return missedDays > 0 && !coveredByLives ? 0 : p.daily_streak;
}

function toCard(u, relationship, row) {
  const p = u.user_progression;
  const totalXp = p?.total_xp ?? 0;
  const { level, rankName } = getLevelInfo(totalXp);
  return {
    userId:        u.id.toString(),
    name:          u.name?.trim() || 'Hunter',
    avatarThumbUrl: buildAvatarThumbUrl(u.avatars?.image_url ?? null),
    level,
    rankName,
    totalXp,
    streak:        currentStreak(p),
    longestStreak: p?.longest_streak ?? 0,
    joinedAt:      u.created_at,
    friendsSince:  relationship === 'friends' ? row?.accepted_at ?? null : null,
    relationship,
  };
}

/**
 * A hunter's card, by id (tapped on the leaderboard) or by invite code
 * (pasted, or an invite link). By id, a hunter who hid themselves from the
 * leaderboard is only shown to people they already have a request or
 * friendship with; a code was shared on purpose, so it always works.
 * Throws USER_NOT_FOUND for unknown, inactive, or blocked-me accounts.
 */
export async function getCard(meId, { userId, code } = {}) {
  const me = toBig(meId);
  let other;
  if (code !== undefined) {
    const norm = normalizeReferralCode(code);
    if (!norm) throw new Error('INVALID_CODE');
    other = await prisma.users.findUnique({ where: { referral_code: norm }, select: PROFILE_SELECT });
  } else {
    if (!/^\d+$/.test(String(userId ?? ''))) throw new Error('USER_NOT_FOUND');
    other = await prisma.users.findUnique({ where: { id: BigInt(userId) }, select: PROFILE_SELECT });
  }
  if (other && other.id === me) {
    return toCard(other, 'self', null);
  }
  if (!isActiveHunter(other)) throw new Error('USER_NOT_FOUND');

  const [row, blocks] = await Promise.all([findPair(prisma, me, other.id), blockBetween(me, other.id)]);
  if (blocks.theyBlockedMe) throw new Error('USER_NOT_FOUND');
  const relationship = relationshipFrom(me, row, blocks.iBlocked);

  const hidden = other.user_settings?.leaderboard_visible === false;
  if (code === undefined && hidden && relationship === 'none') throw new Error('USER_NOT_FOUND');

  return toCard(other, relationship, row);
}

// Loads both sides for a write, enforcing who can be asked.
async function loadPair(meId, otherId) {
  const me = toBig(meId);
  if (!/^\d+$/.test(String(otherId ?? ''))) throw new Error('USER_NOT_FOUND');
  const other = toBig(otherId);
  if (other === me) throw new Error('CANNOT_FRIEND_SELF');
  const [them, blocks] = await Promise.all([
    prisma.users.findUnique({ where: { id: other }, select: { id: true, name: true, role: true, is_banned: true, delete_at: true, onboarding_done: true } }),
    blockBetween(me, other),
  ]);
  if (!isActiveHunter(them) || blocks.theyBlockedMe) throw new Error('USER_NOT_FOUND');
  if (blocks.iBlocked) throw new Error('USER_BLOCKED');
  return { me, other, them };
}

async function nameOf(userId) {
  const u = await prisma.users.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name?.trim() || 'A hunter';
}

// Pushes never fail the friendship change itself.
async function notify(userId, type, title, body, data, dedupeKey) {
  try {
    await createNotification(prisma, userId, type, title, body, { url: FRIENDS_URL, ...data }, dedupeKey ? { dedupeKey } : {});
  } catch (err) {
    logError(`${type} push for ${userId} failed: ${err.message || err}`);
  }
}

function notifyRequest(toId, fromId, fromName) {
  // One push per sender per receiver per day, so cancel-and-resend can't spam.
  const day = getISTDateOnly().toISOString().slice(0, 10);
  return notify(
    toId, 'FRIEND_REQUEST',
    '🤝 New friend request',
    `${fromName} wants to be your friend. Tap to accept or decline.`,
    { event: 'FRIEND_REQUEST', from_user_id: fromId.toString() },
    `friend_request:${fromId}:${day}`
  );
}

function notifyAccepted(toId, byId, byName, viaLink = false) {
  // Per day, so re-friending after a removal still tells them (an all-time
  // key silently dropped it), while a double tap can't push twice.
  const day = getISTDateOnly().toISOString().slice(0, 10);
  return notify(
    toId, 'FRIEND_ACCEPTED',
    viaLink ? `🤝 ${byName} added you as a friend` : `✅ ${byName} accepted your friend request`,
    viaLink ? 'They opened your invite link. You can now see each other on the Friends leaderboard.'
            : 'You are now friends. See how you stack up on the Friends leaderboard.',
    { event: 'FRIEND_ACCEPTED', friend_id: byId.toString() },
    `${viaLink ? 'friend_link' : 'friend_accepted'}:${byId}:${toId}:${day}`
  );
}

/**
 * Asks `otherId` to be friends. If they already asked me, this accepts
 * their request instead. Returns { relationship }.
 */
export async function sendRequest(meId, otherId) {
  const { me, other } = await loadPair(meId, otherId);
  const row = await findPair(prisma, me, other);

  if (row?.status === 'ACCEPTED') return { relationship: 'friends' };
  if (row?.status === 'PENDING' && row.requested_by === me) return { relationship: 'requested' };
  if (row?.status === 'PENDING' && row.requested_by === other) return acceptRequest(me, other);
  if (row?.status === 'DECLINED' && row.requested_by === me
      && Date.now() - row.updated_at.getTime() < REQUEST_COOLDOWN_DAYS * DAY_MS) {
    throw new Error('REQUEST_COOLDOWN');
  }

  const sentToday = await prisma.friendships.count({
    where: { requested_by: me, source: 'REQUEST', created_at: { gt: new Date(Date.now() - DAY_MS) } },
  });
  if (sentToday >= DAILY_REQUEST_LIMIT) throw new Error('REQUEST_LIMIT');

  const now = new Date();
  const key = pairKey(me, other);
  // Conditional writes, so two taps (or both hunters at once) settle on one row.
  if (row) {
    const { count } = await prisma.friendships.updateMany({
      where: { ...key, status: 'DECLINED' },
      data:  { status: 'PENDING', requested_by: me, source: 'REQUEST', created_at: now, updated_at: now, accepted_at: null },
    });
    if (count === 0) return sendRequest(meId, otherId);
  } else {
    try {
      await prisma.friendships.create({ data: { ...key, requested_by: me, status: 'PENDING', source: 'REQUEST' } });
    } catch (err) {
      if (err.code === 'P2002') return sendRequest(meId, otherId); // created in between
      throw err;
    }
  }
  await notifyRequest(other, me, await nameOf(me));
  return { relationship: 'requested' };
}

/** Accepts `otherId`'s pending request to me. Returns { relationship }. */
export async function acceptRequest(meId, otherId) {
  const { me, other } = await loadPair(meId, otherId);
  const now = new Date();
  const { count } = await prisma.friendships.updateMany({
    where: { ...pairKey(me, other), status: 'PENDING', requested_by: other },
    data:  { status: 'ACCEPTED', accepted_at: now, updated_at: now },
  });
  if (count === 0) {
    const row = await findPair(prisma, me, other);
    if (row?.status === 'ACCEPTED') return { relationship: 'friends' };
    throw new Error('NO_PENDING_REQUEST');
  }
  await notifyAccepted(other, me, await nameOf(me));
  return { relationship: 'friends' };
}

/** Turns down `otherId`'s request to me. Silent. */
export async function declineRequest(meId, otherId) {
  const me = toBig(meId);
  if (!/^\d+$/.test(String(otherId ?? ''))) throw new Error('NO_PENDING_REQUEST');
  const other = toBig(otherId);
  const { count } = await prisma.friendships.updateMany({
    where: { ...pairKey(me, other), status: 'PENDING', requested_by: other },
    data:  { status: 'DECLINED', updated_at: new Date() },
  });
  if (count === 0) throw new Error('NO_PENDING_REQUEST');
  return { relationship: 'none' };
}

/** Withdraws my pending request to `otherId`. Silent. */
export async function cancelRequest(meId, otherId) {
  const me = toBig(meId);
  if (!/^\d+$/.test(String(otherId ?? ''))) throw new Error('NO_PENDING_REQUEST');
  await prisma.friendships.deleteMany({
    where: { ...pairKey(me, toBig(otherId)), status: 'PENDING', requested_by: me },
  });
  return { relationship: 'none' };
}

/** Ends a friendship (either side). Silent. */
export async function removeFriend(meId, otherId) {
  const me = toBig(meId);
  if (!/^\d+$/.test(String(otherId ?? ''))) throw new Error('USER_NOT_FOUND');
  if (toBig(otherId) === me) throw new Error('CANNOT_FRIEND_SELF');
  await prisma.friendships.deleteMany({ where: { ...pairKey(me, toBig(otherId)), status: 'ACCEPTED' } });
  return { relationship: 'none' };
}

/**
 * An existing hunter opened `code`'s invite link and tapped Add friend:
 * friends straight away (sharing the link was the invitation).
 */
export async function addByInviteLink(meId, code) {
  const card = await getCard(meId, { code });
  if (card.relationship === 'self') throw new Error('CANNOT_FRIEND_SELF');
  if (card.relationship === 'blocked') throw new Error('USER_BLOCKED');
  if (card.relationship === 'friends') return { relationship: 'friends', userId: card.userId };

  const me = toBig(meId);
  const other = BigInt(card.userId);
  const now = new Date();
  const key = pairKey(me, other);
  await prisma.friendships.upsert({
    where:  { user_low_user_high: key },
    create: { ...key, requested_by: me, status: 'ACCEPTED', source: 'LINK', accepted_at: now },
    update: { status: 'ACCEPTED', source: 'LINK', accepted_at: now, updated_at: now },
  });
  await notifyAccepted(other, me, await nameOf(me), true);
  return { relationship: 'friends', userId: card.userId };
}

/** Blocks `otherId`: no friendship or requests either way until unblocked. */
export async function blockUser(meId, otherId) {
  const me = toBig(meId);
  if (!/^\d+$/.test(String(otherId ?? ''))) throw new Error('USER_NOT_FOUND');
  const other = toBig(otherId);
  if (other === me) throw new Error('CANNOT_FRIEND_SELF');
  const exists = await prisma.users.findUnique({ where: { id: other }, select: { id: true } });
  if (!exists) throw new Error('USER_NOT_FOUND');
  await prisma.$transaction([
    prisma.friendships.deleteMany({ where: pairKey(me, other) }),
    prisma.user_blocks.upsert({
      where:  { blocker_id_blocked_id: { blocker_id: me, blocked_id: other } },
      create: { blocker_id: me, blocked_id: other },
      update: {},
    }),
  ]);
  return { relationship: 'blocked' };
}

export async function unblockUser(meId, otherId) {
  const me = toBig(meId);
  if (!/^\d+$/.test(String(otherId ?? ''))) throw new Error('USER_NOT_FOUND');
  await prisma.user_blocks.deleteMany({ where: { blocker_id: me, blocked_id: toBig(otherId) } });
  return { relationship: 'none' };
}

/**
 * Requests waiting for me, newest first, with each sender's card. Senders
 * who've since been banned, scheduled for deletion or blocked are left out.
 */
export async function listIncomingRequests(meId) {
  const me = toBig(meId);
  const rows = await prisma.friendships.findMany({
    where:   { status: 'PENDING', requested_by: { not: me }, OR: [{ user_low: me }, { user_high: me }] },
    orderBy: { created_at: 'desc' },
    take:    100,
  });
  if (rows.length === 0) return { requests: [], count: 0 };

  const senderIds = rows.map((r) => r.requested_by);
  const [users, blocks] = await Promise.all([
    prisma.users.findMany({ where: { id: { in: senderIds } }, select: PROFILE_SELECT }),
    prisma.user_blocks.findMany({
      where:  { OR: [{ blocker_id: me, blocked_id: { in: senderIds } }, { blocked_id: me, blocker_id: { in: senderIds } }] },
      select: { blocker_id: true, blocked_id: true },
    }),
  ]);
  const blocked = new Set(blocks.map((b) => (b.blocker_id === me ? b.blocked_id : b.blocker_id).toString()));
  const byId = new Map(users.map((u) => [u.id.toString(), u]));

  const requests = rows
    .map((r) => ({ row: r, user: byId.get(r.requested_by.toString()) }))
    .filter(({ user }) => isActiveHunter(user) && !blocked.has(user.id.toString()))
    .map(({ row, user }) => ({ ...toCard(user, 'incoming', row), requestedAt: row.created_at }));
  return { requests, count: requests.length };
}
