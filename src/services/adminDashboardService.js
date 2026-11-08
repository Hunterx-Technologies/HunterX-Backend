// src/services/adminDashboardService.js — data for the admin Dashboard page
// (HunterX-Admin app/(dashboard)/page.tsx, shapes in types/dashboard.ts).
//
// Every "day" here is an IST calendar day, matching the rest of the app.
// @db.Date columns (schedule_date, last_active_date) already hold IST dates;
// timestamp columns are UTC, so they are shifted by +5:30 before bucketing.
//
// Things the schema doesn't record, and how they're handled:
//   • Subscription prices — no price column, so PLAN_MONTHLY_PRICE below is
//     the source for MRR / transaction amounts. Keep it in sync with the stores.
//   • Trials — a trial is a subscriptions row with plan = 'trial'. A trial
//     "converted" when the same user later has a non-trial row.
//   • Referral link shares — not tracked anywhere, so "links sent" is the
//     number of referral signups (every signup used a link) until a share
//     event is recorded.

import prisma from '../config/prisma.js';
import { getISTDateOnly } from '../utils/helpers.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Monthly-equivalent price per plan, USD (the dashboard shows "$").
export const PLAN_MONTHLY_PRICE = {
  monthly: 9.99,
  yearly:  79.99 / 12,
};
const PLAN_CHARGE = { monthly: 9.99, yearly: 79.99 };
const PLATFORM_LABEL = { IOS: 'App Store', ANDROID: 'Google Play', WEB: 'Web' };
const TRIAL_PLAN = 'trial';

// ── date helpers ───────────────────────────────────────────
const istDayStartUtc = (offsetDays = 0) => new Date(getISTDateOnly(offsetDays).getTime() - IST_OFFSET_MS);
const istKey  = (d) => new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const dateKey = (d) => d.toISOString().slice(0, 10);
const round1  = (n) => Math.round(n * 10) / 10;
const pct     = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : 0);
// % change today vs yesterday; a rise from 0 counts as +100%.
const delta   = (now, before) => (before > 0 ? round1(((now - before) / before) * 100) : now > 0 ? 100 : 0);
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const displayName = (u) => u?.name?.trim() || u?.hunter_id || 'Unknown';

const isPaidPlan = (s) => s.plan !== TRIAL_PLAN;
const monthlyValue = (s) => PLAN_MONTHLY_PRICE[s.plan] ?? PLAN_MONTHLY_PRICE.monthly;

// A paid subscription is earning on `at` if it started, hasn't been
// cancelled, and hasn't lapsed by then.
function isEarningAt(s, at) {
  return isPaidPlan(s)
    && s.started_at <= at
    && s.expires_at > at
    && (!s.cancelled_at || s.cancelled_at > at)
    && (s.status === 'ACTIVE' || s.status === 'CANCELLED' || s.status === 'EXPIRED');
}

const OPEN_FEEDBACK = { status: { in: ['received', 'in_review'] } };

// Counts are done in the database rather than by loading every row. Dates
// and timestamps are passed as plain text so the database session's time
// zone can't shift them (timestamp columns hold UTC).
const sqlDate = (d) => dateKey(d);                               // 'YYYY-MM-DD'
const sqlUtcTimestamp = (d) => d.toISOString().replace('Z', ''); // UTC, no zone

async function countActiveUsersOn(day) {
  const [row] = await prisma.$queryRaw`
    SELECT COUNT(DISTINCT user_id)::int AS n FROM task_completions WHERE schedule_date = ${sqlDate(day)}::date`;
  return row.n;
}

// ── KPI strip ─────────────────────────────────────────────
export async function getCoreKpis() {
  const today = getISTDateOnly();
  const yesterday = getISTDateOnly(-1);
  const todayStart = istDayStartUtc(0);
  const yesterdayStart = istDayStartUtc(-1);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS);

  const [
    totalUsers, usersBeforeToday,
    activeToday, activeYesterday,
    signupsToday, signupsYesterday,
    subs,
    doneToday, doneYesterday,
    openFeedback, openFeedbackYesterday,
  ] = await Promise.all([
    prisma.users.count(),
    prisma.users.count({ where: { created_at: { lt: todayStart } } }),
    countActiveUsersOn(today),
    countActiveUsersOn(yesterday),
    prisma.users.count({ where: { created_at: { gte: todayStart } } }),
    prisma.users.count({ where: { created_at: { gte: yesterdayStart, lt: todayStart } } }),
    prisma.subscriptions.findMany({ select: { plan: true, status: true, started_at: true, expires_at: true, cancelled_at: true } }),
    prisma.task_completions.count({ where: { schedule_date: today, status: 'COMPLETED' } }),
    prisma.task_completions.count({ where: { schedule_date: yesterday, status: 'COMPLETED' } }),
    prisma.feedback.count({ where: OPEN_FEEDBACK }),
    prisma.feedback.count({ where: { ...OPEN_FEEDBACK, created_at: { lt: todayStart } } }),
  ]);

  const activeSubsNow = subs.filter((s) => isEarningAt(s, now)).length;
  const activeSubsDayAgo = subs.filter((s) => isEarningAt(s, dayAgo)).length;

  return {
    totalUsers,
    activeToday,
    newSignupsToday: signupsToday,
    activeSubscriptions: activeSubsNow,
    tasksCompletedToday: doneToday,
    openFeedbackTickets: openFeedback,
    totalUsersDelta: delta(totalUsers, usersBeforeToday),
    activeTodayDelta: delta(activeToday, activeYesterday),
    newSignupsTodayDelta: delta(signupsToday, signupsYesterday),
    activeSubscriptionsDelta: delta(activeSubsNow, activeSubsDayAgo),
    tasksCompletedTodayDelta: delta(doneToday, doneYesterday),
    openFeedbackTicketsDelta: delta(openFeedback, openFeedbackYesterday),
  };
}

// ── Subscription & Revenue ────────────────────────────────
export async function getSubscriptionOverview() {
  const now = new Date();
  const todayStart = istDayStartUtc(0);
  const weekStart = istDayStartUtc(-6);

  const subs = await prisma.subscriptions.findMany({
    select: { user_id: true, plan: true, status: true, started_at: true, expires_at: true, cancelled_at: true },
  });

  const earning = subs.filter((s) => isEarningAt(s, now));
  const paid = subs.filter(isPaidPlan);
  const mrr = earning.reduce((sum, s) => sum + monthlyValue(s), 0);

  const trialUsers = new Set(subs.filter((s) => s.plan === TRIAL_PLAN).map((s) => String(s.user_id)));
  const paidUsers = new Set(paid.map((s) => String(s.user_id)));
  const converted = [...trialUsers].filter((id) => paidUsers.has(id)).length;

  const trialing = subs.filter((s) => s.plan === TRIAL_PLAN && s.status === 'TRIAL' && s.expires_at > now).length;
  // Paid, not cancelled, but the period ran out without a renewal.
  const pastDue = paid.filter((s) => s.status !== 'CANCELLED' && s.expires_at <= now).length;
  const canceled = paid.filter((s) => s.status === 'CANCELLED').length;

  return {
    mrr: Math.round(mrr * 100) / 100,
    activeSubscribers: new Set(earning.map((s) => String(s.user_id))).size,
    newSubsToday: paid.filter((s) => s.started_at >= todayStart).length,
    newSubsWeek: paid.filter((s) => s.started_at >= weekStart).length,
    churnedThisWeek: subs.filter((s) => s.cancelled_at && s.cancelled_at >= weekStart).length,
    trialToPaidPct: pct(converted, trialUsers.size),
    statusBreakdown: [
      { status: 'Active', count: earning.filter((s) => s.status === 'ACTIVE').length },
      { status: 'Trialing', count: trialing },
      { status: 'Past Due', count: pastDue },
      { status: 'Canceled', count: canceled },
    ],
  };
}

export async function getMrrTrend(days = 90) {
  const subs = await prisma.subscriptions.findMany({
    where: { plan: { not: TRIAL_PLAN } },
    select: { plan: true, status: true, started_at: true, expires_at: true, cancelled_at: true },
  });
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    // Value at the end of each IST day (today: right now).
    const at = i === 0 ? new Date() : new Date(istDayStartUtc(-i + 1).getTime() - 1);
    const value = subs.filter((s) => isEarningAt(s, at)).reduce((sum, s) => sum + monthlyValue(s), 0);
    points.push({ date: dateKey(getISTDateOnly(-i)), value: Math.round(value * 100) / 100 });
  }
  return points;
}

// Subscription charges + one-off task purchases, newest first.
export async function getRecentTransactions(limit = 10) {
  const [subs, purchases] = await Promise.all([
    prisma.subscriptions.findMany({
      where: { plan: { not: TRIAL_PLAN } },
      orderBy: { started_at: 'desc' },
      take: limit,
      select: { id: true, plan: true, status: true, platform: true, started_at: true, users: { select: { name: true, hunter_id: true } } },
    }),
    prisma.task_purchases.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true, amount: true, currency: true, status: true, payment_provider: true, paid_at: true, created_at: true,
        users: { select: { name: true, hunter_id: true } },
        tasks: { select: { title: true } },
      },
    }),
  ]);

  const rows = [
    ...subs.map((s) => ({
      id: `sub_${s.id}`,
      userName: displayName(s.users),
      plan: `${titleCase(s.plan)} subscription`,
      amount: PLAN_CHARGE[s.plan] ?? PLAN_CHARGE.monthly,
      status: 'paid',
      date: s.started_at.toISOString(),
      method: PLATFORM_LABEL[s.platform] ?? s.platform,
    })),
    ...purchases.map((p) => ({
      id: `pur_${p.id}`,
      userName: displayName(p.users),
      plan: p.tasks?.title ?? 'Task purchase',
      amount: Number(p.amount),
      status: p.status.toLowerCase(),
      date: (p.paid_at ?? p.created_at ?? new Date()).toISOString(),
      method: p.payment_provider ?? '—',
    })),
  ];
  return rows.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

// ── Referrals ─────────────────────────────────────────────
async function paidUserIds() {
  const rows = await prisma.subscriptions.findMany({
    where: { plan: { not: TRIAL_PLAN } },
    distinct: ['user_id'],
    select: { user_id: true },
  });
  return new Set(rows.map((r) => String(r.user_id)));
}

export async function getReferralOverview() {
  const [referrals, paid] = await Promise.all([
    prisma.referrals.findMany({ select: { referred_id: true } }),
    paidUserIds(),
  ]);
  const referred = new Set(referrals.map((r) => String(r.referred_id)));
  const converted = [...referred].filter((id) => paid.has(id)).length;
  return {
    totalLinksSent: referrals.length,
    successfulSignups: referred.size,
    referralToPaidPct: pct(converted, referred.size),
  };
}

export async function getTopReferrers(limit = 10) {
  const [referrals, paid] = await Promise.all([
    prisma.referrals.findMany({
      select: { referred_id: true, users_referrals_referrer_idTousers: { select: { id: true, name: true, hunter_id: true } } },
    }),
    paidUserIds(),
  ]);
  const byReferrer = new Map();
  for (const r of referrals) {
    const u = r.users_referrals_referrer_idTousers;
    const key = String(u.id);
    const row = byReferrer.get(key) ?? { userId: key, userName: displayName(u), linksSent: 0, signups: 0, paidConversions: 0 };
    row.linksSent += 1;
    row.signups += 1;
    if (paid.has(String(r.referred_id))) row.paidConversions += 1;
    byReferrer.set(key, row);
  }
  return [...byReferrer.values()]
    .sort((a, b) => b.signups - a.signups || b.paidConversions - a.paidConversions)
    .slice(0, limit);
}

export async function getRecentReferralActivity(limit = 10) {
  const [referrals, paid] = await Promise.all([
    prisma.referrals.findMany({
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true, created_at: true, referred_id: true,
        users_referrals_referrer_idTousers: { select: { name: true, hunter_id: true } },
        users_referrals_referred_idTousers: { select: { name: true, hunter_id: true, onboarding_done: true } },
      },
    }),
    paidUserIds(),
  ]);
  return referrals.map((r) => {
    const referee = r.users_referrals_referred_idTousers;
    return {
      id: String(r.id),
      referrerName: displayName(r.users_referrals_referrer_idTousers),
      refereeName: displayName(referee),
      // converted = paying; signed_up = finished onboarding; pending = account only
      status: paid.has(String(r.referred_id)) ? 'converted' : referee.onboarding_done ? 'signed_up' : 'pending',
      date: (r.created_at ?? new Date()).toISOString(),
    };
  });
}

// ── Rewards & Coupons ─────────────────────────────────────
// A "coupon" is a user_rewards card. Tiers are the card rarity.
const RARITIES = ['common', 'rare', 'epic', 'legendary'];

function couponState(r, now) {
  if (r.status === 'CLAIMED') return 'used';
  if (r.status === 'EXPIRED' || (r.expires_at && r.expires_at <= now)) return 'expired';
  return 'unused';
}

export async function getCouponOverview() {
  const now = new Date();
  // Same states as couponState(), counted per rarity in the database.
  const groups = await prisma.$queryRaw`
    SELECT rarity::text AS rarity,
           CASE WHEN status::text = 'CLAIMED' THEN 'used'
                WHEN status::text = 'EXPIRED' OR (expires_at IS NOT NULL AND expires_at <= ${sqlUtcTimestamp(now)}::timestamp) THEN 'expired'
                ELSE 'unused' END AS state,
           COUNT(*)::int AS n
    FROM user_rewards
    GROUP BY 1, 2`;

  const byTier = new Map(RARITIES.map((t) => [t, { tier: titleCase(t), used: 0, unused: 0, expired: 0 }]));
  const totals = { used: 0, unused: 0, expired: 0 };
  let issued = 0;
  for (const g of groups) {
    issued += g.n;
    totals[g.state] += g.n;
    const tier = byTier.get(g.rarity) ?? byTier.set(g.rarity, { tier: titleCase(g.rarity), used: 0, unused: 0, expired: 0 }).get(g.rarity);
    tier[g.state] += g.n;
  }

  return {
    issued,
    redeemed: totals.used,
    unredeemed: totals.unused,
    expired: totals.expired,
    redemptionRatePct: pct(totals.used, issued),
    byTier: [...byTier.values()],
  };
}

export async function getCouponActivityLog(limit = 25) {
  const now = new Date();
  const rewards = await prisma.user_rewards.findMany({
    orderBy: { assigned_at: 'desc' },
    take: 200,
    select: {
      id: true, status: true, coupon_code: true, reward_text: true, assigned_at: true, claimed_at: true, expires_at: true,
      users: { select: { name: true, hunter_id: true } },
      reward_coupons: { select: { title: true, product_name: true } },
      reward_pool: { select: { reward_partners: { select: { name: true } } } },
    },
  });

  const events = [];
  for (const r of rewards) {
    const base = {
      code: r.coupon_code ?? '—',
      partner: r.reward_pool?.reward_partners?.name ?? r.reward_coupons?.product_name ?? r.reward_coupons?.title ?? r.reward_text ?? 'HunterX',
      userName: displayName(r.users),
    };
    if (r.assigned_at) events.push({ ...base, id: `${r.id}_issued`, action: 'issued', date: r.assigned_at.toISOString() });
    if (r.status === 'CLAIMED' && r.claimed_at) events.push({ ...base, id: `${r.id}_redeemed`, action: 'redeemed', date: r.claimed_at.toISOString() });
    if (couponState(r, now) === 'expired' && r.expires_at) events.push({ ...base, id: `${r.id}_expired`, action: 'expired', date: r.expires_at.toISOString() });
  }
  return events.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

// ── Engagement Health ─────────────────────────────────────
// A user is "active" on a day if they logged progress on any task that day.
export async function getDauTrend(days = 30) {
  const since = getISTDateOnly(-(days - 1));
  const rows = await prisma.$queryRaw`
    SELECT schedule_date::text AS day, COUNT(DISTINCT user_id)::int AS n
    FROM task_completions
    WHERE schedule_date >= ${sqlDate(since)}::date
    GROUP BY schedule_date`;
  const perDay = new Map(rows.map((r) => [r.day, r.n]));
  const points = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dateKey(getISTDateOnly(-i));
    points.push({ date: k, value: perDay.get(k) ?? 0 });
  }
  return points;
}

export async function getRankDistribution() {
  const [levels, perLevel] = await Promise.all([
    prisma.levels.findMany({ select: { level_number: true, rank_name: true }, orderBy: { level_number: 'asc' } }),
    prisma.user_progression.groupBy({ by: ['current_level'], _count: { _all: true } }),
  ]);
  const rankByLevel = new Map(levels.map((l) => [l.level_number, l.rank_name]));
  const order = [];
  for (const l of levels) if (l.rank_name && !order.includes(l.rank_name)) order.push(l.rank_name);
  const counts = new Map(order.map((r) => [r, 0]));
  for (const p of perLevel) {
    const rank = rankByLevel.get(p.current_level) ?? order[0];
    if (rank) counts.set(rank, (counts.get(rank) ?? 0) + p._count._all);
  }
  return order.map((rank) => ({ rank: titleCase(rank), users: counts.get(rank) }));
}

// How many hunters kept an unbroken daily run from their signup day:
// day N = users who completed at least one task on each of their first N
// days. Only users who have been around N days count toward day N.
export async function getStreakDropoff(maxDays = 14) {
  const [users, completions] = await Promise.all([
    prisma.users.findMany({ where: { role: 'USER' }, select: { id: true, created_at: true } }),
    // Only each user's first maxDays IST days after signup matter — not
    // their whole history.
    prisma.$queryRaw`
      SELECT c.user_id, c.schedule_date::text AS day
      FROM task_completions c
      JOIN users u ON u.id = c.user_id
      WHERE c.status::text IN ('COMPLETED', 'PARTIAL')
        AND u.created_at IS NOT NULL
        AND c.schedule_date >= (u.created_at + interval '330 minutes')::date
        AND c.schedule_date <  (u.created_at + interval '330 minutes')::date + ${maxDays}::int`,
  ]);
  const daysByUser = new Map();
  for (const c of completions) {
    const k = String(c.user_id);
    if (!daysByUser.has(k)) daysByUser.set(k, new Set());
    daysByUser.get(k).add(c.day);
  }

  const todayMs = getISTDateOnly().getTime();
  const remaining = Array(maxDays).fill(0);
  for (const u of users) {
    if (!u.created_at) continue;
    const signupMs = Date.parse(`${istKey(u.created_at)}T00:00:00Z`);
    const ageDays = Math.floor((todayMs - signupMs) / DAY_MS) + 1; // signup day counts as day 1
    const done = daysByUser.get(String(u.id)) ?? new Set();
    for (let d = 1; d <= Math.min(maxDays, ageDays); d++) {
      if (!done.has(dateKey(new Date(signupMs + (d - 1) * DAY_MS)))) break;
      remaining[d - 1] += 1;
    }
  }
  return remaining.map((usersRemaining, i) => ({ day: i + 1, usersRemaining }));
}

// ── Needs Attention ───────────────────────────────────────
export async function getNeedsAttention() {
  const failedSince = new Date(Date.now() - 30 * DAY_MS);
  const [reviews, feedback, failed, banned] = await Promise.all([
    prisma.task_completions.findMany({
      where: { status: 'IN_REVIEW' },
      orderBy: { proof_submitted_at: 'desc' },
      take: 20,
      select: { id: true, proof_urls: true, proof_submitted_at: true, created_at: true, users: { select: { name: true, hunter_id: true } }, tasks: { select: { title: true } } },
    }),
    prisma.feedback.findMany({
      where: OPEN_FEEDBACK,
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { id: true, category: true, message: true, created_at: true, users: { select: { name: true, hunter_id: true } } },
    }),
    prisma.task_purchases.findMany({
      where: { status: 'FAILED', created_at: { gte: failedSince } },
      orderBy: { created_at: 'desc' },
      take: 20,
      select: { id: true, amount: true, currency: true, payment_provider: true, created_at: true, users: { select: { name: true, hunter_id: true } }, tasks: { select: { title: true } } },
    }),
    prisma.users.findMany({
      where: { is_banned: true },
      orderBy: { banned_at: 'desc' },
      take: 20,
      select: { id: true, name: true, hunter_id: true, ban_reason: true, banned_at: true, created_at: true },
    }),
  ]);

  const iso = (d) => (d ?? new Date()).toISOString();
  const items = [
    ...reviews.map((r) => ({
      id: `att_review_${r.id}`,
      type: 'gps_review',
      title: `Proof to review — ${r.tasks?.title ?? 'Task'}`,
      description: `${displayName(r.users)} sent ${r.proof_urls.length} photo${r.proof_urls.length === 1 ? '' : 's'}`,
      timestamp: iso(r.proof_submitted_at ?? r.created_at),
      href: '/tasks/review',
    })),
    ...feedback.map((f) => ({
      id: `att_fbk_${f.id}`,
      type: 'feedback_ticket',
      title: `${titleCase(f.category.replace(/_/g, ' '))} #${f.id}`,
      description: `${displayName(f.users)}: ${f.message.length > 80 ? `${f.message.slice(0, 80)}…` : f.message}`,
      timestamp: iso(f.created_at),
      href: '/feedback',
    })),
    ...failed.map((p) => ({
      id: `att_txn_${p.id}`,
      type: 'failed_payment',
      title: `Payment failed — ${displayName(p.users)}`,
      description: `${p.tasks?.title ?? 'Task purchase'} · ${p.currency} ${Number(p.amount)} via ${p.payment_provider ?? 'unknown'}`,
      timestamp: iso(p.created_at),
      href: '/subscriptions',
    })),
    ...banned.map((u) => ({
      id: `att_ban_${u.id}`,
      type: 'banned_user',
      title: `Account banned — ${displayName(u)}`,
      description: u.ban_reason ?? 'No reason on file',
      timestamp: iso(u.banned_at ?? u.created_at),
      href: `/users/${u.id}`,
    })),
  ];
  return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
