// src/services/leaderboardService.js — Leaderboard feature: Redis-backed
// global/genz ranking, Postgres-backed friends ranking, and the
// Postgres-down fallback path for global/genz.
//
// Postgres (user_progression.total_xp) is the source of truth. Redis
// sorted sets (lb:global / lb:genz) are a live index kept in sync by
// syncLeaderboardMember(), called after any DB transaction that changes
// a field this ranking depends on. Nothing here ever lets a Redis
// problem fail the caller — see syncLeaderboardMember's try/catch.

import prisma from '../config/prisma.js';
import redis, { isRedisUp } from '../config/redis.js';
import { logError, info } from '../utils/logger.js';
import {
  XP_SHIFT,
  GENZ_BIRTH_YEAR_START,
  GENZ_BIRTH_YEAR_END,
  FRIENDS_REFERRAL_CAP,
  REDIS_KEYS,
  DISPLAY_HASH_TTL_SECONDS,
} from '../config/leaderboardConfig.js';

// ─────────────────────────────────────────────────────────────
// Score packing — see leaderboardConfig.js for the bit-width math.
// ─────────────────────────────────────────────────────────────

export function encodeScore(totalXp, userId) {
  const uid = Number(userId);
  return totalXp * XP_SHIFT + (XP_SHIFT - 1 - uid);
}

export function decodeXpFromScore(score) {
  return Math.floor(Number(score) / XP_SHIFT);
}

// ─────────────────────────────────────────────────────────────
// Levels cache — 100 rows, loaded at startup, refreshed on demand.
// Level/rank are derived from xp on read, never stored per user.
// ─────────────────────────────────────────────────────────────

let levelsCache = [];

export async function loadLevelsCache() {
  const levels = await prisma.levels.findMany({
    orderBy: { level_number: 'asc' },
    select: { level_number: true, xp_required: true, rank_name: true },
  });
  levelsCache = levels;
  info(`Leaderboard levels cache loaded: ${levels.length} levels`);
}

export function getLevelInfo(xp) {
  if (levelsCache.length === 0) return { level: 1, rankName: null };
  let result = levelsCache[0];
  for (const lvl of levelsCache) {
    if (lvl.xp_required <= xp) result = lvl;
    else break;
  }
  return { level: result.level_number, rankName: result.rank_name ?? null };
}

// ─────────────────────────────────────────────────────────────
// Avatar thumbnails — for Cloudinary URLs only, insert a 96x96 fill
// transform right after "/upload/", keeping any existing f_auto,q_auto
// segment untouched.
// ─────────────────────────────────────────────────────────────

export function buildAvatarThumbUrl(imageUrl) {
  if (!imageUrl) return null;
  if (!imageUrl.includes('res.cloudinary.com') || !imageUrl.includes('/upload/')) {
    return imageUrl;
  }
  return imageUrl.replace('/upload/', '/upload/w_96,h_96,c_fill/');
}

// ─────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────

function isGenzDob(dob) {
  if (!dob) return false;
  const year = dob.getUTCFullYear();
  return year >= GENZ_BIRTH_YEAR_START && year <= GENZ_BIRTH_YEAR_END;
}

function computeEligibility({ onboarding_done, is_banned, role, leaderboard_visible, total_xp, date_of_birth }) {
  const global = Boolean(onboarding_done) && !is_banned && role === 'USER' && Boolean(leaderboard_visible) && total_xp > 0;
  const genz = global && isGenzDob(date_of_birth);
  return { global, genz };
}

async function loadFullMemberRow(bUserId) {
  return prisma.users.findUnique({
    where: { id: bUserId },
    select: {
      id: true,
      name: true,
      onboarding_done: true,
      is_banned: true,
      role: true,
      date_of_birth: true,
      avatars: { select: { image_url: true } },
      user_settings: { select: { leaderboard_visible: true } },
      user_progression: { select: { total_xp: true } },
    },
  });
}

const KNOWN_VALUE_KEYS = [
  'name', 'onboarding_done', 'is_banned', 'role',
  'date_of_birth', 'leaderboard_visible', 'total_xp',
];

// ─────────────────────────────────────────────────────────────
// syncLeaderboardMember — call after the DB transaction that changed
// the member's eligibility/display data commits. Accepts already-loaded
// values (all of KNOWN_VALUE_KEYS + optional avatarImageUrl) to skip the
// lookup query on hot paths; otherwise does one combined read.
// ─────────────────────────────────────────────────────────────

export async function syncLeaderboardMember(userId, knownValues = {}) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  try {
    const hasAllKnown = KNOWN_VALUE_KEYS.every((k) => knownValues[k] !== undefined);

    let name, avatarImageUrl, eligibility, totalXp;

    if (hasAllKnown) {
      name = knownValues.name;
      avatarImageUrl = knownValues.avatarImageUrl ?? null;
      totalXp = knownValues.total_xp;
      eligibility = computeEligibility(knownValues);
    } else {
      const row = await loadFullMemberRow(bUserId);
      if (!row) {
        await removeLeaderboardMember(bUserId);
        return;
      }
      name = row.name;
      avatarImageUrl = row.avatars?.image_url ?? null;
      totalXp = row.user_progression?.total_xp ?? 0;
      eligibility = computeEligibility({
        onboarding_done: row.onboarding_done,
        is_banned: row.is_banned,
        role: row.role,
        leaderboard_visible: row.user_settings?.leaderboard_visible ?? true,
        total_xp: totalXp,
        date_of_birth: row.date_of_birth,
      });
    }

    if (!isRedisUp()) {
      await markDirty(bUserId);
      return;
    }

    const score = encodeScore(totalXp, bUserId);
    const member = bUserId.toString();
    const thumbUrl = buildAvatarThumbUrl(avatarImageUrl) ?? '';

    const pipeline = redis.pipeline();
    if (eligibility.global) pipeline.zadd(REDIS_KEYS.global, score, member);
    else pipeline.zrem(REDIS_KEYS.global, member);

    if (eligibility.genz) pipeline.zadd(REDIS_KEYS.genz, score, member);
    else pipeline.zrem(REDIS_KEYS.genz, member);

    pipeline.hset(REDIS_KEYS.userHash(member), { name: name ?? '', avatarThumbUrl: thumbUrl });
    pipeline.expire(REDIS_KEYS.userHash(member), DISPLAY_HASH_TTL_SECONDS);

    await pipeline.exec();
  } catch (err) {
    logError(`syncLeaderboardMember failed for user ${userId}: ${err.message}`);
    await markDirty(bUserId);
  }
}

export async function removeLeaderboardMember(userId) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const member = bUserId.toString();

  if (!isRedisUp()) {
    await markDirty(bUserId);
    return;
  }

  try {
    const pipeline = redis.pipeline();
    pipeline.zrem(REDIS_KEYS.global, member);
    pipeline.zrem(REDIS_KEYS.genz, member);
    pipeline.del(REDIS_KEYS.userHash(member));
    await pipeline.exec();
  } catch (err) {
    logError(`removeLeaderboardMember failed for user ${userId}: ${err.message}`);
    await markDirty(bUserId);
  }
}

async function markDirty(bUserId) {
  if (!redis) return;
  try {
    await redis.sadd(REDIS_KEYS.dirty, bUserId.toString());
  } catch (err) {
    logError(`Failed to mark leaderboard-dirty for user ${bUserId}: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Cursor encode/decode — opaque to the client, carries the resume point
// plus which path minted it ('rd' = redis score, 'pg' = postgres
// keyset+offset, 'friends' = postgres offset). A cursor whose mode
// doesn't match the path about to serve the request is rejected rather
// than silently restarted, so a client never gets duplicate/missing
// rows without knowing about it.
// ─────────────────────────────────────────────────────────────

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeCursor(str) {
  try {
    const obj = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (!obj || typeof obj !== 'object') return undefined;
    return obj;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

export async function getLeaderboard({ meId, meSnapshot, scope, cursorStr, limit }) {
  if (scope === 'friends') {
    return getFriendsLeaderboard({ meId, meSnapshot, cursorStr, limit });
  }

  if (isRedisUp()) {
    try {
      return await getRedisLeaderboard({ meId, meSnapshot, scope, cursorStr, limit });
    } catch (err) {
      logError(`Leaderboard scope=${scope} Redis read failed, falling back to Postgres: ${err.message}`);
    }
  } else {
    logError(`Leaderboard scope=${scope} served from Postgres fallback — Redis is down`);
  }

  return getPostgresFallbackLeaderboard({ meId, meSnapshot, scope, cursorStr, limit });
}

function meStatusFromSnapshot(meSnapshot) {
  if (!meSnapshot.leaderboardVisible) return 'hidden';
  if (!(meSnapshot.totalXp > 0)) return 'unranked_no_xp';
  return 'unranked_no_xp'; // onboarding/role gap with no XP yet — same empty-state copy applies
}

// ── Redis path (global / genz) ──────────────────────────────

async function getRedisLeaderboard({ meId, meSnapshot, scope, cursorStr, limit }) {
  const key = REDIS_KEYS[scope];
  const meMember = meId.toString();
  const isFirstPage = !cursorStr;

  let cursor = null;
  if (cursorStr) {
    cursor = decodeCursor(cursorStr);
    if (!cursor || cursor.m !== 'rd') {
      const e = new Error('INVALID_CURSOR');
      throw e;
    }
  }

  let rawPairs;
  let me = null;

  if (isFirstPage) {
    const pipeline = redis.pipeline();
    pipeline.zrevrange(key, 0, limit, 'WITHSCORES');
    pipeline.zscore(key, meMember);
    pipeline.zrevrank(key, meMember);
    pipeline.zcard(key);
    const results = await pipeline.exec();
    for (const [err] of results) if (err) throw err;

    rawPairs = results[0][1];
    const [, meScoreRaw] = results[1];
    const [, meRankRaw] = results[2];
    const [, totalRankedRaw] = results[3];
    const totalRanked = Number(totalRankedRaw) || 0;

    if (meScoreRaw != null) {
      const totalXp = decodeXpFromScore(meScoreRaw);
      const rank = Number(meRankRaw) + 1;
      const { level, rankName } = getLevelInfo(totalXp);
      const topPercent = totalRanked > 0 ? Math.max(1, Math.ceil((rank / totalRanked) * 100)) : null;
      me = {
        status: 'ranked', rank, totalXp, level, rankName,
        name: meSnapshot.name, avatarThumbUrl: meSnapshot.avatarThumbUrl,
        totalRanked, topPercent,
      };
    } else {
      const { level, rankName } = getLevelInfo(meSnapshot.totalXp);
      me = {
        status: meStatusFromSnapshot(meSnapshot), rank: null, totalXp: meSnapshot.totalXp,
        level, rankName, name: meSnapshot.name, avatarThumbUrl: meSnapshot.avatarThumbUrl,
        totalRanked, topPercent: null,
      };
    }
  } else {
    rawPairs = await redis.zrevrangebyscore(key, `(${cursor.s}`, '-inf', 'WITHSCORES', 'LIMIT', 0, limit + 1);
  }

  const pairs = [];
  for (let i = 0; i < rawPairs.length; i += 2) pairs.push([rawPairs[i], Number(rawPairs[i + 1])]);

  const hasMore = pairs.length > limit;
  const page = pairs.slice(0, limit);

  let firstRank = null;
  if (!isFirstPage && page.length > 0) {
    const rankRaw = await redis.zrevrank(key, page[0][0]);
    firstRank = rankRaw != null ? Number(rankRaw) + 1 : null;
  }

  const entries = await attachDisplayData(
    page.map(([member, score], i) => ({
      userId: member,
      totalXp: decodeXpFromScore(score),
      rank: isFirstPage ? i + 1 : (firstRank != null ? firstRank + i : null),
      isMe: member === meMember,
    }))
  );

  const nextCursor = hasMore ? encodeCursor({ m: 'rd', s: page[page.length - 1][1] }) : null;
  const emptyState = isFirstPage && entries.length === 0 ? 'no_entries' : null;

  return { entries, me, nextCursor, emptyState };
}

async function attachDisplayData(rows) {
  if (rows.length === 0) return [];

  const pipeline = redis.pipeline();
  for (const row of rows) pipeline.hgetall(REDIS_KEYS.userHash(row.userId));
  const results = await pipeline.exec();

  const missingIds = [];
  const hashByUserId = new Map();
  rows.forEach((row, i) => {
    const [err, hash] = results[i];
    if (!err && hash && hash.name !== undefined) {
      hashByUserId.set(row.userId, hash);
    } else {
      missingIds.push(row.userId);
    }
  });

  if (missingIds.length > 0) {
    const dbRows = await prisma.users.findMany({
      where: { id: { in: missingIds.map((id) => BigInt(id)) } },
      select: { id: true, name: true, avatars: { select: { image_url: true } } },
    });

    const writeback = redis.pipeline();
    for (const dbRow of dbRows) {
      const id = dbRow.id.toString();
      const thumbUrl = buildAvatarThumbUrl(dbRow.avatars?.image_url) ?? '';
      const hash = { name: dbRow.name ?? '', avatarThumbUrl: thumbUrl };
      hashByUserId.set(id, hash);
      writeback.hset(REDIS_KEYS.userHash(id), hash);
      writeback.expire(REDIS_KEYS.userHash(id), DISPLAY_HASH_TTL_SECONDS);
    }
    await writeback.exec().catch((err) => logError(`Leaderboard display-hash writeback failed: ${err.message}`));
  }

  return rows.map((row) => {
    const hash = hashByUserId.get(row.userId);
    const { level, rankName } = getLevelInfo(row.totalXp);
    return {
      rank: row.rank,
      userId: row.userId,
      name: hash?.name ?? '',
      avatarThumbUrl: hash?.avatarThumbUrl || null,
      level, rankName,
      totalXp: row.totalXp,
      isMe: row.isMe,
    };
  });
}

// ── Postgres fallback path (global / genz, Redis down) ──────
// Offset-based keyset pagination carried entirely through the cursor —
// no COUNT(*), no OFFSET clause; rank numbers are computed from the
// carried offset, not from a global count.

// user_settings rows are created lazily (first GET/PATCH of Settings —
// see userSettingsService.js), so "visible" must mean "no settings row
// (default true) OR a settings row that isn't explicitly false" — never
// "a settings row exists and is true", which would wrongly exclude
// every user who's never opened Settings.
export const VISIBLE_FILTER = { user_settings: { isNot: { leaderboard_visible: false } } };

export function eligibilityWhere(scope) {
  const where = {
    onboarding_done: true,
    is_banned: false,
    role: 'USER',
    ...VISIBLE_FILTER,
    user_progression: { total_xp: { gt: 0 } },
  };
  if (scope === 'genz') {
    where.date_of_birth = {
      gte: new Date(Date.UTC(GENZ_BIRTH_YEAR_START, 0, 1)),
      lte: new Date(Date.UTC(GENZ_BIRTH_YEAR_END, 11, 31, 23, 59, 59, 999)),
    };
  }
  return where;
}

async function getPostgresFallbackLeaderboard({ meId, meSnapshot, scope, cursorStr, limit }) {
  let cursor = null;
  let offset = 0;
  if (cursorStr) {
    cursor = decodeCursor(cursorStr);
    if (!cursor || cursor.m !== 'pg') throw new Error('INVALID_CURSOR');
    offset = cursor.offset;
  }

  const where = eligibilityWhere(scope);
  if (cursor) {
    where.OR = [
      { user_progression: { total_xp: { lt: cursor.xp } } },
      { AND: [{ user_progression: { total_xp: cursor.xp } }, { id: { gt: BigInt(cursor.id) } }] },
    ];
  }

  const rows = await prisma.users.findMany({
    where,
    orderBy: [{ user_progression: { total_xp: 'desc' } }, { id: 'asc' }],
    take: limit + 1,
    select: {
      id: true, name: true,
      avatars: { select: { image_url: true } },
      user_progression: { select: { total_xp: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const entries = page.map((r, i) => {
    const totalXp = r.user_progression?.total_xp ?? 0;
    const { level, rankName } = getLevelInfo(totalXp);
    return {
      rank: offset + i + 1,
      userId: r.id.toString(),
      name: r.name,
      avatarThumbUrl: buildAvatarThumbUrl(r.avatars?.image_url),
      level, rankName, totalXp,
      isMe: r.id === meId,
    };
  });

  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ m: 'pg', offset: offset + limit, xp: last.user_progression?.total_xp ?? 0, id: last.id.toString() })
    : null;

  let me = null;
  if (!cursorStr) {
    const { level, rankName } = getLevelInfo(meSnapshot.totalXp);
    me = {
      status: meSnapshot.leaderboardVisible && meSnapshot.totalXp > 0 ? 'ranked' : meStatusFromSnapshot(meSnapshot),
      rank: null, // never computed via a full-table count in fallback mode
      totalXp: meSnapshot.totalXp, level, rankName,
      name: meSnapshot.name, avatarThumbUrl: meSnapshot.avatarThumbUrl,
      totalRanked: null, topPercent: null,
    };
  }

  const emptyState = !cursorStr && entries.length === 0 ? 'no_entries' : null;

  return { entries, me, nextCursor, emptyState };
}

// ── Friends scope (always Postgres) ─────────────────────────

async function getFriendsLeaderboard({ meId, meSnapshot, cursorStr, limit }) {
  let offset = 0;
  if (cursorStr) {
    const cursor = decodeCursor(cursorStr);
    if (!cursor || cursor.m !== 'friends') throw new Error('INVALID_CURSOR');
    offset = cursor.offset;
  }

  const [meRow, referredRows] = await Promise.all([
    prisma.users.findUnique({
      where: { id: meId },
      select: { id: true, referred_by: true },
    }),
    prisma.referrals.findMany({
      where: { referrer_id: meId },
      orderBy: { created_at: 'desc' },
      take: FRIENDS_REFERRAL_CAP,
      select: { referred_id: true },
    }),
  ]);

  const friendIds = new Set([meId]);
  if (meRow?.referred_by) friendIds.add(meRow.referred_by);
  for (const r of referredRows) friendIds.add(r.referred_id);

  const visibilityFilter = { OR: [{ id: meId }, { is_banned: false, ...VISIBLE_FILTER }] };

  if (!cursorStr) {
    const totalRanked = await prisma.users.count({
      where: { id: { in: [...friendIds] }, ...visibilityFilter },
    });

    if (totalRanked <= 1) {
      const meFull = await loadSelfForFriends(meId);
      return {
        entries: [meFull],
        me: friendsMeBlock(meFull, 1, 1),
        nextCursor: null,
        emptyState: 'no_friends',
      };
    }

    const rows = await prisma.users.findMany({
      where: { id: { in: [...friendIds] }, ...visibilityFilter },
      orderBy: [{ user_progression: { total_xp: 'desc' } }, { id: 'asc' }],
      take: limit + 1,
      select: { id: true, name: true, avatars: { select: { image_url: true } }, user_progression: { select: { total_xp: true } } },
    });

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const entries = page.map((r, i) => friendEntry(r, offset + i + 1, meId));
    const nextCursor = hasMore ? encodeCursor({ m: 'friends', offset: offset + limit }) : null;

    const meEntry = entries.find((e) => e.isMe) ?? await computeMyFriendRank(meId, friendIds, visibilityFilter);
    return { entries, me: friendsMeBlock(meEntry, meEntry.rank, totalRanked), nextCursor, emptyState: null };
  }

  // Subsequent pages — no 'me' block, no total-count recompute.
  const rows = await prisma.users.findMany({
    where: { id: { in: [...friendIds] }, ...visibilityFilter },
    orderBy: [{ user_progression: { total_xp: 'desc' } }, { id: 'asc' }],
    skip: offset,
    take: limit + 1,
    select: { id: true, name: true, avatars: { select: { image_url: true } }, user_progression: { select: { total_xp: true } } },
  });

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const entries = page.map((r, i) => friendEntry(r, offset + i + 1, meId));
  const nextCursor = hasMore ? encodeCursor({ m: 'friends', offset: offset + limit }) : null;

  return { entries, me: null, nextCursor, emptyState: null };
}

function friendEntry(r, rank, meId) {
  const totalXp = r.user_progression?.total_xp ?? 0;
  const { level, rankName } = getLevelInfo(totalXp);
  return {
    rank,
    userId: r.id.toString(),
    name: r.name,
    avatarThumbUrl: buildAvatarThumbUrl(r.avatars?.image_url),
    level, rankName, totalXp,
    isMe: r.id === meId,
  };
}

function friendsMeBlock(meEntry, rank, totalRanked) {
  const topPercent = totalRanked == null || totalRanked <= 0
    ? null
    : Math.max(1, Math.ceil((rank / totalRanked) * 100));
  return {
    status: 'ranked',
    rank,
    totalXp: meEntry.totalXp,
    level: meEntry.level,
    rankName: meEntry.rankName,
    name: meEntry.name,
    avatarThumbUrl: meEntry.avatarThumbUrl,
    totalRanked: totalRanked ?? null,
    topPercent,
  };
}

async function loadSelfForFriends(meId) {
  const r = await prisma.users.findUnique({
    where: { id: meId },
    select: { id: true, name: true, avatars: { select: { image_url: true } }, user_progression: { select: { total_xp: true } } },
  });
  return friendEntry(r, 1, meId);
}

// Used only when the caller's own row didn't land on page 1 of the
// friends list (rare — most users have far fewer than `limit` friends).
async function computeMyFriendRank(meId, friendIds, visibilityFilter) {
  const meFull = await loadSelfForFriends(meId);
  const higherCount = await prisma.users.count({
    where: {
      id: { in: [...friendIds].filter((id) => id !== meId) },
      AND: [
        visibilityFilter,
        {
          OR: [
            { user_progression: { total_xp: { gt: meFull.totalXp } } },
            { AND: [{ user_progression: { total_xp: meFull.totalXp } }, { id: { lt: meId } }] },
          ],
        },
      ],
    },
  });
  return { ...meFull, rank: higherCount + 1 };
}
