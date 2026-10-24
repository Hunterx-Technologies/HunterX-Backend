// src/services/adminUserService.js — Admin "Users" screen: search/filter/
// paginate the roster, the summary stat cards above it, and the filter
// option lists (ranks) the frontend renders as dropdowns.
//
// "Rank" here is levels.rank_name (DORMANT/HOLLOW/PHANTOM/...), reached via
// user_progression.current_level -> levels.level_number — there is no rank
// column on users itself. "Status" is derived, not stored: BANNED when
// users.is_banned, ACTIVE otherwise (no separate INACTIVE tier — see
// README note in the PR/handoff for why, and ping if you want one added).

import bcrypt from 'bcryptjs';
import prisma from '../config/prisma.js';
import { parseDateOnly, getISTDateOnly, isValidEmail, isStrongPassword, generateHunterId, generateReferralCode } from '../utils/helpers.js';
import { info, logError } from '../utils/logger.js';
import { syncLeaderboardMember } from './leaderboardService.js';
import { createNotification } from './notificationService.js';

// Tells the user about an admin action on their account. The action is
// already committed, so a push failure is only logged.
async function notifyAccountUpdate(userId, event, title, body, extra = {}) {
  try {
    await createNotification(prisma, userId, 'ACCOUNT_UPDATE', title, body, { event, ...extra });
  } catch (err) {
    logError(`Account update push (${event}) failed for user ${userId}: ${err.message}`);
  }
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_DAY     = 24 * 60 * 60 * 1000;

const STATUSES     = ['ACTIVE', 'BANNED'];
const DATE_PRESETS  = { '7d': 7, '30d': 30, '90d': 90 };
const SORTABLE      = {
  signup_date: { created_at: 'desc' },
  name:        { name: 'asc' },
  level:       { user_progression: { current_level: 'desc' } },
  streak:      { user_progression: { daily_streak: 'desc' } },
};

// getISTDateOnly() returns a Date holding the IST calendar date at UTC
// midnight (a display/comparison convention, not a real instant). users.
// created_at is a real timestamptz, so "00:00 IST on that calendar date"
// has to be converted back to the actual UTC instant it occurred at.
function istDateToUtcInstant(istDate) {
  return new Date(istDate.getTime() - IST_OFFSET_MS);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

// Resolves the created_at range for either a named preset or an explicit
// start_date/end_date pair (the latter wins if both are somehow passed).
// Returns null when no date filter applies at all.
function resolveDateRange({ datePreset, startDate, endDate }) {
  if (startDate || endDate) {
    const start = startDate ? parseDateOnly(startDate) : null;
    const end   = endDate ? parseDateOnly(endDate) : null;
    if (startDate && !start) throw new Error('INVALID_START_DATE');
    if (endDate && !end) throw new Error('INVALID_END_DATE');
    if (start && end && start.getTime() > end.getTime()) throw new Error('START_AFTER_END_DATE');

    return {
      gte: start ? istDateToUtcInstant(start) : undefined,
      lt:  end ? istDateToUtcInstant(addDays(end, 1)) : undefined,
    };
  }

  if (!datePreset || datePreset === 'all') return null;

  const days = DATE_PRESETS[datePreset];
  if (!days) throw new Error('INVALID_DATE_PRESET');

  const today = getISTDateOnly();
  return {
    gte: istDateToUtcInstant(getISTDateOnly(-(days - 1))),
    lt:  istDateToUtcInstant(addDays(today, 1)),
  };
}

// "1-10" -> { gte: 1, lte: 10 }. Order-independent (accepts "10-1" too).
function parseLevelRange(level) {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(String(level).trim());
  if (!match) throw new Error('INVALID_LEVEL_RANGE');
  const a = parseInt(match[1], 10);
  const b = parseInt(match[2], 10);
  return { gte: Math.min(a, b), lte: Math.max(a, b) };
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/users/ranks — distinct rank list for the "All Ranks"
// dropdown, ordered the way ranks are actually reached (lowest level
// first) rather than alphabetically.
// ─────────────────────────────────────────────────────────────

export async function getRanks() {
  const rows = await prisma.levels.findMany({
    where:   { rank_name: { not: null } },
    select:  { rank_name: true },
    orderBy: { level_number: 'asc' },
  });

  const seen  = new Set();
  const ranks = [];
  for (const { rank_name } of rows) {
    if (!seen.has(rank_name)) {
      seen.add(rank_name);
      ranks.push(rank_name);
    }
  }
  return ranks;
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/users/stats — the four summary cards above the table.
// Always computed over the whole roster (unaffected by the table's
// search/filters), matching the "at a glance" role those cards play.
// ─────────────────────────────────────────────────────────────

export async function getUserStats() {
  const today = getISTDateOnly();

  const [totalUsers, activeToday, aggregates] = await Promise.all([
    prisma.users.count(),
    prisma.user_progression.count({ where: { last_active_date: today } }),
    prisma.user_progression.aggregate({
      _avg: { current_level: true, daily_streak: true },
    }),
  ]);

  return {
    total_users: totalUsers,
    active_today: activeToday,
    avg_level:  Math.round(aggregates._avg.current_level ?? 0),
    avg_streak: Math.round(aggregates._avg.daily_streak ?? 0),
  };
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/users — the filterable, paginated roster table.
//
// Query params (all optional):
//   search        — matches hunter_id, name, or email (case-insensitive)
//   rank           — a levels.rank_name value, e.g. "PREDATOR"
//   level          — a range string, e.g. "1-10", "20-30"
//   status         — 'ACTIVE' | 'BANNED'
//   date_preset    — '7d' | '30d' | '90d' | 'all'  (signup date, IST)
//   start_date/end_date — 'YYYY-MM-DD', inclusive custom range; overrides
//                    date_preset when either is given
//   sort_by        — 'signup_date' (default) | 'name' | 'level' | 'streak'
//   page, limit    — pagination (default 1 / 20, limit capped at 100)
// ─────────────────────────────────────────────────────────────

export async function listUsers(query = {}) {
  const {
    search,
    rank,
    level,
    status,
    date_preset: datePreset,
    start_date:  startDate,
    end_date:    endDate,
    sort_by:     sortBy = 'signup_date',
  } = query;

  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

  const where = {};

  if (search && search.trim()) {
    const term = search.trim();
    where.OR = [
      { hunter_id: { contains: term, mode: 'insensitive' } },
      { name:      { contains: term, mode: 'insensitive' } },
      { email:     { contains: term, mode: 'insensitive' } },
    ];
  }

  if (status) {
    const normalized = status.toUpperCase();
    if (!STATUSES.includes(normalized)) throw new Error('INVALID_STATUS');
    where.is_banned = normalized === 'BANNED';
  }

  // Both `rank` and `level` narrow user_progression.current_level — when
  // both are given, intersect them into one gte/lte/in filter rather than
  // letting a second assignment clobber the first.
  let currentLevelFilter = null;

  if (rank) {
    const levelsForRank = await prisma.levels.findMany({
      where:  { rank_name: rank },
      select: { level_number: true },
    });
    if (levelsForRank.length === 0) throw new Error('INVALID_RANK');
    currentLevelFilter = { in: levelsForRank.map((l) => l.level_number) };
  }

  if (level) {
    const range = parseLevelRange(level); // throws INVALID_LEVEL_RANGE
    currentLevelFilter = currentLevelFilter
      ? { in: (currentLevelFilter.in ?? []).filter((n) => n >= range.gte && n <= range.lte) }
      : range;
  }

  if (currentLevelFilter) {
    where.user_progression = { current_level: currentLevelFilter };
  }

  const dateRange = resolveDateRange({ datePreset, startDate, endDate }); // throws INVALID_*_DATE
  if (dateRange) where.created_at = dateRange;

  const orderBy = SORTABLE[sortBy];
  if (!orderBy) throw new Error('INVALID_SORT_BY');

  const [total, users, levels] = await Promise.all([
    prisma.users.count({ where }),
    prisma.users.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id:         true,
        hunter_id:  true,
        name:       true,
        email:      true,
        is_banned:  true,
        created_at: true,
        avatars:    { select: { image_url: true } },
        auth_providers: { select: { provider: true } },
        user_progression: {
          select: { current_level: true, daily_streak: true, longest_streak: true },
        },
      },
    }),
    // Small, rarely-changing table (100 rows) — fetched once per page to
    // map current_level -> rank_name without a raw join.
    prisma.levels.findMany({ select: { level_number: true, rank_name: true } }),
  ]);

  const rankByLevel = new Map(levels.map((l) => [l.level_number, l.rank_name]));

  const items = users.map((u) => ({
    id:              u.id.toString(),
    hunter_id:       u.hunter_id,
    name:            u.name,
    email:           u.email,
    avatar_url:      u.avatars?.image_url ?? null,
    level:           u.user_progression?.current_level ?? 1,
    rank:            rankByLevel.get(u.user_progression?.current_level ?? 1) ?? null,
    streak:          u.user_progression?.daily_streak ?? 0,
    longest_streak:  u.user_progression?.longest_streak ?? 0,
    status:          u.is_banned ? 'BANNED' : 'ACTIVE',
    signup_date:     u.created_at,
    auth_providers:  u.auth_providers.map((p) => p.provider),
  }));

  return {
    users: items,
    pagination: {
      page,
      limit,
      total_count: total,
      total_pages: Math.ceil(total / limit) || 0,
      has_next_page: page * limit < total,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// GET /api/admin/users/:id — everything the admin User Detail screen
// renders: the list-row fields plus XP, dragon stage, body stats, and the
// Activity / Badges / Rewards / Feedback tabs.
//
// activity_log is one newest-first feed (capped — a glance view, not an
// audit export) merging task_completions with admin_user_actions (ban /
// unban / streak reset). Every entry has a `type` discriminator plus
// `title` + `occurred_at`; the remaining fields depend on the type. feedback merges the user's feedback
// tickets with their single app_ratings row (if any), newest first.
// ─────────────────────────────────────────────────────────────

const ACTIVITY_LOG_LIMIT = 50;

const ADMIN_ACTION_TITLES = {
  BAN:          'Banned by admin',
  UNBAN:        'Unbanned by admin',
  STREAK_RESET: 'Streak reset by admin',
};

const FEEDBACK_SUBJECTS = {
  bug_report: 'Bug report',
  suggestion: 'Suggestion',
  other:      'Other',
};

export async function getUserDetail(id) {
  const userId = parseUserId(id);

  const user = await prisma.users.findUnique({
    where: { id: userId },
    select: {
      id:           true,
      hunter_id:    true,
      name:         true,
      email:        true,
      role:         true,
      is_banned:    true,
      ban_reason:   true,
      banned_at:    true,
      height_cm:    true,
      weight_kg:    true,
      bmi:          true,
      dragon_stage: true,
      created_at:   true,
      avatars:        { select: { image_url: true } },
      auth_providers: { select: { provider: true } },
      user_progression: {
        select: { total_xp: true, current_level: true, daily_streak: true, longest_streak: true },
      },
      task_completions: {
        orderBy: { completed_at: 'desc' },
        take:    ACTIVITY_LOG_LIMIT,
        select: {
          id: true, status: true, xp_earned: true, completed_at: true, schedule_date: true,
          tasks: { select: { title: true } },
        },
      },
      user_badges: {
        orderBy: { earned_at: 'desc' },
        select: {
          id: true, earned_at: true,
          badges: { select: { name: true, description: true, image_url: true, badge_type: true } },
        },
      },
      user_rewards: {
        orderBy: { assigned_at: 'desc' },
        select: {
          id: true, status: true, trigger_type: true, assigned_at: true, claimed_at: true, expires_at: true,
          reward_text: true, coupon_code: true, scratched_at: true,
          reward_coupons: { select: { title: true } },
          reward_pool: {
            select: {
              description: true,
              reward_partners: { select: { name: true } },
            },
          },
        },
      },
      feedback: {
        orderBy: { created_at: 'desc' },
        select: { id: true, category: true, message: true, status: true, created_at: true },
      },
      app_ratings: {
        select: { id: true, stars: true, category: true, comment: true, created_at: true, updated_at: true },
      },
      admin_actions_received: {
        orderBy: { created_at: 'desc' },
        take:    ACTIVITY_LOG_LIMIT,
        select: {
          id: true, action: true, reason: true, details: true, created_at: true,
          admin: { select: { id: true, name: true } },
        },
      },
    },
  });

  if (!user) throw new Error('USER_NOT_FOUND');

  const level = user.user_progression?.current_level ?? 1;
  const levelRow = await prisma.levels.findUnique({
    where:  { level_number: level },
    select: { rank_name: true },
  });

  const feedback = user.feedback.map((f) => ({
    id:         `feedback-${f.id}`,
    subject:    FEEDBACK_SUBJECTS[f.category] ?? f.category,
    message:    f.message,
    rating:     null,
    status:     f.status,
    created_at: f.created_at,
  }));

  const taskEntries = user.task_completions.map((c) => ({
    id:            `task-${c.id}`,
    type:          'TASK_COMPLETION',
    title:         c.tasks?.title ?? 'Task',
    occurred_at:   c.completed_at,
    task_title:    c.tasks?.title ?? 'Task',
    status:        c.status, // COMPLETED | PARTIAL | SKIPPED
    xp_earned:     c.xp_earned,
    schedule_date: c.schedule_date,
    completed_at:  c.completed_at,
  }));

  const adminEntries = user.admin_actions_received.map((a) => ({
    id:           `admin-${a.id}`,
    type:         a.action, // BAN | UNBAN | STREAK_RESET
    title:        ADMIN_ACTION_TITLES[a.action] ?? a.action,
    occurred_at:  a.created_at,
    reason:       a.reason,
    details:      a.details ?? null,
    performed_by: a.admin ? { id: a.admin.id.toString(), name: a.admin.name } : null,
  }));

  const activityLog = [...taskEntries, ...adminEntries]
    .sort((x, y) => new Date(y.occurred_at ?? 0) - new Date(x.occurred_at ?? 0))
    .slice(0, ACTIVITY_LOG_LIMIT);

  if (user.app_ratings) {
    const r = user.app_ratings;
    feedback.push({
      id:         `rating-${r.id}`,
      subject:    r.category ? `App rating · ${r.category}` : 'App rating',
      message:    r.comment ?? '',
      rating:     r.stars,
      status:     'resolved',
      created_at: r.updated_at ?? r.created_at,
    });
    feedback.sort((a, b) => new Date(b.created_at ?? 0) - new Date(a.created_at ?? 0));
  }

  return {
    id:             user.id.toString(),
    hunter_id:      user.hunter_id,
    name:           user.name,
    email:          user.email,
    role:           user.role,
    avatar_url:     user.avatars?.image_url ?? null,
    level,
    rank:           levelRow?.rank_name ?? null,
    xp:             user.user_progression?.total_xp ?? 0,
    streak:         user.user_progression?.daily_streak ?? 0,
    longest_streak: user.user_progression?.longest_streak ?? 0,
    dragon_stage:   user.dragon_stage,
    height_cm:      user.height_cm ?? 0,
    weight_kg:      user.weight_kg ?? 0,
    bmi:            user.bmi ?? 0,
    status:         user.is_banned ? 'BANNED' : 'ACTIVE',
    ban_reason:     user.ban_reason,
    banned_at:      user.banned_at,
    signup_date:    user.created_at,
    auth_providers: user.auth_providers.map((p) => p.provider),

    activity_log: activityLog,

    badges: user.user_badges.map((ub) => ({
      id:          ub.id.toString(),
      name:        ub.badges.name,
      description: ub.badges.description ?? '',
      image_url:   ub.badges.image_url ?? null,
      badge_type:  ub.badges.badge_type,
      earned_at:   ub.earned_at,
    })),

    reward_claims: user.user_rewards.map((r) => {
      // Admins see the prize even on an unscratched card; one still
      // waiting on stock has none yet.
      const partner = r.reward_coupons?.title ?? r.reward_pool?.reward_partners?.name;
      const value   = r.reward_text;
      return {
        id:           r.id.toString(),
        reward_name:  [partner, value].filter(Boolean).join(' · ') || r.reward_pool?.description || (r.coupon_code ? 'Reward' : 'Scratch card (awaiting stock)'),
        type:         'coupon',
        status:       r.status, // ACTIVE | CLAIMED | EXPIRED
        trigger_type: r.trigger_type,
        assigned_at:  r.assigned_at,
        claimed_at:   r.claimed_at,
        expires_at:   r.expires_at,
      };
    }),

    feedback_tickets: feedback,
  };
}

// ─────────────────────────────────────────────────────────────
// PATCH /api/admin/users/:id/ban and /unban.
//
// Banning only flips users.is_banned — every enforcement point already
// keys off that flag: verifyToken rejects every authenticated request with
// 403 (it re-reads the user from the DB per request, so existing access
// tokens die immediately, not at expiry), email/Google/Apple login and
// token refresh all throw ACCOUNT_BANNED, and leaderboards, broadcasts and
// the notification crons all filter is_banned users out. The Redis
// leaderboard is the one cached copy, so it's re-synced right after.
//
// No data is deleted: progression, history and rewards are kept intact,
// so an unban restores the account exactly as it was. Each ban/unban also
// appends an admin_user_actions row (the history shown in Activity).
// ─────────────────────────────────────────────────────────────

const BAN_REASON_MAX = 500;

function parseUserId(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('INVALID_USER_ID');
  return BigInt(id);
}

export async function banUser(adminUserId, id, reason) {
  const userId = parseUserId(id);
  if (userId === BigInt(adminUserId)) throw new Error('CANNOT_BAN_SELF');

  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (trimmedReason.length > BAN_REASON_MAX) throw new Error('BAN_REASON_TOO_LONG');

  const user = await prisma.users.findUnique({
    where:  { id: userId },
    select: { role: true, is_banned: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.role === 'ADMIN') throw new Error('CANNOT_BAN_ADMIN');
  if (user.is_banned) throw new Error('ALREADY_BANNED');

  await prisma.$transaction([
    prisma.users.update({
      where: { id: userId },
      data: {
        is_banned:  true,
        ban_reason: trimmedReason || null,
        banned_at:  new Date(),
        banned_by:  BigInt(adminUserId),
      },
    }),
    prisma.admin_user_actions.create({
      data: { user_id: userId, admin_id: BigInt(adminUserId), action: 'BAN', reason: trimmedReason || null },
    }),
  ]);

  await syncLeaderboardMember(userId); // drops them from global
  await notifyAccountUpdate(
    userId, 'ACCOUNT_BANNED',
    'Your account has been suspended',
    `${trimmedReason ? `Reason: ${trimmedReason}. ` : ''}Contact support if you think this is a mistake.`
  );
  info(`Admin ${adminUserId} banned user ${userId}${trimmedReason ? ` (reason: ${trimmedReason})` : ''}`);

  return getUserDetail(userId.toString());
}

export async function unbanUser(adminUserId, id) {
  const userId = parseUserId(id);

  const user = await prisma.users.findUnique({
    where:  { id: userId },
    select: { is_banned: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (!user.is_banned) throw new Error('NOT_BANNED');

  await prisma.$transaction([
    prisma.users.update({
      where: { id: userId },
      data:  { is_banned: false, ban_reason: null, banned_at: null, banned_by: null },
    }),
    prisma.admin_user_actions.create({
      data: { user_id: userId, admin_id: BigInt(adminUserId), action: 'UNBAN' },
    }),
  ]);

  await syncLeaderboardMember(userId); // re-adds them if otherwise eligible
  await notifyAccountUpdate(
    userId, 'ACCOUNT_UNBANNED',
    'Your account is active again',
    'Welcome back, Hunter. Your quests and progress are right where you left them.'
  );
  info(`Admin ${adminUserId} unbanned user ${userId}`);

  return getUserDetail(userId.toString());
}

// ─────────────────────────────────────────────────────────────
// POST /api/admin/users/:id/reset-streak — sets the current daily streak
// to 0, the same end state as the user choosing 'DROP' on the streak-at-
// risk prompt (streakService.resolveStreakRisk): last_active_date is
// cleared so their next completion starts a fresh streak at 1.
// longest_streak and banked streak_lives are left untouched. Leaderboard
// score is XP-only, so no re-sync is needed.
// ─────────────────────────────────────────────────────────────

export async function resetUserStreak(adminUserId, id) {
  const userId = parseUserId(id);

  const progression = await prisma.user_progression.findUnique({
    where:  { user_id: userId },
    select: { daily_streak: true },
  });
  if (!progression) {
    const exists = await prisma.users.findUnique({ where: { id: userId }, select: { id: true } });
    throw new Error(exists ? 'NO_PROGRESSION' : 'USER_NOT_FOUND');
  }

  await prisma.$transaction([
    prisma.user_progression.update({
      where: { user_id: userId },
      data: {
        daily_streak:          0,
        consecutive_miss_days: 0,
        last_active_date:      null,
      },
    }),
    prisma.admin_user_actions.create({
      data: {
        user_id:  userId,
        admin_id: BigInt(adminUserId),
        action:   'STREAK_RESET',
        details:  { previous_streak: progression.daily_streak },
      },
    }),
  ]);

  info(`Admin ${adminUserId} reset streak for user ${userId} (was ${progression.daily_streak})`);
  if (progression.daily_streak > 0) {
    await notifyAccountUpdate(
      userId, 'STREAK_RESET',
      'Your streak was reset',
      `Your ${progression.daily_streak}-day streak was reset by the team. Clear a quest today to start a new one.`,
      { previous_streak: progression.daily_streak }
    );
  }

  return getUserDetail(userId.toString());
}

// ─────────────────────────────────────────────────────────────
// Create an ADMIN-role account. Only reachable via POST /api/admin/admins,
// which is itself gated by verifyToken + verifyAdmin — so this can only
// ever be called by someone who is already an admin. There's no public
// or self-service path to ADMIN: the very first admin is seeded at
// deploy time (adminBootstrapService.js), and every one after that is
// created by an existing admin through this endpoint. A compromised
// non-admin account can't reach this at all; a compromised admin account
// already has full admin access regardless, so this grants it nothing
// further an attacker didn't already have.
// ─────────────────────────────────────────────────────────────

export async function createAdmin(creatorUserId, { name, email, password }) {
  if (!name || typeof name !== 'string' || !name.trim()) throw new Error('NAME_REQUIRED');

  const normalizedEmail = (email || '').trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) throw new Error('INVALID_EMAIL');

  const { valid, errors } = isStrongPassword(password);
  if (!valid) {
    const err = new Error('WEAK_PASSWORD');
    err.errors = errors;
    throw err;
  }

  const existing = await prisma.users.findUnique({ where: { email: normalizedEmail } });
  if (existing) throw new Error('EMAIL_EXISTS');

  const salt         = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(password, salt);

  const user = await prisma.users.create({
    data: {
      hunter_id:       await generateHunterId(),
      name:            name.trim(),
      email:           normalizedEmail,
      password_hash:   passwordHash,
      referral_code:   generateReferralCode(),
      role:            'ADMIN',
      onboarding_done: true,
    },
  });

  await prisma.auth_providers.create({
    data: { user_id: user.id, provider: 'EMAIL', provider_id: normalizedEmail },
  });

  await prisma.user_progression.create({ data: { user_id: user.id } });

  info(`Admin ${creatorUserId} created new admin account (id: ${user.id}, email: ${normalizedEmail})`);

  return {
    id:         user.id.toString(),
    hunter_id:  user.hunter_id,
    name:       user.name,
    email:      user.email,
    role:       user.role,
    created_at: user.created_at,
  };
}
