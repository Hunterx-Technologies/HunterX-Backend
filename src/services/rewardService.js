// src/services/rewardService.js — Streak-milestone badges + scratch cards
//
// Grants the permanent badge tied to a streak_milestones row once a
// streak hits that day count. Called only from
// streakService.js#bumpDailyStreak, inside its transaction. No XP is
// ever paid here — streak_milestones.xp_bonus is seeded 0 for every row
// and deliberately unread by this file; XP only ever comes from
// taskService.js/xpService.js on task completion. Idempotent per
// (user, milestone) via user_streak_milestones' unique constraint.
//
// ── Scratch cards ───────────────────────────────────────────────
// Granted by a reward_triggers row: a streak of N days
// (streakService.js#bumpDailyStreak), reaching level N
// (xpService.js#checkLevelUp), the user's birthday (nightly cron,
// grantBirthdayCards), or completing a task with a special reward linked
// (taskService.js → grantTaskSpecialCard). A trigger with at least one active reward_coupons
// row grants a scratch card. The prize is picked right then, by weight, among the
// active, in-window, in-stock coupons (pickCoupon) and snapshotted onto
// the card; stock is claimed with a conditional UPDATE so it can never
// be over-awarded. If nothing is in stock the card is still granted
// without a prize and picks again when scratched. The prize never leaves
// the server until POST /rewards/:id/scratch (scratchReward) — pushes,
// the completion response and the unseen list carry the card only.

import crypto from 'crypto';
import prisma from '../config/prisma.js';
import { createNotification } from './notificationService.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { logError } from '../utils/logger.js';

export const STREAK_MILESTONE_BADGES = {
  7:   { name: 'Ember Vow',          description: 'Reached a 7-day daily streak' },
  14:  { name: 'Iron Resolve',       description: 'Reached a 14-day daily streak' },
  30:  { name: 'Shadow Oath',        description: 'Reached a 30-day daily streak' },
  60:  { name: 'Phantom Discipline', description: 'Reached a 60-day daily streak' },
  90:  { name: 'Sovereign Will',     description: 'Reached a 90-day daily streak' },
  200: { name: 'Void Ascendant',     description: 'Reached a 200-day daily streak' },
  365: { name: 'Eternal Hunter',     description: 'Reached a 365-day daily streak' },
};

// opts.lifeEarned — a streak life was banked by the same completion; it's
// mentioned in this push rather than sent as a second one.
export async function checkAndAwardStreakMilestoneBadge(tx, userId, streakDays, { lifeEarned = false } = {}) {
  const badgeInfo = STREAK_MILESTONE_BADGES[streakDays];
  if (!badgeInfo) return { granted: false };

  // Find or create the badge row in badges table if missing
  let badge = await tx.badges.findUnique({
    where: { name: badgeInfo.name },
  });

  if (!badge) {
    badge = await tx.badges.create({
      data: {
        name:        badgeInfo.name,
        description: badgeInfo.description,
        badge_type:  'STREAK',
      },
    });
  }

  // Idempotency check — check if badge already earned in user_badges
  const existingUserBadge = await tx.user_badges.findUnique({
    where: {
      user_id_badge_id: {
        user_id:  userId,
        badge_id: badge.id,
      },
    },
  });

  if (existingUserBadge) {
    return { granted: false, badge };
  }

  // Insert permanent record in user_badges
  await tx.user_badges.create({
    data: {
      user_id:  userId,
      badge_id: badge.id,
      earned_at: new Date(),
    },
  });

  // Also record in user_streak_milestones if milestone exists
  const milestone = await tx.streak_milestones.findUnique({ where: { streak_days: streakDays } });
  if (milestone) {
    const alreadyInUserMilestones = await tx.user_streak_milestones.findUnique({
      where: { user_id_milestone_id: { user_id: userId, milestone_id: milestone.id } },
    });
    if (!alreadyInUserMilestones) {
      await tx.user_streak_milestones.create({
        data: {
          user_id:      userId,
          milestone_id: milestone.id,
          streak_days:  streakDays,
        },
      });
    }
  }

  // Fire STREAK_MILESTONE notification
  await createNotification(
    tx, userId, 'STREAK_MILESTONE',
    `${streakDays}-day streak!`,
    `${badgeInfo.description || `You've hit a ${streakDays}-day streak.`}${lifeEarned ? ' +1 streak life earned.' : ''}`,
    { event: 'STREAK_MILESTONE', streak_days: streakDays, badge_id: badge.id, badge_name: badge.name }
  );

  return { granted: true, badge };
}

// ── Streak badge unlock popup (GET /api/users/me/streak-badges) ──
// Earned streak badges the app hasn't shown yet, oldest first. The home
// screen shows each one (crack the seal, then Continue) and marks it seen,
// so a popup cut short by closing the app comes back on any device.

const STREAK_DAYS_BY_BADGE_NAME = Object.fromEntries(
  Object.entries(STREAK_MILESTONE_BADGES).map(([days, b]) => [b.name, Number(days)])
);

export async function listUnseenStreakBadges(userId) {
  const rows = await prisma.user_badges.findMany({
    where:   { user_id: BigInt(userId), seen_at: null, badges: { badge_type: 'STREAK' } },
    include: { badges: { select: { id: true, name: true, description: true } } },
    orderBy: { id: 'asc' },
    take:    10,
  });
  return {
    badges: rows
      .filter((r) => STREAK_DAYS_BY_BADGE_NAME[r.badges.name])
      .map((r) => ({
        id:          String(r.id),
        badge_id:    String(r.badges.id),
        name:        r.badges.name,
        description: r.badges.description,
        streak_days: STREAK_DAYS_BY_BADGE_NAME[r.badges.name],
        earned_at:   r.earned_at,
      })),
  };
}

export async function markStreakBadgesSeen(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || !ids.every((id) => /^\d+$/.test(String(id)))) {
    throw new Error('INVALID_IDS');
  }
  const { count } = await prisma.user_badges.updateMany({
    where: { user_id: BigInt(userId), id: { in: ids.map((id) => BigInt(id)) }, seen_at: null },
    data:  { seen_at: new Date() },
  });
  return { marked: count };
}

// Milestones with a permanent badge go through the badge path above. Any
// other streak_milestones row has no badge — it's recorded and announced
// here instead. (Scratch cards come from reward_triggers, not from here.)
export async function grantStreakMilestoneReward(tx, userId, milestone, opts = {}) {
  if (STREAK_MILESTONE_BADGES[milestone.streak_days]) {
    return await checkAndAwardStreakMilestoneBadge(tx, userId, milestone.streak_days, opts);
  }

  const already = await tx.user_streak_milestones.findUnique({
    where: { user_id_milestone_id: { user_id: userId, milestone_id: milestone.id } },
  });
  if (already) return { granted: false };

  await tx.user_streak_milestones.create({
    data: { user_id: userId, milestone_id: milestone.id, streak_days: milestone.streak_days },
  });

  await createNotification(
    tx, userId, 'STREAK_MILESTONE',
    `${milestone.streak_days}-day streak!`,
    `You've hit a ${milestone.streak_days}-day streak.${opts.lifeEarned ? ' +1 streak life earned.' : ''}`,
    { event: 'STREAK_MILESTONE', streak_days: milestone.streak_days }
  );
  return { granted: true };
}

const TRIGGER_BY_STREAK_DAYS = {
  7: 'STREAK_7', 14: 'STREAK_14', 21: 'STREAK_21',
  30: 'STREAK_30', 60: 'STREAK_60', 90: 'STREAK_90',
};

// Card rarity follows the trigger, never the prize — showing it before
// the scratch must not hint at which coupon is underneath.
export function triggerRarity(kind, value) {
  if (kind === 'BIRTHDAY') return 'epic';
  if (kind === 'TASK') return 'legendary'; // special rewards are the premium ones
  const [legendary, epic, rare] = kind === 'LEVEL_UP' ? [50, 25, 10] : [30, 14, 7];
  if (value >= legendary) return 'legendary';
  if (value >= epic)      return 'epic';
  if (value >= rare)      return 'rare';
  return 'common';
}

function couponWindow(now) {
  return {
    is_active: true,
    AND: [
      { OR: [{ valid_from: null },  { valid_from:  { lte: now } }] },
      { OR: [{ valid_until: null }, { valid_until: { gt: now } }] },
    ],
  };
}

// Weighted pick among the trigger's eligible coupons (uniform when every
// weight is the default 1). The conditional UPDATE is what actually claims
// a unit of stock: if another request took the last one between the read
// and the update, that coupon drops out and the pick is redrawn from the
// rest. Returns the claimed coupon, or null when nothing is left.
export async function pickCoupon(tx, triggerId, now = new Date()) {
  const rows = await tx.reward_coupons.findMany({
    where:  { trigger_id: triggerId, ...couponWindow(now) },
    select: { id: true, weight: true, total_quantity: true, awarded_count: true },
  });
  let candidates = rows.filter((c) => c.total_quantity === null || c.awarded_count < c.total_quantity);

  while (candidates.length > 0) {
    const total = candidates.reduce((sum, c) => sum + c.weight, 0);
    let roll = crypto.randomInt(total);
    const chosen = candidates.find((c) => (roll -= c.weight) < 0);

    const claimed = await tx.$executeRaw`
      UPDATE reward_coupons SET awarded_count = awarded_count + 1, updated_at = ${now}
      WHERE id = ${chosen.id} AND is_active = true
        AND (total_quantity IS NULL OR awarded_count < total_quantity)
        AND (valid_until IS NULL OR valid_until > ${now})`;
    if (claimed === 1) return tx.reward_coupons.findUnique({ where: { id: chosen.id } });

    candidates = candidates.filter((c) => c.id !== chosen.id);
  }
  return null;
}

export function formatPrize(discountType, discountValue, currency) {
  const value = Number(discountValue).toString();
  return discountType === 'PERCENT' ? `${value}% OFF` : `${currency ?? ''}${value} OFF`;
}

// The prize fields copied onto a card when its coupon is picked. The card
// expires at whichever comes first: the coupon's own end date, or N days
// after it was won.
export function prizeSnapshot(coupon, now = new Date()) {
  const ends = [
    coupon.valid_until,
    coupon.valid_days_after_award ? new Date(now.getTime() + coupon.valid_days_after_award * 24 * 60 * 60 * 1000) : null,
  ].filter(Boolean);

  return {
    coupon_id:      coupon.id,
    coupon_code:    coupon.coupon_code,
    discount_type:  coupon.discount_type,
    discount_value: coupon.discount_value,
    currency:       coupon.currency,
    reward_text:    formatPrize(coupon.discount_type, coupon.discount_value, coupon.currency),
    expires_at:     ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : null,
  };
}

const REWARD_PUSH_COPY = {
  STREAK:   (t) => ['🎁 Scratch card unlocked', `Your ${t.value}-day streak earned a scratch card. Scratch it to see what you won.`],
  LEVEL_UP: (t) => ['🎁 Scratch card unlocked', `Reaching Level ${t.value} earned you a scratch card. Scratch it to see what you won.`],
  BIRTHDAY: ()  => ['🎂 Happy Birthday, Hunter!', 'Wishing you a legendary year ahead. Your birthday gift is waiting: tap to claim your reward.'],
  TASK:     (t, { taskTitle } = {}) => ['🎁 Special reward unlocked', `Completing ${taskTitle ? `"${taskTitle}"` : 'that quest'} earned you a special scratch card. Scratch it to see what you won.`],
};

function legacyTriggerType(kind, value) {
  if (kind === 'LEVEL_UP') return 'LEVEL_UP';
  if (kind === 'BIRTHDAY') return 'BIRTHDAY';
  if (kind === 'TASK') return 'CAMPAIGN'; // legacy column only; trigger_id says what it really is
  return TRIGGER_BY_STREAK_DAYS[value] ?? 'STREAK_MILESTONE';
}

// Grants the scratch card for one trigger firing, inside the caller's
// transaction. Only triggers an admin has put active coupons under grant
// anything, and only while the trigger is active. Once per (user, trigger, period) — period is 0 for streak and
// level triggers (once ever) and the year for the birthday trigger; the
// partial unique index backs that up. Returns the card, or null.
// opts.taskTitle: for push copy on special (TASK) rewards.
export async function grantTriggerCard(tx, userId, kind, value, { period = 0, now = new Date(), taskTitle = null } = {}) {
  const trigger = await tx.reward_triggers.findUnique({ where: { kind_value: { kind, value } } });
  if (!trigger || !trigger.is_active) return null;

  const configured = await tx.reward_coupons.count({ where: { trigger_id: trigger.id, is_active: true } });
  if (configured === 0) return null;

  const existing = await tx.user_rewards.findFirst({
    where:  { user_id: userId, trigger_id: trigger.id, period },
    select: { id: true },
  });
  if (existing) return null;

  const coupon = await pickCoupon(tx, trigger.id, now);
  const reward = await tx.user_rewards.create({
    data: {
      user_id:      userId,
      trigger_id:   trigger.id,
      period,
      trigger_type: legacyTriggerType(kind, value),
      rarity:       triggerRarity(kind, value),
      status:       'ACTIVE',
      assigned_at:  now,
      ...(coupon ? prizeSnapshot(coupon, now) : {}),
    },
    include: REWARD_INCLUDE,
  });

  const [title, body] = REWARD_PUSH_COPY[kind](trigger, { taskTitle });
  await createNotification(
    tx, userId, 'REWARD_READY', title, body,
    {
      event:          'REWARD_READY',
      reward_id:      String(reward.id),
      user_reward_id: String(reward.id),
      rarity:         reward.rarity,
      trigger_kind:   kind,
      ...(kind === 'STREAK' ? { streak_days: value } : {}),
      ...(kind === 'LEVEL_UP' ? { level: value } : {}),
      ...(kind === 'TASK' ? { task_id: String(period) } : {}),
      url:            `/rewards?focus=${reward.id}`,
    }
  );
  return reward;
}

// The special-reward card for completing `task`, if the task has a special
// reward linked. One per user per task (period = task id), whatever how
// often the task recurs. Inside the completion transaction.
export async function grantTaskSpecialCard(tx, userId, task) {
  if (!task.special_reward_id) return null;
  const trigger = await tx.reward_triggers.findUnique({ where: { id: task.special_reward_id } });
  if (!trigger || trigger.kind !== 'TASK') return null;
  return grantTriggerCard(tx, userId, 'TASK', trigger.value, { period: Number(task.id), taskTitle: task.title });
}

// Birthday rewards wait this long after a date-of-birth change, so editing
// it to today doesn't pay out (authService.js#updateUserProfile stamps
// users.dob_updated_at).
export const BIRTHDAY_DOB_HOLD_DAYS = 30;

// Nightly (src/cron/midnight.js, 00:30 IST): a birthday card for everyone
// whose birthday is `today` (an IST calendar date). Feb 29 birthdays are
// celebrated on Feb 28 in other years. Once per user per year.
export async function grantBirthdayCards(today) {
  const trigger = await prisma.reward_triggers.findUnique({ where: { kind_value: { kind: 'BIRTHDAY', value: 0 } } });
  if (!trigger || !trigger.is_active) return 0;
  const active = await prisma.reward_coupons.count({ where: { trigger_id: trigger.id, is_active: true } });
  if (active === 0) return 0;

  const year  = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day   = today.getUTCDate();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const alsoFeb29 = month === 2 && day === 28 && !isLeap;
  const holdCutoff = new Date(Date.now() - BIRTHDAY_DOB_HOLD_DAYS * 24 * 60 * 60 * 1000);

  const users = await prisma.$queryRaw`
    SELECT id FROM users
    WHERE date_of_birth IS NOT NULL AND is_banned = false
      AND (dob_updated_at IS NULL OR dob_updated_at <= ${holdCutoff})
      AND (
        (EXTRACT(MONTH FROM date_of_birth) = ${month} AND EXTRACT(DAY FROM date_of_birth) = ${day})
        OR (${alsoFeb29} AND EXTRACT(MONTH FROM date_of_birth) = 2 AND EXTRACT(DAY FROM date_of_birth) = 29)
      )`;

  let granted = 0;
  for (const { id } of users) {
    try {
      const reward = await prisma.$transaction((tx) => grantTriggerCard(tx, id, 'BIRTHDAY', 0, { period: year }));
      if (reward) granted += 1;
    } catch (err) {
      // P2002: a concurrent run already granted this year's card.
      if (err.code !== 'P2002') throw err;
    }
  }
  return granted;
}

// Is `dob` celebrated on `today` (IST calendar date)? Same Feb 29 rule as
// grantBirthdayCards.
function isBirthdayOn(dob, today) {
  const month = today.getUTCMonth() + 1;
  const day   = today.getUTCDate();
  const dobMonth = dob.getUTCMonth() + 1;
  const dobDay   = dob.getUTCDate();
  if (dobMonth === month && dobDay === day) return true;
  const year = today.getUTCFullYear();
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return !isLeap && month === 2 && day === 28 && dobMonth === 2 && dobDay === 29;
}

// On-demand birthday card for one user (listUnseenRewards, i.e. login and
// app open). The nightly run only covers users whose birthday coupons were
// already set up at 00:30; this catches a coupon added later that day.
// Same rules: today is their birthday, the DOB hold has passed, once a year.
export async function ensureBirthdayCard(userId) {
  const bUserId = BigInt(userId);
  const user = await prisma.users.findUnique({
    where:  { id: bUserId },
    select: { date_of_birth: true, dob_updated_at: true, is_banned: true },
  });
  if (!user?.date_of_birth || user.is_banned) return null;

  const today = getISTDateOnly();
  if (!isBirthdayOn(user.date_of_birth, today)) return null;
  const holdCutoff = Date.now() - BIRTHDAY_DOB_HOLD_DAYS * 24 * 60 * 60 * 1000;
  if (user.dob_updated_at && user.dob_updated_at.getTime() > holdCutoff) return null;

  try {
    return await prisma.$transaction((tx) => grantTriggerCard(tx, bUserId, 'BIRTHDAY', 0, { period: today.getUTCFullYear() }));
  } catch (err) {
    // P2002: the nightly run or a parallel request granted it first.
    if (err.code === 'P2002') return null;
    throw err;
  }
}

// ── User-facing API (src/routes/rewards.js) ─────────────────────

export const REWARD_INCLUDE = {
  reward_triggers: { select: { kind: true, value: true } },
  reward_coupons:    { select: { title: true, description: true, product_name: true, product_category: true, product_image_url: true } },
  reward_pool:       { select: { description: true, reward_partners: { select: { name: true } } } },
};

const SOURCE_BY_KIND    = { STREAK: 'STREAK_MILESTONE', LEVEL_UP: 'LEVEL_UP', BIRTHDAY: 'BIRTHDAY', TASK: 'TASK_COMPLETE' };
const SOURCE_BY_TRIGGER = { LEVEL_UP: 'LEVEL_UP', BIRTHDAY: 'BIRTHDAY', REFERRAL: 'ADMIN', CAMPAIGN: 'ADMIN' };

// UNSEEN → SEEN → SCRATCHED → USED, or EXPIRED. Expiry is applied on read
// too, so a card past expires_at reads EXPIRED before the nightly job
// (expireRewards) gets to it.
export function apiStatus(r, now = new Date()) {
  if (r.status === 'CLAIMED') return 'USED';
  if (r.status === 'EXPIRED' || (r.expires_at && r.expires_at <= now)) return 'EXPIRED';
  if (r.scratched_at) return 'SCRATCHED';
  if (r.seen_at) return 'SEEN';
  return 'UNSEEN';
}

// Prize fields go out only once the card is SCRATCHED or USED.
export function toApiReward(r, now = new Date()) {
  const status  = apiStatus(r, now);
  const trigger = r.reward_triggers;
  const milestoneDays = trigger
    ? (trigger.kind === 'STREAK' ? trigger.value : null)
    : (r.trigger_type.startsWith('STREAK_') ? Number(r.trigger_type.slice(7)) || null : null);

  const summary = {
    id:             String(r.id),
    type:           'SCRATCH_CARD',
    rarity:         r.rarity,
    source:         trigger ? SOURCE_BY_KIND[trigger.kind] : (SOURCE_BY_TRIGGER[r.trigger_type] ?? 'STREAK_MILESTONE'),
    milestone_days: milestoneDays,
    level:          trigger?.kind === 'LEVEL_UP' ? trigger.value : null,
    status,
    title:          null,
    description:    null,
    granted_at:     r.assigned_at,
    expires_at:     r.expires_at,
  };
  if ((status !== 'SCRATCHED' && status !== 'USED') || !r.coupon_code) return summary;

  const coupon = r.reward_coupons;
  return {
    ...summary,
    discount_type:     r.discount_type,
    discount_value:    r.discount_value === null ? null : Number(r.discount_value),
    currency:          r.currency ?? undefined,
    code:              r.coupon_code,
    reward_text:       r.reward_text ?? undefined,
    product_name:      coupon?.product_name ?? coupon?.title ?? r.reward_pool?.reward_partners?.name ?? undefined,
    product_category:  coupon?.product_category ?? undefined,
    product_image_url: coupon?.product_image_url ?? undefined,
    valid_until:       r.expires_at,
    scratched_at:      r.scratched_at,
    used_at:           r.claimed_at ?? undefined,
  };
}

function parseId(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('REWARD_NOT_FOUND');
  return BigInt(id);
}

const LIST_LIMIT = 20;

function tabWhere(tab, now) {
  if (tab === 'USED') return { status: 'CLAIMED' };
  if (tab === 'EXPIRED') return { OR: [{ status: 'EXPIRED' }, { status: 'ACTIVE', expires_at: { lte: now } }] };
  return { status: 'ACTIVE', OR: [{ expires_at: null }, { expires_at: { gt: now } }] };
}

export const REWARD_TABS = ['ACTIVE', 'USED', 'EXPIRED'];

// Newest first, keyset-paged by id. counts covers all three tabs so the
// wallet can label them without three requests.
export async function listRewards(userId, { tab = 'ACTIVE', cursor } = {}) {
  if (!REWARD_TABS.includes(tab)) throw new Error('INVALID_TAB');
  if (cursor !== undefined && cursor !== '' && !/^\d+$/.test(String(cursor))) throw new Error('INVALID_CURSOR');

  const bUserId = BigInt(userId);
  const now     = new Date();
  const where   = { user_id: bUserId, ...tabWhere(tab, now), ...(cursor ? { id: { lt: BigInt(cursor) } } : {}) };

  const [rows, active, used, expired] = await Promise.all([
    prisma.user_rewards.findMany({ where, include: REWARD_INCLUDE, orderBy: { id: 'desc' }, take: LIST_LIMIT + 1 }),
    prisma.user_rewards.count({ where: { user_id: bUserId, ...tabWhere('ACTIVE', now) } }),
    prisma.user_rewards.count({ where: { user_id: bUserId, ...tabWhere('USED', now) } }),
    prisma.user_rewards.count({ where: { user_id: bUserId, ...tabWhere('EXPIRED', now) } }),
  ]);

  const page = rows.slice(0, LIST_LIMIT);
  return {
    items:       page.map((r) => toApiReward(r, now)),
    next_cursor: rows.length > LIST_LIMIT ? String(page[page.length - 1].id) : null,
    counts:      { active, used, expired },
  };
}

// Cards the user hasn't been shown yet — the app replays these on launch,
// so a celebration interrupted by killing the app isn't lost.
export async function listUnseenRewards(userId) {
  // A birthday card that wasn't granted overnight shows up here on login.
  // Never let it break the listing.
  try {
    await ensureBirthdayCard(userId);
  } catch (err) {
    logError(`Birthday card check failed for user ${userId}: ${err.message}`);
  }

  const now  = new Date();
  const rows = await prisma.user_rewards.findMany({
    where: {
      user_id: BigInt(userId), status: 'ACTIVE', seen_at: null, scratched_at: null,
      OR: [{ expires_at: null }, { expires_at: { gt: now } }],
    },
    include: REWARD_INCLUDE,
    orderBy: { id: 'asc' },
    take:    LIST_LIMIT,
  });
  return { rewards: rows.map((r) => toApiReward(r, now)) };
}

async function loadOwned(client, userId, rewardId) {
  const reward = await client.user_rewards.findFirst({
    where:   { id: rewardId, user_id: BigInt(userId) },
    include: REWARD_INCLUDE,
  });
  if (!reward) throw new Error('REWARD_NOT_FOUND');
  return reward;
}

export async function markRewardSeen(userId, id) {
  const rewardId = parseId(id);
  await prisma.user_rewards.updateMany({
    where: { id: rewardId, user_id: BigInt(userId), seen_at: null },
    data:  { seen_at: new Date() },
  });
  return toApiReward(await loadOwned(prisma, userId, rewardId));
}

// Reveals the card's prize. Idempotent: the row lock serializes repeated
// or concurrent calls, and a card already scratched just returns what it
// holds. Only a card granted while every coupon was out of stock picks
// here; if still nothing is left it stays unscratched (the throw rolls
// back) so the user can try again after a restock.
export async function scratchReward(userId, id) {
  const rewardId = parseId(id);
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT id FROM user_rewards WHERE id = ${rewardId} AND user_id = ${BigInt(userId)} FOR UPDATE`;
    if (locked.length === 0) throw new Error('REWARD_NOT_FOUND');

    const now    = new Date();
    const reward = await loadOwned(tx, userId, rewardId);
    const status = apiStatus(reward, now);
    if (status === 'USED') throw new Error('REWARD_USED');
    if (status === 'EXPIRED') throw new Error('REWARD_EXPIRED');
    if (status === 'SCRATCHED') return toApiReward(reward, now);

    const data = { scratched_at: now, seen_at: reward.seen_at ?? now };
    if (!reward.coupon_code) {
      const coupon = reward.trigger_id ? await pickCoupon(tx, reward.trigger_id, now) : null;
      if (!coupon) throw new Error('NO_COUPON_AVAILABLE');
      Object.assign(data, prizeSnapshot(coupon, now));
    }

    const updated = await tx.user_rewards.update({ where: { id: rewardId }, data, include: REWARD_INCLUDE });
    return toApiReward(updated, now);
  });
}

export async function markRewardUsed(userId, id) {
  const rewardId = parseId(id);
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw`
      SELECT id FROM user_rewards WHERE id = ${rewardId} AND user_id = ${BigInt(userId)} FOR UPDATE`;
    if (locked.length === 0) throw new Error('REWARD_NOT_FOUND');

    const now    = new Date();
    const reward = await loadOwned(tx, userId, rewardId);
    const status = apiStatus(reward, now);
    if (status === 'USED') return toApiReward(reward, now);
    if (status === 'EXPIRED') throw new Error('REWARD_EXPIRED');
    if (status !== 'SCRATCHED') throw new Error('REWARD_NOT_SCRATCHED');

    const updated = await tx.user_rewards.update({
      where:   { id: rewardId },
      data:    { status: 'CLAIMED', claimed_at: now },
      include: REWARD_INCLUDE,
    });
    return toApiReward(updated, now);
  });
}

async function grantBadge(tx, userId, milestone) {
  const badge = await tx.badges.findFirst({ where: { name: milestone.description } });
  if (!badge) return;

  await tx.user_badges.upsert({
    where:  { user_id_badge_id: { user_id: userId, badge_id: badge.id } },
    create: { user_id: userId, badge_id: badge.id },
    update: {},
  });
}

// Nightly (src/cron/midnight.js): ACTIVE rewards past their expiry
// (user_rewards.expires_at, else the pool code's) become EXPIRED. Only
// rewards that expired recently get a push — a first run over a long
// backlog closes the old ones silently instead of blasting them.
const EXPIRED_PUSH_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

export async function expireRewards(now = new Date()) {
  const rewards = await prisma.user_rewards.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { expires_at: { lt: now } },
        { expires_at: null, reward_pool: { expires_at: { lt: now } } },
      ],
    },
    include: { reward_pool: { select: { expires_at: true, reward_partners: { select: { name: true } } } } },
  });

  let expired = 0;
  for (const reward of rewards) {
    const { count } = await prisma.user_rewards.updateMany({
      where: { id: reward.id, status: 'ACTIVE' },
      data:  { status: 'EXPIRED' },
    });
    if (count === 0) continue; // claimed or expired by a concurrent run
    expired += 1;

    const expiresAt = reward.expires_at ?? reward.reward_pool?.expires_at;
    if (now.getTime() - expiresAt.getTime() > EXPIRED_PUSH_WINDOW_MS) continue;

    const { prize, partner } = rewardLabel(reward);
    await createNotification(
      prisma, reward.user_id, 'REWARD_READY',
      'Reward expired',
      `${prize}${partner ? ` from ${partner}` : ''} has expired. Keep your streak going to earn the next one.`,
      { event: 'REWARD_EXPIRED', user_reward_id: String(reward.id) },
      { dedupeKey: `reward_expired:${reward.id}` }
    );
  }
  return expired;
}

// Push copy for a card's prize. An unscratched card is only ever "your
// scratch card" — the prize stays hidden until it's scratched.
export function rewardLabel(reward) {
  if (!reward.scratched_at) return { prize: 'Your scratch card', partner: null };
  return {
    prize:   reward.reward_text || 'Your reward',
    partner: reward.reward_pool?.reward_partners?.name ?? null,
  };
}
