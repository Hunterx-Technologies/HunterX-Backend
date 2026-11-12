// src/services/referralService.js — Referral codes, attribution only.
//
// A referral records who invited whom (users.referred_by + a referrals
// row) for the Friends leaderboard and the inviter's invite count. It
// never pays out anything — no XP, scratch card, coupon or other reward
// for either side.

import prisma from '../config/prisma.js';
import { normalizeReferralCode } from '../utils/helpers.js';
import { buildAvatarThumbUrl, getLevelInfo } from './leaderboardService.js';
import { linkInvitePair } from './friendService.js';

// The account a code belongs to, if it can still refer anyone. Banned
// accounts can't; deleted accounts are gone, so their codes don't resolve.
// `client` may be a transaction client.
export async function findActiveReferrer(rawCode, client = prisma) {
  const code = normalizeReferralCode(rawCode);
  if (!code) return null;

  const user = await client.users.findUnique({
    where:  { referral_code: code },
    select: { id: true, name: true, is_banned: true, delete_at: true },
  });
  // A code whose owner is banned, or waiting to be deleted, attributes no one.
  if (!user || user.is_banned || user.delete_at) return null;
  return user;
}

// Every lookup takes at least this long, so response time doesn't reveal
// whether a code exists (or was rejected before reaching the database).
const LOOKUP_MIN_MS = 300;

// Backs GET /api/public/referral/:code — exposes only the display name.
export async function lookupReferralCode(rawCode) {
  const startedAt = Date.now();
  let result = { valid: false };
  try {
    const referrer = await findActiveReferrer(rawCode);
    if (referrer) result = { valid: true, inviterName: referrer.name?.trim() || 'A hunter' };
  } finally {
    const remaining = LOOKUP_MIN_MS - (Date.now() - startedAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
  return result;
}

// Invited hunters whose account is waiting to be deleted are left out of
// the list and the count until they keep it.
const INVITEE_ACTIVE = { users_referrals_referred_idTousers: { delete_at: null } };

// Hunters who signed up with this user's code (display only).
export function countAcceptedInvites(userId, client = prisma) {
  return client.referrals.count({ where: { referrer_id: userId, ...INVITEE_ACTIVE } });
}

// Most recent first; the invite screen shows at most this many rows (the
// count still covers everyone).
const INVITED_LIST_LIMIT = 200;

// Backs GET /api/referrals/invited — the hunters who joined with this
// user's code. Hunters who turned leaderboard visibility off come back as
// { id, visible: false } with nothing else. Never exposes an email or
// Hunter ID.
export async function listInvitedFriends(userId) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const [count, rows] = await Promise.all([
    countAcceptedInvites(bUserId),
    prisma.referrals.findMany({
      where:   { referrer_id: bUserId, ...INVITEE_ACTIVE },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take:    INVITED_LIST_LIMIT,
      select: {
        users_referrals_referred_idTousers: {
          select: {
            id:               true,
            name:             true,
            avatars:          { select: { image_url: true } },
            user_progression: { select: { total_xp: true } },
            user_settings:    { select: { leaderboard_visible: true } },
          },
        },
      },
    }),
  ]);

  const friends = rows.map(({ users_referrals_referred_idTousers: u }) => {
    // No settings row yet means the default, which is visible.
    if (u.user_settings?.leaderboard_visible === false) {
      return { id: u.id.toString(), visible: false };
    }
    const { level, rankName } = getLevelInfo(u.user_progression?.total_xp ?? 0);
    return {
      id:        u.id.toString(),
      visible:   true,
      name:      u.name?.trim() || 'A hunter',
      avatarUrl: buildAvatarThumbUrl(u.avatars?.image_url),
      rankName,
      level,
    };
  });

  return { count, friends };
}

// Attaches a referrer to an account created before the hunter could enter
// a code (Google/Apple from the Login screen, then the onboarding wizard).
// Only while onboarding isn't done and nobody referred them yet; unknown,
// banned and self codes are ignored. Attribution only, like sign-up.
export async function attachLateReferral(userId, rawCode) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const referrer = await findActiveReferrer(rawCode);
  if (!referrer || referrer.id === bUserId) return false;

  return prisma.$transaction(async (tx) => {
    // Re-checked inside the transaction so two requests can't both attach.
    const claimed = await tx.users.updateMany({
      where: { id: bUserId, referred_by: null, onboarding_done: false },
      data:  { referred_by: referrer.id },
    });
    if (claimed.count === 0) return false;
    await tx.referrals.create({ data: { referrer_id: referrer.id, referred_id: bUserId } });
    await linkInvitePair(tx, referrer.id, bUserId);
    return true;
  });
}
