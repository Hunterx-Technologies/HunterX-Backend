// src/services/streakService.js — Daily streak tracking + streak lives
//
// ── The streak itself ───────────────────────────────────────────
// bumpDailyStreak(tx, userId) runs live, inside the same transaction as
// a task completion (see taskService.js#setTaskCompletion) — only for
// DAILY_FIXED/DAILY_ADMIN tasks with status COMPLETED or PARTIAL; WEEKLY
// tasks and SKIPPED never feed it. Completing/partially-completing at
// least ONE daily task on a given IST calendar day maintains that day; a
// day only ever counts once, gated by user_progression.last_active_date.
//
// ── Streak lives ────────────────────────────────────────────────
// Every user starts with 1 life (user_progression.streak_lives, DEFAULT
// 1 — the row is created at signup with just user_id, so this applies to
// every new account automatically). +1 life is earned on reaching the
// first 7-day streak milestone, capped at 2 — there's no further monthly
// or recurring grant beyond that.
//
// A life forgives one missed calendar day. A gap of N consecutive missed
// days is covered as long as the user has at least N lives banked
// (missed_days <= lives) — each missed day consumes one life. A gap
// longer than the banked lives always breaks the streak to 0; lives are
// never partially spent on a gap they can't fully cover.
//
// Two ways a covered gap gets resolved:
//   1. Automatic/silent (bumpDailyStreak): if the user just goes ahead
//      and completes a task after a gap that's within their banked
//      lives, the gap is covered transparently (spending one life per
//      missed day) and the streak keeps counting — no confirmation
//      needed.
//   2. Interactive (getStreakRiskStatus / resolveStreakRisk): called
//      from GET /api/tasks/today and POST /api/tasks/streak/resolve, so
//      the app can show the user a "your streak is at risk — use a life
//      or let it drop?" prompt BEFORE they've done anything that day.
//      Choosing USE_LIVES pre-emptively covers the same gap (same
//      effect as path 1, just proactive); choosing DROP breaks the
//      streak to 0 immediately instead of waiting for it to lazily
//      reset to 1 on next completion.
// A gap that exceeds the banked lives is never "at risk" (there's no
// decision to make, no amount of lives can save it) — it just breaks on
// next completion.
//
// A life only ever protects a missed day — it never increments the
// streak by itself; only an actual active day does that.
//
// ── Breaking the moment it happens ──────────────────────────────
// A gap that exceeds the banked lives breaks the streak to 0 as soon as
// it's observed — not lazily held at its old value until the user's
// next completion. Since there's no clock-driven job in this system,
// "as soon as it's observed" means the first read or write that computes
// the gap: reconcileStreak(userId) is that check, and every read path
// that surfaces daily_streak (getStreakRiskStatus, getUserActivity)
// calls it first so the break is write-through and visible immediately,
// not just inferred for one response. bumpDailyStreak doesn't need it
// separately — completing a task after a broken gap already lands on
// newStreak = 1 directly, the same end state. Lives are zeroed out too
// when a break is reconciled, since a gap too long to cover means
// whatever was banked has already been spent trying.

import prisma from '../config/prisma.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { grantStreakMilestoneReward, checkAndAwardStreakMilestoneBadge } from './rewardService.js';
import { createNotification } from './notificationService.js';

const MS_PER_DAY   = 24 * 60 * 60 * 1000;
const MAX_LIVES     = 2;
const LIFE_EVERY_N_DAYS = 7;

function daysBetween(from, to) {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

// missed_days > 0 means at least one full day passed with no activity;
// covered means the gap is fully within the banked lives (one life per
// missed day) — a gap longer than the banked lives is never covered.
export function computeGap(progression, today) {
  const lastActive = progression?.last_active_date ?? null;
  const daysSince   = lastActive ? daysBetween(lastActive, today) : null;
  const missedDays  = daysSince !== null && daysSince > 1 ? daysSince - 1 : 0;
  const lives       = progression?.streak_lives ?? 1;
  return {
    daysSince,
    missedDays,
    lives,
    coveredByLives: missedDays > 0 && missedDays <= lives,
  };
}

// Must run inside the caller's transaction so a rollback can't leave XP
// recorded without the streak (or vice versa). `tx` is a Prisma
// transaction client; `userId` is already a BigInt.
export async function bumpDailyStreak(tx, userId) {
  const today = getISTDateOnly();

  const progression = await tx.user_progression.findUnique({ where: { user_id: userId } });
  const { daysSince, missedDays, lives, coveredByLives } = computeGap(progression, today);

  if (daysSince === 0) return; // already counted today — no-op

  const continuing    = daysSince === 1 || coveredByLives;
  const currentStreak = progression?.daily_streak ?? 0;
  const newStreak      = continuing ? currentStreak + 1 : 1;
  const livesSpent      = coveredByLives ? missedDays : 0;
  const livesAfterSpend = lives - livesSpent;
  const earnedLife       = newStreak > 0 && newStreak % LIFE_EVERY_N_DAYS === 0 && livesAfterSpend < MAX_LIVES;
  const newLives          = earnedLife ? livesAfterSpend + 1 : livesAfterSpend;

  await tx.user_progression.upsert({
    where: { user_id: userId },
    create: {
      user_id:               userId,
      daily_streak:          1,
      longest_streak:        1,
      consecutive_miss_days: 0,
      last_active_date:      today,
      streak_lives:          newLives,
    },
    update: {
      daily_streak:          newStreak,
      longest_streak:        Math.max(progression?.longest_streak ?? 0, newStreak),
      consecutive_miss_days: continuing ? 0 : missedDays,
      last_active_date:      today,
      streak_lives:          newLives,
    },
  });

  // Milestone rewards & permanent streak badges (Ember Vow, Iron Resolve, Shadow Oath,
  // Phantom Discipline, Sovereign Will, Void Ascendant, Eternal Hunter).
  // Idempotent: earned badges are inserted into user_badges once and preserved permanently.
  // A life earned on a milestone day rides along in the milestone push
  // instead of sending a second one at the same moment.
  const STREAK_MILESTONES_LIST = [7, 14, 30, 60, 90, 200, 365];
  let milestone = { granted: false };
  if (STREAK_MILESTONES_LIST.includes(newStreak)) {
    milestone = await checkAndAwardStreakMilestoneBadge(tx, userId, newStreak, { lifeEarned: earnedLife });
  } else {
    const row = await tx.streak_milestones.findUnique({ where: { streak_days: newStreak } });
    if (row) {
      milestone = await grantStreakMilestoneReward(tx, userId, row, { lifeEarned: earnedLife });
    }
  }

  if (earnedLife && !milestone.granted) {
    await createNotification(
      tx, userId, 'STREAK_MILESTONE',
      '🛡️ Streak life earned',
      `${newStreak}-day streak! You now have ${newLives} streak ${newLives === 1 ? 'life' : 'lives'} — a missed day won't break your streak.`,
      { event: 'STREAK_LIFE_EARNED', daily_streak: newStreak, streak_lives: newLives }
    );
  }
}

// Collapses an unprotected gap (missed days > banked lives) to a broken
// streak the moment it's observed, instead of leaving the stale pre-gap
// value sitting in the DB until the user's next completion. Write-through
// so every other reader (leaderboards, admin stats, exports) also sees
// the corrected value from this point on, not just the caller here.
// A no-op once already broken (daily_streak and streak_lives both 0) so
// repeated calls during the same unrecovered gap don't issue redundant
// writes.
export async function reconcileStreak(userId) {
  const today       = getISTDateOnly();
  const progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
  if (!progression) return progression;

  const { missedDays, coveredByLives } = computeGap(progression, today);
  const isBroken      = missedDays > 0 && !coveredByLives;
  const alreadyBroken = progression.daily_streak === 0 && progression.streak_lives === 0;
  if (!isBroken || alreadyBroken) return progression;

  return prisma.user_progression.update({
    where: { user_id: userId },
    data: {
      daily_streak:          0,
      streak_lives:          0,
      consecutive_miss_days: missedDays,
    },
  });
}

// Surfaced in GET /api/tasks/today so the client can decide whether to
// show the "use a life or let it drop?" prompt before the user has done
// anything today. Reconciles first so an already-unprotected gap reads
// as a broken (0) streak rather than the stale pre-gap value.
export async function getStreakRiskStatus(userId) {
  const today       = getISTDateOnly();
  const progression = await reconcileStreak(userId);
  const { missedDays, lives, coveredByLives } = computeGap(progression, today);

  return {
    daily_streak:   progression?.daily_streak ?? 0,
    longest_streak: progression?.longest_streak ?? 0,
    streak_lives:   lives,
    at_risk:        coveredByLives,       // true only when there's an actual decision to make
    missed_days:    coveredByLives ? missedDays : 0,
  };
}

// The user's explicit choice from the "streak at risk" prompt.
// action: 'USE_LIVES' spends missed_days lives and forgives the gap
//         without touching daily_streak itself — the streak resumes
//         counting normally the next time the user actually completes a
//         daily task (bumpDailyStreak sees a clean 1-day gap then).
// action: 'DROP' breaks the streak to 0 immediately instead of waiting
//         for the lazy reset-to-1 a plain missed gap would otherwise get
//         on next completion.
export async function resolveStreakRisk(userId, action) {
  if (!['USE_LIVES', 'DROP'].includes(action)) throw new Error('INVALID_ACTION');

  const today       = getISTDateOnly();
  const progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
  const { missedDays, coveredByLives } = computeGap(progression, today);

  if (!coveredByLives) throw new Error('NOTHING_TO_RESOLVE');

  const yesterday = new Date(today.getTime() - MS_PER_DAY);

  // Conditional on the state just read (same last_active_date, enough
  // lives), so a double-submitted USE_LIVES can't spend lives twice or
  // drive streak_lives negative — the loser matches nothing.
  const { count } = await prisma.user_progression.updateMany({
    where: {
      user_id:          userId,
      last_active_date: progression.last_active_date,
      ...(action === 'USE_LIVES' ? { streak_lives: { gte: missedDays } } : {}),
    },
    data: action === 'USE_LIVES'
      ? {
          streak_lives:     { decrement: missedDays },
          last_active_date: yesterday, // erases the gap; next completion continues normally
        }
      : {
          daily_streak:          0,
          consecutive_miss_days: 0,
          last_active_date:      null,
        },
  });
  if (count === 0) throw new Error('NOTHING_TO_RESOLVE');

  const updated = await prisma.user_progression.findUnique({ where: { user_id: userId } });

  return {
    daily_streak:   updated.daily_streak,
    longest_streak: updated.longest_streak,
    streak_lives:   updated.streak_lives,
  };
}
