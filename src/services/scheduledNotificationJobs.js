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
import { getISTDateOnly, getISTWeekStart } from '../utils/helpers.js';
import { getLocalTime } from '../utils/timezone.js';

const IST            = 'Asia/Kolkata';
const DAY_MS         = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS  = 5.5 * 60 * 60 * 1000;
const DAILY_TYPES    = ['DAILY_FIXED', 'DAILY_ADMIN'];
const SATURDAY       = 6;

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
// 20:00 IST = 4h before the IST day closes. Missing today turns today
// into a missed day: covered by lives → costs lives, otherwise breaks.

const streakAtRisk = {
  name:     'streak_at_risk',
  type:     'STREAK_AT_RISK',
  timezone: IST,
  slot:     () => '20:00',
  run: async ({ userId }) => {
    const today       = getISTDateOnly();
    const progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
    const streak      = progression?.daily_streak ?? 0;
    if (streak <= 0) return null;

    const { daysSince, missedDays, coveredByLives, lives } = computeGap(progression, today);
    if (daysSince === null || daysSince === 0) return null; // active today
    if (missedDays > 0 && !coveredByLives) return null;     // already broken — streak_status handles it

    const missedIfIdle = daysSince; // today joins the gap
    const costsLife    = missedIfIdle <= lives;
    const body = costsLife
      ? `Clear one quest in the next 4 hours or it costs you ${plural(missedIfIdle, 'streak life')}.`
      : 'Clear one quest in the next 4 hours or your streak resets to zero.';

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
  slot: () => '09:00',
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

// ── 2.4 Weekly quest deadline ──────────────────────────────
// Saturday 18:00 IST — the week (Mon–Sun IST) closes Sunday midnight.

const weeklyDeadline = {
  name:     'weekly_deadline',
  type:     'TASK_REMINDER',
  timezone: IST,
  slot:     (_settings, clock) => (clock.weekday === SATURDAY ? '18:00' : null),
  run: async ({ userId }) => {
    const weekStart = getISTWeekStart();
    const weekEnd   = new Date(weekStart.getTime() + 6 * DAY_MS);
    const open = await countOpenTasks(userId, { types: ['WEEKLY'], from: weekStart, to: weekEnd, periodDate: weekStart });
    if (open === 0) return null;

    return createNotification(
      prisma, userId, 'TASK_REMINDER',
      'Weekly quests close tomorrow',
      `${plural(open, 'weekly quest')} still open. The week resets at midnight Sunday.`,
      { event: 'WEEKLY_DEADLINE', open_tasks: open },
      { dedupeKey: `weekly_deadline:${dateKey(weekStart)}`, expiresAt: istDayEnd(weekEnd) }
    );
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
  slot: () => '07:00',
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
// User-local 10:00, once per reward, for ACTIVE rewards whose expiry
// (user_rewards.expires_at, else the pool code's) lands in the next 48h.

const REWARD_EXPIRY_WINDOW_MS = 2 * DAY_MS;

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

      const n = await createNotification(
        prisma, userId, 'REWARD_READY',
        '⏳ Reward expiring soon',
        `${prize}${partner ? ` from ${partner}` : ''} expires in ${hoursLeft}h. Claim it before it's gone.`,
        { event: 'REWARD_EXPIRING', user_reward_id: reward.id, expires_at: expiresAt.toISOString() },
        { dedupeKey: `reward_expiring:${reward.id}`, expiresAt }
      );
      created = created ?? n;
    }
    return created;
  },
};

// ── 3.5 New admin quest ────────────────────────────────────
// 08:00 IST, after the 00:30 IST assignment cron. "New" = an admin-created
// task (DAILY_ADMIN / WEEKLY) assigned to this user today that was never
// assigned to them before — so a recurring quest announces once, not daily.

const ADMIN_TYPES = ['DAILY_ADMIN', 'WEEKLY'];

const newQuest = {
  name:     'new_quest',
  type:     'NEW_QUEST',
  timezone: IST,
  slot:     () => '08:00',
  run: async ({ userId }) => {
    const today = getISTDateOnly();
    const todays = await prisma.task_schedule.findMany({
      where: {
        user_id:     userId,
        active_date: today,
        tasks:       { is_active: true, task_type: { in: ADMIN_TYPES } },
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
    const seen  = new Set(seenBefore.map((s) => String(s.task_id)));
    const fresh = todays.filter((s) => !seen.has(String(s.task_id)));
    if (fresh.length === 0) return null;

    const [first] = fresh;
    const title = fresh.length === 1
      ? `New quest: ${first.tasks.title}`
      : `${fresh.length} new quests from the System`;
    const body = fresh.length === 1
      ? `${first.tasks.task_type === 'WEEKLY' ? 'Weekly quest' : "Today's quest"} · +${first.tasks.xp_reward} XP. Accept the challenge.`
      : fresh.map((s) => s.tasks.title).join(' · ').slice(0, 180);

    return createNotification(
      prisma, userId, 'NEW_QUEST', title, body,
      { event: 'NEW_QUEST', task_ids: fresh.map((s) => String(s.task_id)) },
      { dedupeKey: `new_quest:${dateKey(today)}`, expiresAt: istDayEnd(today) }
    );
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

export const SCHEDULED_NOTIFICATION_JOBS = [
  taskReminder,
  streakAtRisk,
  streakStatus,
  weeklyDeadline,
  dailyMotivation,
  rewardExpiring,
  newQuest,
  leaderboardDigest,
  healthSync,
  winBack,
];
