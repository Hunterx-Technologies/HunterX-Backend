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

import { Prisma } from '@prisma/client';
import prisma from '../config/prisma.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { pageInfo } from '../utils/pageInfo.js';

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

// ── paged lists ────────────────────────────────────────────
// The list widgets (transactions, referrers, referral activity, coupon log,
// needs attention) page and sort in the database: ?page=&limit=&sort=.
// Each one is a SQL "source" with a column `at` (UTC timestamp) and `id`;
// `sort` picks an ORDER BY from a whitelist, the first entry is the default.
const LIST_DEFAULT_LIMIT = 5;
const LIST_MAX_LIMIT = 50;

// UTC timestamp column → ISO string, in SQL, so no driver timezone guessing.
const isoSql = (col) => Prisma.sql`to_char(${col}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const nameSql = (u) => Prisma.sql`COALESCE(NULLIF(BTRIM(${Prisma.raw(u)}.name), ''), ${Prisma.raw(u)}.hunter_id, 'Unknown')`;

function listArgs(query = {}, sorts) {
  const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, parseInt(query.limit) || LIST_DEFAULT_LIMIT));
  const page = Math.max(1, parseInt(query.page) || 1);
  const sort = Object.hasOwn(sorts, query.sort) ? query.sort : Object.keys(sorts)[0];
  return { page, limit, sort, order: sorts[sort] };
}

async function pagedRows(source, { page, limit, order }) {
  const [[{ n }], rows] = await Promise.all([
    prisma.$queryRaw`SELECT COUNT(*)::int AS n FROM (${source}) AS src`,
    prisma.$queryRaw`SELECT * FROM (${source}) AS src ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
  ]);
  return { rows, pagination: pageInfo(page, limit, n) };
}

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

// Subscription charges + one-off task purchases.
// sort: newest | oldest | amount_desc | amount_asc | user
const TRANSACTION_SORTS = {
  newest:      Prisma.sql`at DESC NULLS LAST, id DESC`,
  oldest:      Prisma.sql`at ASC NULLS LAST, id ASC`,
  amount_desc: Prisma.sql`amount DESC, at DESC NULLS LAST, id DESC`,
  amount_asc:  Prisma.sql`amount ASC, at DESC NULLS LAST, id DESC`,
  user:        Prisma.sql`LOWER(user_name) ASC, at DESC NULLS LAST, id DESC`,
};

export async function getRecentTransactions(query = {}) {
  const args = listArgs(query, TRANSACTION_SORTS);
  const source = Prisma.sql`
    SELECT 'sub_' || s.id AS id, ${nameSql('u')} AS user_name, 'sub' AS kind, s.plan AS label,
           (CASE WHEN s.plan = 'yearly' THEN ${PLAN_CHARGE.yearly} ELSE ${PLAN_CHARGE.monthly} END)::numeric AS amount,
           'paid' AS status, s.platform::text AS method, s.started_at AS at
    FROM subscriptions s JOIN users u ON u.id = s.user_id
    WHERE s.plan <> ${TRIAL_PLAN}
    UNION ALL
    SELECT 'pur_' || p.id, ${nameSql('u')}, 'pur', COALESCE(t.title, 'Task purchase'),
           p.amount, LOWER(p.status::text), COALESCE(p.payment_provider, '—'), COALESCE(p.paid_at, p.created_at)
    FROM task_purchases p JOIN users u ON u.id = p.user_id LEFT JOIN tasks t ON t.id = p.task_id`;
  const { rows, pagination } = await pagedRows(
    Prisma.sql`SELECT *, ${isoSql(Prisma.raw('at'))} AS at_iso FROM (${source}) AS tx`,
    args,
  );
  const items = rows.map((r) => ({
    id: r.id,
    userName: r.user_name,
    plan: r.kind === 'sub' ? `${titleCase(r.label)} subscription` : r.label,
    amount: Number(r.amount),
    status: r.status,
    date: r.at_iso ?? new Date().toISOString(),
    method: r.kind === 'sub' ? (PLATFORM_LABEL[r.method] ?? r.method) : r.method,
  }));
  return { items, pagination, sort: args.sort };
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

const PAID_USERS_CTE = Prisma.sql`SELECT DISTINCT user_id FROM subscriptions WHERE plan <> ${TRIAL_PLAN}`;

// sort: paid | signups | name. "Links sent" isn't tracked, so it equals signups.
const REFERRER_SORTS = {
  paid:    Prisma.sql`paid_conversions DESC, signups DESC, LOWER(user_name) ASC, id ASC`,
  signups: Prisma.sql`signups DESC, paid_conversions DESC, LOWER(user_name) ASC, id ASC`,
  name:    Prisma.sql`LOWER(user_name) ASC, id ASC`,
};

export async function getTopReferrers(query = {}) {
  const args = listArgs(query, REFERRER_SORTS);
  const source = Prisma.sql`
    SELECT r.referrer_id AS id, ${nameSql('u')} AS user_name,
           COUNT(*)::int AS signups, COUNT(paid.user_id)::int AS paid_conversions
    FROM referrals r
    JOIN users u ON u.id = r.referrer_id
    LEFT JOIN (${PAID_USERS_CTE}) paid ON paid.user_id = r.referred_id
    GROUP BY r.referrer_id, u.name, u.hunter_id`;
  const { rows, pagination } = await pagedRows(source, args);
  const items = rows.map((r) => ({
    userId: String(r.id),
    userName: r.user_name,
    linksSent: r.signups,
    signups: r.signups,
    paidConversions: r.paid_conversions,
  }));
  return { items, pagination, sort: args.sort };
}

// sort: newest | oldest | referrer
const REFERRAL_ACTIVITY_SORTS = {
  newest:   Prisma.sql`at DESC NULLS LAST, id DESC`,
  oldest:   Prisma.sql`at ASC NULLS LAST, id ASC`,
  referrer: Prisma.sql`LOWER(referrer_name) ASC, at DESC NULLS LAST, id DESC`,
};

export async function getRecentReferralActivity(query = {}) {
  const args = listArgs(query, REFERRAL_ACTIVITY_SORTS);
  // converted = paying; signed_up = finished onboarding; pending = account only
  const source = Prisma.sql`
    SELECT r.id, ${nameSql('ref')} AS referrer_name, ${nameSql('ee')} AS referee_name,
           CASE WHEN paid.user_id IS NOT NULL THEN 'converted'
                WHEN ee.onboarding_done THEN 'signed_up'
                ELSE 'pending' END AS status,
           r.created_at AS at, ${isoSql(Prisma.raw('r.created_at'))} AS at_iso
    FROM referrals r
    JOIN users ref ON ref.id = r.referrer_id
    JOIN users ee  ON ee.id  = r.referred_id
    LEFT JOIN (${PAID_USERS_CTE}) paid ON paid.user_id = r.referred_id`;
  const { rows, pagination } = await pagedRows(source, args);
  const items = rows.map((r) => ({
    id: String(r.id),
    referrerName: r.referrer_name,
    refereeName: r.referee_name,
    status: r.status,
    date: r.at_iso ?? new Date().toISOString(),
  }));
  return { items, pagination, sort: args.sort };
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

// One row per event on a card: issued, redeemed, expired (same states as
// couponState()). sort: newest | oldest | partner | user. ?partner= filters.
const COUPON_SORTS = {
  newest:  Prisma.sql`at DESC NULLS LAST, id DESC`,
  oldest:  Prisma.sql`at ASC NULLS LAST, id ASC`,
  partner: Prisma.sql`LOWER(partner) ASC, at DESC NULLS LAST, id DESC`,
  user:    Prisma.sql`LOWER(user_name) ASC, at DESC NULLS LAST, id DESC`,
};

function couponCards(now) {
  return Prisma.sql`
    SELECT ur.id, COALESCE(ur.coupon_code, '—') AS code,
           COALESCE(pt.name, rc.product_name, rc.title, ur.reward_text, 'HunterX') AS partner,
           ${nameSql('u')} AS user_name, ur.status::text AS status,
           ur.assigned_at, ur.claimed_at, ur.expires_at,
           (ur.status::text <> 'CLAIMED'
             AND (ur.status::text = 'EXPIRED' OR (ur.expires_at IS NOT NULL AND ur.expires_at <= ${sqlUtcTimestamp(now)}::timestamp))) AS is_expired
    FROM user_rewards ur
    JOIN users u ON u.id = ur.user_id
    LEFT JOIN reward_pool rp     ON rp.id = ur.pool_id
    LEFT JOIN reward_partners pt ON pt.id = rp.partner_id
    LEFT JOIN reward_coupons rc  ON rc.id = ur.coupon_id`;
}

export async function getCouponActivityLog(query = {}) {
  const args = listArgs(query, COUPON_SORTS);
  const now = new Date();
  const cards = couponCards(now);
  const partner = typeof query.partner === 'string' && query.partner && query.partner !== 'all' ? query.partner : null;
  const events = Prisma.sql`
    SELECT id || '_issued' AS id, code, partner, user_name, 'issued' AS action, assigned_at AS at FROM cards WHERE assigned_at IS NOT NULL
    UNION ALL
    SELECT id || '_redeemed', code, partner, user_name, 'redeemed', claimed_at FROM cards WHERE status = 'CLAIMED' AND claimed_at IS NOT NULL
    UNION ALL
    SELECT id || '_expired', code, partner, user_name, 'expired', expires_at FROM cards WHERE is_expired AND expires_at IS NOT NULL`;
  const source = Prisma.sql`
    WITH cards AS (${cards}), events AS (${events})
    SELECT *, ${isoSql(Prisma.raw('at'))} AS at_iso FROM events
    ${partner ? Prisma.sql`WHERE partner = ${partner}` : Prisma.empty}`;

  const [{ rows, pagination }, partnerRows] = await Promise.all([
    pagedRows(source, args),
    prisma.$queryRaw`WITH cards AS (${cards}) SELECT DISTINCT partner FROM cards ORDER BY partner`,
  ]);
  const items = rows.map((r) => ({
    id: r.id,
    code: r.code,
    partner: r.partner,
    userName: r.user_name,
    action: r.action,
    date: r.at_iso ?? new Date().toISOString(),
  }));
  return { items, pagination, sort: args.sort, partners: partnerRows.map((p) => p.partner) };
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
// Proofs to review, open feedback, failed payments (last 30 days), bans.
// sort: newest | oldest | type (failed payments → reviews → feedback → bans).
const ATTENTION_SORTS = {
  newest: Prisma.sql`at DESC NULLS LAST, id DESC`,
  oldest: Prisma.sql`at ASC NULLS LAST, id ASC`,
  type:   Prisma.sql`priority ASC, at DESC NULLS LAST, id DESC`,
};

export async function getNeedsAttention(query = {}) {
  const args = listArgs(query, ATTENTION_SORTS);
  const failedSince = sqlUtcTimestamp(new Date(Date.now() - 30 * DAY_MS));
  const source = Prisma.sql`
    SELECT *, ${isoSql(Prisma.raw('at'))} AS at_iso FROM (
      SELECT 'att_review_' || c.id AS id, 'gps_review' AS type, 1 AS priority, c.id AS ref_id,
             ${nameSql('u')} AS user_name, t.title AS t1, NULL::text AS t2, NULL::text AS t3,
             cardinality(c.proof_urls)::numeric AS n, COALESCE(c.proof_submitted_at, c.created_at) AS at
      FROM task_completions c JOIN users u ON u.id = c.user_id LEFT JOIN tasks t ON t.id = c.task_id
      WHERE c.status = 'IN_REVIEW'
      UNION ALL
      SELECT 'att_fbk_' || f.id, 'feedback_ticket', 2, f.id,
             ${nameSql('u')}, f.category, f.message, NULL, NULL, f.created_at
      FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.status IN ('received', 'in_review')
      UNION ALL
      SELECT 'att_txn_' || p.id, 'failed_payment', 0, p.id,
             ${nameSql('u')}, t.title, p.currency, p.payment_provider, p.amount, p.created_at
      FROM task_purchases p JOIN users u ON u.id = p.user_id LEFT JOIN tasks t ON t.id = p.task_id
      WHERE p.status = 'FAILED' AND p.created_at >= ${failedSince}::timestamp
      UNION ALL
      SELECT 'att_ban_' || u.id, 'banned_user', 3, u.id,
             ${nameSql('u')}, u.ban_reason, NULL, NULL, NULL, COALESCE(u.banned_at, u.created_at)
      FROM users u WHERE u.is_banned
    ) AS att`;
  const { rows, pagination } = await pagedRows(source, args);

  const items = rows.map((r) => {
    const base = { id: r.id, type: r.type, timestamp: r.at_iso ?? new Date().toISOString() };
    switch (r.type) {
      case 'gps_review': {
        const n = Number(r.n ?? 0);
        return { ...base, title: `Proof to review — ${r.t1 ?? 'Task'}`, description: `${r.user_name} sent ${n} photo${n === 1 ? '' : 's'}`, href: '/tasks/review' };
      }
      case 'feedback_ticket':
        return {
          ...base,
          title: `${titleCase(r.t1.replace(/_/g, ' '))} #${r.ref_id}`,
          description: `${r.user_name}: ${r.t2.length > 80 ? `${r.t2.slice(0, 80)}…` : r.t2}`,
          href: '/feedback',
        };
      case 'failed_payment':
        return {
          ...base,
          title: `Payment failed — ${r.user_name}`,
          description: `${r.t1 ?? 'Task purchase'} · ${r.t2} ${Number(r.n)} via ${r.t3 ?? 'unknown'}`,
          href: '/subscriptions',
        };
      default:
        return { ...base, title: `Account banned — ${r.user_name}`, description: r.t1 ?? 'No reason on file', href: `/users/${r.ref_id}` };
    }
  });
  return { items, pagination, sort: args.sort };
}
