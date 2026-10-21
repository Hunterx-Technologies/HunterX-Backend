// src/services/rewardService.js — Streak-milestone reward granting
//
// Grants the physical/cosmetic reward tied to a streak_milestones row
// once a streak hits that day count. Called only from
// streakService.js#bumpDailyStreak, inside its transaction. No XP is
// ever paid here — streak_milestones.xp_bonus is seeded 0 for every row
// and deliberately unread by this file; XP only ever comes from
// taskService.js/xpService.js on task completion. Idempotent per
// (user, milestone) via user_streak_milestones' unique constraint.

import prisma from '../config/prisma.js';
import { createNotification } from './notificationService.js';

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
      if (milestone.reward_type === 'COUPON') {
        await grantCoupon(tx, userId, milestone);
      }
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

// Milestones with a permanent badge go through the badge path above. Any
// other streak_milestones row (e.g. a 21-day coupon) used to stop there
// because it has no badge — it's recorded and rewarded here instead.
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
  if (milestone.reward_type === 'COUPON') {
    await grantCoupon(tx, userId, milestone);
  }

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

async function grantCoupon(tx, userId, milestone) {
  const trigger = TRIGGER_BY_STREAK_DAYS[milestone.streak_days];
  if (!trigger) return;

  // Claim one unassigned, unexpired code atomically. SKIP LOCKED lets two
  // users hitting a milestone at once each take a different code instead
  // of both reading the same "first free" row.
  const [claimed] = await tx.$queryRaw`
    UPDATE reward_pool SET is_assigned = true
    WHERE id = (
      SELECT id FROM reward_pool
      WHERE is_assigned = false AND (expires_at IS NULL OR expires_at > ${new Date()})
      ORDER BY id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  if (!claimed) return;

  const code = await tx.reward_pool.findUnique({
    where:   { id: claimed.id },
    include: { reward_partners: { select: { name: true } } },
  });
  const reward = await tx.user_rewards.create({
    data: { user_id: userId, pool_id: code.id, trigger_type: trigger, status: 'ACTIVE' },
  });

  const prize   = code.discount_value || 'a reward';
  const partner = code.reward_partners?.name;
  await createNotification(
    tx, userId, 'REWARD_READY',
    '🎁 Reward unlocked',
    `Your ${milestone.streak_days}-day streak earned ${prize}${partner ? ` from ${partner}` : ''}. Tap to claim it.`,
    { event: 'REWARD_READY', user_reward_id: reward.id, trigger, streak_days: milestone.streak_days }
  );
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
    include: { reward_pool: { select: { discount_value: true, expires_at: true, reward_partners: { select: { name: true } } } } },
  });

  let expired = 0;
  for (const reward of rewards) {
    const { count } = await prisma.user_rewards.updateMany({
      where: { id: reward.id, status: 'ACTIVE' },
      data:  { status: 'EXPIRED' },
    });
    if (count === 0) continue; // claimed or expired by a concurrent run
    expired += 1;

    const expiresAt = reward.expires_at ?? reward.reward_pool.expires_at;
    if (now.getTime() - expiresAt.getTime() > EXPIRED_PUSH_WINDOW_MS) continue;

    const prize   = reward.reward_pool.discount_value || 'Your reward';
    const partner = reward.reward_pool.reward_partners?.name;
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
