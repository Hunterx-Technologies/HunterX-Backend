// src/services/scheduledNotificationJobs.js — Time-of-day pushes (retention,
// new quests, expiring rewards), run by src/cron/notificationScheduler.js
// (see the job shape there). Event pushes (level-up, milestones, reward
// granted) are created inline by xpService.js / rewardService.js instead.
//
// Clocks: tasks, streaks and weeks all roll over on the IST calendar
// (getISTDateOnly / getISTWeekStart), so day-bound jobs (streak_at_risk,
// weekly_deadline, new_quest) set `timezone: IST` and fire at the same
// instant for everyone. "Nice moment" jobs (task_reminder, streak_status,
// daily_motivation, reward_expiring) fire at the user's own local time.
// Deadline jobs pass expiresAt so quiet-hours deferral can't deliver a
// countdown after the deadline has passed.

import prisma from '../config/prisma.js';
import { createNotification } from './notificationService.js';
import { computeGap, reconcileStreak } from './streakService.js';
import { eligibilityWhere, VISIBLE_FILTER } from './leaderboardService.js';
import { FRIENDS_REFERRAL_CAP } from '../config/leaderboardConfig.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { getTaskPeriod } from './taskService.js';
import { getLocalTime } from '../utils/timezone.js';
import { getActivePurchase } from './taskPurchaseService.js';
import {
  QUEST_LABELS, newQuestKey, paidLaunchKey, paidLaunchMessage, formatDay, isOnSale,
} from './questNotificationService.js';

const IST            = 'Asia/Kolkata';
const DAY_MS         = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS  = 5.5 * 60 * 60 * 1000;
const DAILY_TYPES    = ['DAILY_FIXED', 'DAILY_ADMIN'];

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// getISTDateOnly()-style date (UTC midnight standing for an IST day) →
// the real instant that IST day ends.
function istDayEnd(istDate) {
  return new Date(istDate.getTime() + DAY_MS - IST_OFFSET_MS);
}

// Scheduled tasks for the period with no completion row (COMPLETED, PARTIAL
// and SKIPPED all count as handled).
async function countOpenTasks(userId, { types, from, to, periodDate }) {
  const scheduled = await prisma.task_schedule.findMany({
    where: {
      user_id:     userId,
      active_date: { gte: from, lte: to },
      tasks:       { is_active: true, task_type: { in: types } },
    },
    select:   { task_id: true },
    distinct: ['task_id'],
  });
  if (scheduled.length === 0) return 0;

  const handled = await prisma.task_completions.count({
    where: {
      user_id:       userId,
      task_id:       { in: scheduled.map((s) => s.task_id) },
      schedule_date: periodDate,
    },
  });
  return scheduled.length - handled;
}

// ── 2.1 Daily quest reminder ───────────────────────────────

const taskReminder = {
  name: 'task_reminder',
  type: 'TASK_REMINDER',
  slot: (settings) => settings.reminder_time || '19:00',
  run: async ({ userId }) => {
    const today = getISTDateOnly();
    const open  = await countOpenTasks(userId, { types: DAILY_TYPES, from: today, to: today, periodDate: today });
    if (open === 0) return null;

    return createNotification(
      prisma, userId, 'TASK_REMINDER',
      'Quests await, Hunter',
      `${plural(open, 'daily quest')} still open today. The System is watching.`,
      { event: 'TASK_REMINDER', open_tasks: open },
      { dedupeKey: `task_reminder:${dateKey(today)}`, expiresAt: istDayEnd(today) }
    );
  },
};

// ── 2.2 Streak at risk ─────────────────────────────────────
// 07:00 IST, the morning the streak needs today's quest: for users who
// were active yesterday (a gap is streak_status's job, same 07:00 slot).
// Missing today turns today into a missed day: covered by lives → costs
// a life, otherwise breaks.

const streakAtRisk = {
  name:     'streak_at_risk',
  type:     'STREAK_AT_RISK',
  timezone: IST,
  slot:     () => '07:00',
  run: async ({ userId }) => {
    const today       = getISTDateOnly();
    const progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
    const streak      = progression?.daily_streak ?? 0;
    if (streak <= 0) return null;

    const { daysSince, lives } = computeGap(progression, today);
    if (daysSince !== 1) return null; // active today, or a gap — streak_status handles gaps

    const costsLife = lives >= 1;
    const body = costsLife
      ? 'Clear one quest today or it costs you 1 streak life.'
      : 'Clear one quest today or your streak resets to zero.';

    return createNotification(
      prisma, userId, 'STREAK_AT_RISK',
      `🔥 ${streak}-day streak in danger`,
      body,
      { event: 'STREAK_AT_RISK', daily_streak: streak, streak_lives: lives, costs_life: costsLife },
      { dedupeKey: `streak_at_risk:${dateKey(today)}`, expiresAt: istDayEnd(today) }
    );
  },
};

// ── 2.3 Streak status after a missed day ───────────────────
// Lives are spent lazily (on next completion / explicit resolve) and
// breaks are only written when observed, so this job is what turns an
// overnight miss into a push: shielded-by-lives, or broken (reconciled
// write-through here, same as any other read path would).

const streakStatus = {
  name: 'streak_status',
  type: 'STREAK_FREEZE_USED', // gate: notify_streak_freeze covers both outcomes
  slot: () => '07:00',
  run: async ({ userId }) => {
    const today       = getISTDateOnly();
    const progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
    if (!progression) return null;

    const streak = progression.daily_streak;
    const { missedDays, coveredByLives } = computeGap(progression, today);
    if (missedDays === 0) return null;

    const dedupeKey = `streak_status:${dateKey(today)}`;

    if (coveredByLives) {
      if (streak <= 0) return null;
      return createNotification(
        prisma, userId, 'STREAK_FREEZE_USED',
        'A streak life is shielding you',
        `You missed ${plural(missedDays, 'day')}. Clear a quest today to keep your ${streak}-day streak alive.`,
        { event: 'STREAK_SHIELDED', daily_streak: streak, missed_days: missedDays },
        { dedupeKey, expiresAt: istDayEnd(today) }
      );
    }

    const alreadyBroken = streak === 0 && progression.streak_lives === 0;
    if (alreadyBroken) return null;
    await reconcileStreak(userId);
    if (streak <= 0) return null; // lives zeroed, but there was no streak to mourn

    return createNotification(
      prisma, userId, 'STREAK_BROKEN',
      'Your streak has fallen',
      `Your ${streak}-day streak ended. Every S-rank started at day one — begin again today.`,
      { event: 'STREAK_BROKEN', previous_streak: streak },
      { dedupeKey }
    );
  },
};

// A paid task's last period ends on the buyer's access_end — that
// deadline belongs to paid_task_expiring, not the period-deadline jobs.
async function endsWithPaidAccess(userId, task, period) {
  if (!task.is_paid) return false;
  const purchase = await getActivePurchase(userId, task.id);
  return Boolean(purchase && purchase.access_end.getTime() === period.end.getTime());
}

// ── 2.4 Weekly quest deadline ──────────────────────────────
// Daily 18:00 IST — each weekly quest runs in its own 7-day periods
// (taskService.getTaskPeriod), so remind about the ones whose current
// period ends tomorrow and that are still open.

const weeklyDeadline = {
  name:     'weekly_deadline',
  type:     'TASK_REMINDER',
  timezone: IST,
  slot:     () => '18:00',
  run: async ({ userId }) => {
    const today    = getISTDateOnly();
    const tomorrow = new Date(today.getTime() + DAY_MS);

    const scheduled = await prisma.task_schedule.findMany({
      where:   { user_id: userId, active_date: today, tasks: { is_active: true, task_type: 'WEEKLY' } },
      include: { tasks: true },
    });

    let open = 0;
    for (const { tasks: task } of scheduled) {
      const period = await getTaskPeriod(userId, task, today);
      if (period.end.getTime() !== tomorrow.getTime()) continue;
      if (await endsWithPaidAccess(userId, task, period)) continue;
      const handled = await prisma.task_completions.count({
        where: { user_id: userId, task_id: task.id, schedule_date: period.start },
      });
      if (!handled) open += 1;
    }
    if (open === 0) return null;

    return createNotification(
      prisma, userId, 'TASK_REMINDER',
      'Weekly quests close tomorrow',
      `${plural(open, 'weekly quest')} still open. Finish before tomorrow ends.`,
      { event: 'WEEKLY_DEADLINE', open_tasks: open },
      { dedupeKey: `weekly_deadline:${dateKey(tomorrow)}`, expiresAt: istDayEnd(tomorrow) }
    );
  },
};

// ── 2.4b Monthly quest deadline ────────────────────────────
// Daily 18:00 IST — monthly quests run in 30-day periods, so warn 3 days
// and 1 day before the current period ends while it's still open. One
// push per countdown day (tasks ending 3 and 1 days out don't merge).

const MONTHLY_NUDGE_DAYS = [3, 1];

const monthlyDeadline = {
  name:     'monthly_deadline',
  type:     'TASK_REMINDER',
  timezone: IST,
  slot:     () => '18:00',
  run: async ({ userId }) => {
    const today = getISTDateOnly();

    const scheduled = await prisma.task_schedule.findMany({
      where:   { user_id: userId, active_date: today, tasks: { is_active: true, task_type: 'MONTHLY' } },
      include: { tasks: true },
    });

    const openByDays = new Map(); // days left → { count, end }
    for (const { tasks: task } of scheduled) {
      const period   = await getTaskPeriod(userId, task, today);
      const daysLeft = Math.round((period.end.getTime() - today.getTime()) / DAY_MS);
      if (!MONTHLY_NUDGE_DAYS.includes(daysLeft)) continue;
      if (await endsWithPaidAccess(userId, task, period)) continue;
      const handled = await prisma.task_completions.count({
        where: { user_id: userId, task_id: task.id, schedule_date: period.start },
      });
      if (handled) continue;
      const entry = openByDays.get(daysLeft) ?? { count: 0, end: period.end };
      entry.count += 1;
      openByDays.set(daysLeft, entry);
    }

    let created = null;
    for (const [daysLeft, { count, end }] of openByDays) {
      const n = await createNotification(
        prisma, userId, 'TASK_REMINDER',
        daysLeft === 1 ? 'Monthly quests close tomorrow' : `Monthly quests close in ${daysLeft} days`,
        `${plural(count, 'monthly quest')} still open. Finish before ${formatDay(end)} ends.`,
        { event: 'MONTHLY_DEADLINE', open_tasks: count, days_left: daysLeft },
        { dedupeKey: `monthly_deadline:${dateKey(end)}:${daysLeft}`, expiresAt: istDayEnd(end) }
      );
      created = created ?? n;
    }
    return created;
  },
};

// ── 2.5 Daily motivation ───────────────────────────────────
// Everyone gets the same quote on a given day: active rows from `quotes`
// rotated by day number, or the built-in pool while that table is empty.

const FALLBACK_MOTIVATION = [
  'The weak wait for motivation. Hunters move without it.',
  'Every rep is XP. Every skipped day is a debt.',
  'You were not chosen. You chose. Prove it again today.',
  'Discipline is the only stat that never resets.',
  'The System rewards consistency, not intensity.',
  'Rank is earned in the days nobody sees.',
  'One quest. That is all it takes to keep the fire lit.',
  'Yesterday’s hunter is your only rival.',
];

async function pickDailyQuote(dayIndex) {
  const count = await prisma.quotes.count({ where: { is_active: true } });
  if (count > 0) {
    const quote = await prisma.quotes.findFirst({
      where:   { is_active: true },
      orderBy: { id: 'asc' },
      skip:    dayIndex % count,
    });
    if (quote) {
      return { body: `“${quote.quote_text}” — ${quote.author_name}`, quoteId: quote.id, imageUrl: quote.author_image_url };
    }
  }
  return { body: FALLBACK_MOTIVATION[dayIndex % FALLBACK_MOTIVATION.length], quoteId: null, imageUrl: null };
}

const dailyMotivation = {
  name: 'daily_motivation',
  type: 'DAILY_MOTIVATION',
  slot: () => '06:00', // before quiet hours end — the type is exempt (notificationTypes.js)
  run: async ({ userId, local }) => {
    const dayIndex = Math.floor(Date.parse(`${local.dateStr}T00:00:00Z`) / DAY_MS);
    const { body, quoteId, imageUrl } = await pickDailyQuote(dayIndex);

    return createNotification(
      prisma, userId, 'DAILY_MOTIVATION',
      'Daily directive',
      body,
      { event: 'DAILY_MOTIVATION' },
      { dedupeKey: `daily_motivation:${local.dateStr}`, quoteId, imageUrl }
    );
  },
};

// ── 3.4 Reward expiring ────────────────────────────────────
// User-local 10:00 for ACTIVE rewards whose expiry (user_rewards.expires_at,
// else the pool code's) lands in the next 48h: a heads-up while more than
// 24h are left, then a last-day reminder inside the final 24h. A reward
// first seen inside the last 24h only gets the last-day one.

const REWARD_EXPIRY_WINDOW_MS = 2 * DAY_MS;
const REWARD_FINAL_WINDOW_H   = 24;

const rewardExpiring = {
  name: 'reward_expiring',
  type: 'REWARD_READY',
  slot: () => '10:00',
  run: async ({ userId }) => {
    const now    = new Date();
    const window = { gt: now, lte: new Date(now.getTime() + REWARD_EXPIRY_WINDOW_MS) };
    const rewards = await prisma.user_rewards.findMany({
      where: {
        user_id: userId,
        status:  'ACTIVE',
        OR: [
          { expires_at: window },
          { expires_at: null, reward_pool: { expires_at: window } },
        ],
      },
      include: { reward_pool: { select: { discount_value: true, expires_at: true, reward_partners: { select: { name: true } } } } },
      orderBy: { id: 'asc' },
    });

    let created = null;
    for (const reward of rewards) {
      const expiresAt = reward.expires_at ?? reward.reward_pool.expires_at;
      const hoursLeft = Math.max(1, Math.round((expiresAt.getTime() - now.getTime()) / (60 * 60 * 1000)));
      const prize     = reward.reward_pool.discount_value || 'Your reward';
      const partner   = reward.reward_pool.reward_partners?.name;

      const from  = `${prize}${partner ? ` from ${partner}` : ''}`;
      const final = hoursLeft <= REWARD_FINAL_WINDOW_H;

      const n = await createNotification(
        prisma, userId, 'REWARD_READY',
        final ? `⏳ Last day to claim ${prize}` : '⏳ Reward expiring soon',
        final
          ? `${from} expires in ${hoursLeft}h. Claim it now.`
          : `${from} expires in ${hoursLeft}h. Claim it before it's gone.`,
        { event: final ? 'REWARD_EXPIRING_FINAL' : 'REWARD_EXPIRING', user_reward_id: reward.id, expires_at: expiresAt.toISOString() },
        { dedupeKey: `${final ? 'reward_expiring_final' : 'reward_expiring'}:${reward.id}`, expiresAt }
      );
      created = created ?? n;
    }
    return created;
  },
};

// ── 3.5 New admin quest ────────────────────────────────────
// 07:00 IST, after the 00:30 IST assignment cron. "New" = a free
// admin-created task (DAILY_ADMIN / WEEKLY / MONTHLY) assigned to this user
// today that was never assigned to them before — so a recurring quest
// announces once, not daily. Paid tasks have their own pushes (launch,
// purchase confirmed), and tasks created after 07:00 that were already
// announced on the spot (questNotificationService) are skipped.

const ADMIN_TYPES = ['DAILY_ADMIN', 'WEEKLY', 'MONTHLY'];

const newQuest = {
  name:     'new_quest',
  type:     'NEW_QUEST',
  timezone: IST,
  slot:     () => '07:00',
  run: async ({ userId }) => {
    const today = getISTDateOnly();
    const todays = await prisma.task_schedule.findMany({
      where: {
        user_id:     userId,
        active_date: today,
        tasks:       { is_active: true, is_paid: false, task_type: { in: ADMIN_TYPES } },
      },
      select: { task_id: true, tasks: { select: { title: true, task_type: true, xp_reward: true } } },
    });
    if (todays.length === 0) return null;

    const seenBefore = await prisma.task_schedule.findMany({
      where: {
        user_id:     userId,
        task_id:     { in: todays.map((s) => s.task_id) },
        active_date: { lt: today },
      },
      select:   { task_id: true },
      distinct: ['task_id'],
    });
    const announced = await prisma.notifications.findMany({
      where:  { user_id: userId, dedupe_key: { in: todays.map((s) => newQuestKey(s.task_id)) } },
      select: { dedupe_key: true },
    });
    const seen = new Set([
      ...seenBefore.map((s) => newQuestKey(s.task_id)),
      ...announced.map((n) => n.dedupe_key),
    ]);
    const fresh = todays.filter((s) => !seen.has(newQuestKey(s.task_id)));
    if (fresh.length === 0) return null;

    const [first] = fresh;
    const title = fresh.length === 1
      ? `New quest: ${first.tasks.title}`
      : `${fresh.length} new quests from the System`;
    const body = fresh.length === 1
      ? `${QUEST_LABELS[first.tasks.task_type] ?? 'Quest'} · +${first.tasks.xp_reward} XP. Accept the challenge.`
      : fresh.map((s) => s.tasks.title).join(' · ').slice(0, 180);

    return createNotification(
      prisma, userId, 'NEW_QUEST', title, body,
      { event: 'NEW_QUEST', task_ids: fresh.map((s) => String(s.task_id)) },
      { dedupeKey: `new_quest:${dateKey(today)}`, expiresAt: istDayEnd(today) }
    );
  },
};

// ── 3.6 Paid quest launch ──────────────────────────────────
// 08:00 IST on a paid task's start_date. Locked offers are never in
// task_schedule, so new_quest can't see them — this pitches each one to
// every user who hasn't bought it. Same dedupe key as the on-the-spot
// launch for tasks created after 08:00 (questNotificationService).

const paidQuestLaunch = {
  name:     'paid_quest_launch',
  type:     'NEW_QUEST',
  timezone: IST,
  slot:     () => '08:00',
  run: async ({ userId }) => {
    const today = getISTDateOnly();
    const tasks = await prisma.tasks.findMany({
      where: {
        is_paid:        true,
        is_active:      true,
        start_date:     today,
        task_purchases: { none: { user_id: userId, status: 'PAID' } },
      },
      orderBy: { id: 'asc' },
    });

    let created = null;
    for (const task of tasks) {
      if (!isOnSale(task, today)) continue;
      const { title, body } = paidLaunchMessage(task);
      const n = await createNotification(
        prisma, userId, 'NEW_QUEST', title, body,
        { event: 'PAID_QUEST_LAUNCH', task_ids: [String(task.id)] },
        { dedupeKey: paidLaunchKey(task), expiresAt: istDayEnd(task.end_date) }
      );
      created = created ?? n;
    }
    return created;
  },
};

// ── 3.7 Paid task access ending ────────────────────────────
// User-local 10:00, 3 days and 1 day before a buyer's access_end and on
// the last day itself, while the paid task is still not completed —
// they paid for it, so they must not lose it unawares.

const PAID_EXPIRY_NUDGE_DAYS = [3, 1, 0];

const paidTaskExpiring = {
  name: 'paid_task_expiring',
  type: 'PAID_TASK_EXPIRING',
  slot: () => '10:00',
  run: async ({ userId }) => {
    const today = getISTDateOnly();
    const purchases = await prisma.task_purchases.findMany({
      where: {
        user_id:      userId,
        status:       'PAID',
        completed_at: null,
        access_start: { lte: today },
        access_end:   { in: PAID_EXPIRY_NUDGE_DAYS.map((d) => new Date(today.getTime() + d * DAY_MS)) },
        tasks:        { is_active: true },
      },
      include: { tasks: { select: { title: true } } },
      orderBy: { id: 'asc' },
    });

    let created = null;
    for (const purchase of purchases) {
      const daysLeft = Math.round((purchase.access_end.getTime() - today.getTime()) / DAY_MS);
      const title    = purchase.tasks.title;
      const n = await createNotification(
        prisma, userId, 'PAID_TASK_EXPIRING',
        daysLeft === 0 ? `⏳ Last day: ${title}` : `⏳ ${title} closes in ${plural(daysLeft, 'day')}`,
        daysLeft === 0
          ? 'Your premium quest ends tonight. Complete it now or you lose access.'
          : `You unlocked this quest — complete it before ${formatDay(purchase.access_end)} or you lose access.`,
        { event: 'PAID_TASK_EXPIRING', purchase_id: String(purchase.id), task_id: String(purchase.task_id), days_left: daysLeft },
        { dedupeKey: `paid_task_expiring:${purchase.id}:${daysLeft}`, expiresAt: istDayEnd(purchase.access_end) }
      );
      created = created ?? n;
    }
    return created;
  },
};

// ── 3.8 Paid offer ending ──────────────────────────────────
// User-local 17:00 the day before a paid offer's end_date: one "last
// chance" to users who haven't bought it.

const paidOfferEnding = {
  name: 'paid_offer_ending',
  type: 'NEW_QUEST',
  slot: () => '17:00',
  run: async ({ userId }) => {
    const today    = getISTDateOnly();
    const tomorrow = new Date(today.getTime() + DAY_MS);
    const tasks = await prisma.tasks.findMany({
      where: {
        is_paid:        true,
        is_active:      true,
        start_date:     { lte: today },
        end_date:       tomorrow,
        task_purchases: { none: { user_id: userId, status: 'PAID' } },
      },
      orderBy: { id: 'asc' },
    });

    let created = null;
    for (const task of tasks) {
      const n = await createNotification(
        prisma, userId, 'NEW_QUEST',
        `Last chance: ${task.title}`,
        `This premium quest is only available until tomorrow (${formatDay(task.end_date)}). +${task.xp_reward} XP · ₹${Number(task.price)}.`,
        { event: 'PAID_OFFER_ENDING', task_ids: [String(task.id)] },
        { dedupeKey: `paid_offer_ending:${task.id}:${dateKey(task.end_date)}`, expiresAt: istDayEnd(task.end_date) }
      );
      created = created ?? n;
    }
    return created;
  },
};

// ── 4.4 Leaderboard digest ─────────────────────────────────
// User-local 18:00, at most one push a day. Ranks are recomputed the same
// way the leaderboard API orders them (total_xp desc, id asc) and diffed
// against yesterday's leaderboard_rank_snapshots row. Priority:
//   1. broke into the global top 10 / top 100
//   2. a friend passed you (named, with the XP gap to retake the spot)
//   3. you climbed among friends
// Ordinary global movement is too constant to be worth a push. The first
// run for a user only records a baseline. Users hidden from leaderboards
// (leaderboard_visible = false) are snapshotted as unranked, never pushed.

const GLOBAL_THRESHOLDS = [10, 100];

// Users ranked above someone with `xp` and id `userId`.
function aheadOf(userId, xp) {
  return {
    OR: [
      { user_progression: { total_xp: { gt: xp } } },
      { AND: [{ user_progression: { total_xp: xp } }, { id: { lt: userId } }] },
    ],
  };
}

async function computeRanks(userId, settings) {
  const me = await prisma.users.findUnique({
    where:  { id: userId },
    select: { referred_by: true, user_progression: { select: { total_xp: true } } },
  });
  const xp = me?.user_progression?.total_xp ?? 0;
  if (!me || settings.leaderboard_visible === false || xp <= 0) {
    return { xp, globalRank: null, friendsRank: null, closestAhead: null };
  }

  const globalRank = 1 + await prisma.users.count({
    where: { AND: [eligibilityWhere('global'), aheadOf(userId, xp)] },
  });

  const referred = await prisma.referrals.findMany({
    where:   { referrer_id: userId },
    orderBy: { created_at: 'desc' },
    take:    FRIENDS_REFERRAL_CAP,
    select:  { referred_id: true },
  });
  const friendIds = referred.map((r) => r.referred_id);
  if (me.referred_by) friendIds.push(me.referred_by);
  if (friendIds.length === 0) return { xp, globalRank, friendsRank: null, closestAhead: null };

  const ahead = await prisma.users.findMany({
    where:   { id: { in: friendIds }, is_banned: false, ...VISIBLE_FILTER, ...aheadOf(userId, xp) },
    orderBy: [{ user_progression: { total_xp: 'asc' } }, { id: 'desc' }],
    select:  { name: true, user_progression: { select: { total_xp: true } } },
  });

  return { xp, globalRank, friendsRank: ahead.length + 1, closestAhead: ahead[0] ?? null };
}

function digestMessage(prev, { xp, globalRank, friendsRank, closestAhead }) {
  for (const threshold of GLOBAL_THRESHOLDS) {
    if (globalRank && globalRank <= threshold && (prev.global_rank == null || prev.global_rank > threshold)) {
      return {
        title: `🏆 You broke into the global top ${threshold}`,
        body:  `You're #${globalRank} worldwide. Hold the line, Hunter.`,
        event: 'GLOBAL_THRESHOLD',
      };
    }
  }
  if (friendsRank && prev.friends_rank && friendsRank > prev.friends_rank && closestAhead) {
    const gap = (closestAhead.user_progression?.total_xp ?? xp) - xp + 1;
    return {
      title: `${closestAhead.name} passed you`,
      body:  `You dropped to #${friendsRank} among friends. ${gap} XP to take it back.`,
      event: 'FRIEND_PASSED_YOU',
    };
  }
  if (friendsRank && prev.friends_rank && friendsRank < prev.friends_rank) {
    const places = prev.friends_rank - friendsRank;
    return {
      title: `You climbed to #${friendsRank} among friends`,
      body:  `Up ${places} place${places === 1 ? '' : 's'}. Keep hunting.`,
      event: 'FRIENDS_CLIMB',
    };
  }
  return null;
}

const leaderboardDigest = {
  name: 'leaderboard_digest',
  type: 'LEADERBOARD_UPDATE',
  slot: () => '18:00',
  run: async ({ userId, settings, local }) => {
    const ranks = await computeRanks(userId, settings);
    const prev  = await prisma.leaderboard_rank_snapshots.findUnique({ where: { user_id: userId } });

    const snapshot = { global_rank: ranks.globalRank, friends_rank: ranks.friendsRank, updated_at: new Date() };
    await prisma.leaderboard_rank_snapshots.upsert({
      where:  { user_id: userId },
      create: { user_id: userId, ...snapshot },
      update: snapshot,
    });
    if (!prev) return null;

    const message = digestMessage(prev, ranks);
    if (!message) return null;

    return createNotification(
      prisma, userId, 'LEADERBOARD_UPDATE', message.title, message.body,
      { event: message.event, global_rank: ranks.globalRank, friends_rank: ranks.friendsRank },
      { dedupeKey: `leaderboard_digest:${local.dateStr}` }
    );
  },
};

// ── 6.2 Health sync broken ─────────────────────────────────
// User-local 11:00. Only for users who have synced at least once: if the
// newest health_metrics_daily row is exactly 3 or 7 IST days old, nudge
// them to reopen Metrics (permissions revoked / provider disconnected /
// app not opened). Two nudges per gap, then silence.

const HEALTH_SYNC_NUDGE_DAYS = [3, 7];
const HEALTH_SOURCE_NAMES = { apple_health: 'Apple Health', health_connect: 'Health Connect' };

const healthSync = {
  name: 'health_sync',
  type: 'HEALTH_SYNC',
  slot: () => '11:00',
  run: async ({ userId }) => {
    const last = await prisma.health_metrics_daily.findFirst({
      where:   { user_id: userId },
      orderBy: { date: 'desc' },
      select:  { date: true, source: true },
    });
    if (!last) return null;

    const gapDays = Math.round((getISTDateOnly().getTime() - last.date.getTime()) / DAY_MS);
    if (!HEALTH_SYNC_NUDGE_DAYS.includes(gapDays)) return null;

    const source = HEALTH_SOURCE_NAMES[last.source] || 'your health app';
    return createNotification(
      prisma, userId, 'HEALTH_SYNC',
      'Your health data stopped syncing',
      `No steps from ${source} in ${gapDays} days. Open Metrics to reconnect.`,
      { event: 'HEALTH_SYNC', last_sync_date: dateKey(last.date), gap_days: gapDays },
      { dedupeKey: `health_sync:${dateKey(last.date)}:${gapDays}` }
    );
  },
};

// ── 6.4 Win-back ───────────────────────────────────────────
// User-local 12:00, at exactly 3 / 7 / 14 local days since the user was
// last seen, then silence until they come back. "Seen" = latest device
// check-in (user_push_tokens.last_seen_at, refreshed on every app
// foreground) or latest active day (user_progression.last_active_date),
// whichever is newer.

const WIN_BACK_MESSAGES = {
  3:  { title: 'The System noticed your absence', body: 'Your quests are waiting, Hunter. One is all it takes to get back on track.' },
  7:  { title: 'A week in the shadows',           body: "Your rank won't climb itself. Come back and clear today's quests." },
  14: { title: 'Final summons',                   body: 'Two weeks gone. The gate is still open — return and reclaim your place.' },
};

function localDayNumber(tz, date) {
  return Math.floor(Date.parse(`${getLocalTime(tz, date).dateStr}T00:00:00Z`) / DAY_MS);
}

const winBack = {
  name: 'win_back',
  type: 'WIN_BACK',
  slot: () => '12:00',
  run: async ({ userId, settings, local }) => {
    const [device, progression] = await Promise.all([
      prisma.user_push_tokens.findFirst({
        where:   { user_id: userId },
        orderBy: { last_seen_at: 'desc' },
        select:  { last_seen_at: true },
      }),
      prisma.user_progression.findUnique({ where: { user_id: userId }, select: { last_active_date: true } }),
    ]);

    // last_active_date is an IST calendar day — treat it as that day's IST noon.
    const activeAt = progression?.last_active_date
      ? new Date(progression.last_active_date.getTime() + 12 * 60 * 60 * 1000 - IST_OFFSET_MS)
      : null;
    const seenAt = [device?.last_seen_at, activeAt].filter(Boolean).sort((a, b) => b - a)[0];
    if (!seenAt) return null;

    const daysAway = Math.floor(Date.parse(`${local.dateStr}T00:00:00Z`) / DAY_MS) - localDayNumber(settings.timezone, seenAt);
    const message  = WIN_BACK_MESSAGES[daysAway];
    if (!message) return null;

    return createNotification(
      prisma, userId, 'WIN_BACK', message.title, message.body,
      { event: 'WIN_BACK', days_away: daysAway },
      { dedupeKey: `win_back:${getLocalTime(settings.timezone, seenAt).dateStr}:${daysAway}` }
    );
  },
};

// ── 6.5 Onboarding nudge ───────────────────────────────────
// User-local 18:00, 1 and 3 local days after signup, for users who
// registered a device but never finished onboarding. `audience:
// 'onboarding'` makes the scheduler run it for exactly those users (every
// other job only runs for onboarded users).

const ONBOARDING_MESSAGES = {
  1: { title: 'Your Hunter profile is almost ready', body: 'Finish setup to unlock your first daily quests.' },
  3: { title: 'The System is still waiting',         body: 'A few questions stand between you and your first quest. Finish setup now.' },
};

const onboardingNudge = {
  name:     'onboarding_nudge',
  type:     'WIN_BACK',
  audience: 'onboarding',
  slot:     () => '18:00',
  run: async ({ userId, user, settings, local }) => {
    if (!user.created_at) return null;
    const daysSince = Math.floor(Date.parse(`${local.dateStr}T00:00:00Z`) / DAY_MS) - localDayNumber(settings.timezone, user.created_at);
    const message   = ONBOARDING_MESSAGES[daysSince];
    if (!message) return null;

    return createNotification(
      prisma, userId, 'WIN_BACK', message.title, message.body,
      { event: 'ONBOARDING_NUDGE', days_since_signup: daysSince },
      { dedupeKey: `onboarding_nudge:${daysSince}` }
    );
  },
};

export const SCHEDULED_NOTIFICATION_JOBS = [
  taskReminder,
  streakAtRisk,
  streakStatus,
  weeklyDeadline,
  monthlyDeadline,
  dailyMotivation,
  rewardExpiring,
  newQuest,
  paidQuestLaunch,
  paidTaskExpiring,
  paidOfferEnding,
  leaderboardDigest,
  healthSync,
  winBack,
  onboardingNudge,
];
