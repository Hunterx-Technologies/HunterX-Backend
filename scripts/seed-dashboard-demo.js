// scripts/seed-dashboard-demo.js
// Fills a LOCAL database with demo data so every admin Dashboard widget has
// something to show: users, activity, subscriptions, referrals, reward cards,
// feedback, purchases, proof reviews and bans.
//
// Usage:  node scripts/seed-dashboard-demo.js          (re-seed: clean + insert)
//         node scripts/seed-dashboard-demo.js --clean  (remove demo data only)
//
// Everything it creates is tagged so --clean can remove exactly that:
//   • users with an email ending in @demo.hunterx.test (and all their rows)
//   • reward_coupons whose title starts with "[DEMO]" (created inactive, so
//     the reward engine never hands them to real users)
// Refuses to run unless DATABASE_URL points at localhost.

import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import { getISTDateOnly } from '../src/utils/helpers.js';

const DEMO_DOMAIN = '@demo.hunterx.test';
const DEMO_COUPON_PREFIX = '[DEMO]';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const NAMES = [
  'Arjun Mehta', 'Priya Sharma', 'Rohan Iyer', 'Ananya Rao', 'Kabir Singh', 'Meera Nair', 'Vikram Das',
  'Sneha Kulkarni', 'Aditya Verma', 'Ishita Ghosh', 'Rahul Menon', 'Kavya Reddy', 'Siddharth Jain',
  'Neha Kapoor', 'Varun Pillai', 'Tara Bhat', 'Nikhil Joshi', 'Pooja Desai', 'Aman Gupta', 'Riya Banerjee',
  'Karthik Raman', 'Divya Shetty', 'Harsh Patel', 'Aisha Khan', 'Manav Chopra', 'Shreya Malhotra',
  'Yash Agarwal', 'Lakshmi Krishnan', 'Dev Saxena', 'Zoya Mirza', 'Omkar Pawar', 'Nisha Thomas',
];

// Deterministic PRNG so every re-seed looks the same.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// A UTC instant at IST hour `h` on the IST day `offsetDays` from today.
// Never later than a few minutes ago, so "today" rows don't land in the future.
const istAt = (offsetDays, h = 10, m = 0) => new Date(Math.min(
  getISTDateOnly(offsetDays).getTime() - IST_OFFSET_MS + (h * 60 + m) * 60 * 1000,
  Date.now() - (5 + ((h * 60 + m) % 120)) * 60 * 1000,
));
const daysFromNow = (n) => new Date(Date.now() + n * DAY_MS);

function assertLocalDb() {
  const url = process.env.DATABASE_URL ?? '';
  if (!/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
    throw new Error('DATABASE_URL is not a localhost database — refusing to seed demo data.');
  }
}

async function clean() {
  const users = await prisma.users.findMany({ where: { email: { endsWith: DEMO_DOMAIN } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const coupons = await prisma.reward_coupons.findMany({ where: { title: { startsWith: DEMO_COUPON_PREFIX } }, select: { id: true } });
  const couponIds = coupons.map((c) => c.id);

  await prisma.$transaction([
    prisma.user_rewards.deleteMany({ where: { OR: [{ user_id: { in: ids } }, { coupon_id: { in: couponIds } }] } }),
    prisma.reward_coupons.deleteMany({ where: { id: { in: couponIds } } }),
    prisma.referrals.deleteMany({ where: { OR: [{ referrer_id: { in: ids } }, { referred_id: { in: ids } }] } }),
    prisma.task_completions.deleteMany({ where: { user_id: { in: ids } } }),
    prisma.task_purchases.deleteMany({ where: { user_id: { in: ids } } }),
    prisma.subscriptions.deleteMany({ where: { user_id: { in: ids } } }),
    prisma.feedback.deleteMany({ where: { user_id: { in: ids } } }),
    prisma.user_progression.deleteMany({ where: { user_id: { in: ids } } }),
    prisma.users.updateMany({ where: { id: { in: ids } }, data: { referred_by: null } }),
    prisma.users.deleteMany({ where: { id: { in: ids } } }),
  ]);
  console.log(`Removed ${ids.length} demo users and ${couponIds.length} demo coupons.`);
}

async function insert() {
  const tasks = await prisma.tasks.findMany({ where: { is_active: true }, select: { id: true, title: true }, orderBy: { id: 'asc' } });
  if (!tasks.length) throw new Error('No active tasks — run the main seed first.');
  const levels = await prisma.levels.findMany({ select: { level_number: true, xp_required: true }, orderBy: { level_number: 'asc' } });
  const xpForLevel = new Map(levels.map((l) => [l.level_number, l.xp_required]));
  const maxLevel = levels.at(-1)?.level_number ?? 1;
  const today = getISTDateOnly();

  // ── users ───────────────────────────────────────────────
  // Signup offsets (days ago): 3 today, 2 yesterday, the rest spread over 75 days.
  const signupAgo = [0, 0, 0, 1, 1, ...Array.from({ length: NAMES.length - 5 }, (_, i) => 2 + Math.floor((i * 73) / (NAMES.length - 5)))];
  // Level per user — mostly low ranks, a few climbers.
  const levelPool = [1, 1, 2, 3, 4, 5, 6, 8, 12, 14, 15, 18, 22, 25, 28, 33, 36, 42, 45, 52, 55, 63, 72, 84, 93];

  const users = [];
  for (let i = 0; i < NAMES.length; i++) {
    const ago = signupAgo[i];
    const level = Math.min(maxLevel, levelPool[i % levelPool.length]);
    const createdAt = istAt(-ago, between(7, 22), between(0, 59));
    const user = await prisma.users.create({
      data: {
        hunter_id: `DEMO${String(i + 1).padStart(3, '0')}`,
        name: NAMES[i],
        email: `${NAMES[i].toLowerCase().replace(/\s+/g, '.')}${DEMO_DOMAIN}`,
        referral_code: `DM${String(i + 1).padStart(3, '0')}X${'ABCDEFGH'[i % 8]}${'JKLMNPQR'[Math.floor(i / 8) % 8]}`,
        onboarding_done: ago > 0 || i % 2 === 0,
        onboarding_step: ago > 0 || i % 2 === 0 ? 10 : 2,
        gender: i % 2 ? 'FEMALE' : 'MALE',
        email_verified_at: createdAt,
        oath_accepted: true,
        oath_accepted_at: createdAt,
        created_at: createdAt,
        updated_at: createdAt,
      },
    });
    users.push({ ...user, ago, level });
  }

  // ── activity: task completions ──────────────────────────
  // Each user keeps an unbroken run from signup for `run` days (the streak
  // drop-off curve), then shows up on scattered days after that.
  const completions = [];
  const seen = new Set();
  const addCompletion = (u, dayOffset, status = 'COMPLETED', extra = {}) => {
    const task = extra.task ?? pick(tasks);
    const scheduleDate = getISTDateOnly(dayOffset);
    const key = `${u.id}_${task.id}_${scheduleDate.toISOString()}`;
    if (seen.has(key)) return;
    seen.add(key);
    completions.push({
      user_id: u.id,
      task_id: task.id,
      schedule_date: scheduleDate,
      status,
      progress_value: status === 'PARTIAL' ? 0.5 : 1,
      xp_earned: status === 'COMPLETED' ? between(20, 60) : status === 'PARTIAL' ? 10 : 0,
      completed_at: istAt(dayOffset, between(6, 21), between(0, 59)),
      created_at: istAt(dayOffset, 6),
      ...extra.data,
    });
  };

  const runLengths = [30, 20, 14, 14, 12, 10, 9, 7, 7, 6, 5, 5, 4, 3, 3, 2, 2, 1, 1, 1, 0, 0];
  users.forEach((u, i) => {
    const run = Math.min(u.ago + 1, runLengths[i % runLengths.length]);
    for (let d = 0; d < run; d++) {
      const offset = -u.ago + d;
      for (let k = 0; k < between(1, 3); k++) addCompletion(u, offset, rand() < 0.85 ? 'COMPLETED' : 'PARTIAL');
    }
    // Scattered later activity in the last 30 days.
    for (let offset = Math.max(-u.ago + run + 1, -29); offset <= 0; offset++) {
      if (rand() < 0.45) addCompletion(u, offset, rand() < 0.8 ? 'COMPLETED' : rand() < 0.5 ? 'PARTIAL' : 'SKIPPED');
    }
  });
  // Make sure plenty of users are active today, and a few have proofs waiting.
  users.slice(0, 18).forEach((u) => addCompletion(u, 0, 'COMPLETED'));
  users.slice(5, 9).forEach((u, i) => addCompletion(u, 0, 'IN_REVIEW', {
    task: tasks[(i + 1) % tasks.length],
    data: {
      xp_earned: 0,
      proof_urls: Array.from({ length: i + 1 }, (_, n) => `https://picsum.photos/seed/hunterx-proof-${i}-${n}/600/800`),
      proof_submitted_at: istAt(0, 8 + i, 15),
    },
  }));
  await prisma.task_completions.createMany({ data: completions });

  // ── progression ─────────────────────────────────────────
  const lastActive = new Map();
  for (const c of completions) {
    const prev = lastActive.get(c.user_id);
    if (!prev || c.schedule_date > prev) lastActive.set(c.user_id, c.schedule_date);
  }
  await prisma.user_progression.createMany({
    data: users.map((u, i) => ({
      user_id: u.id,
      current_level: u.level,
      total_xp: (xpForLevel.get(u.level) ?? 0) + between(0, 400),
      daily_streak: Math.min(u.ago + 1, runLengths[i % runLengths.length]),
      longest_streak: runLengths[i % runLengths.length],
      last_active_date: lastActive.get(u.id) ?? null,
    })),
  });

  // ── subscriptions ───────────────────────────────────────
  const subs = [];
  const platforms = ['IOS', 'ANDROID', 'ANDROID', 'WEB'];
  const paid = (u, plan, startAgo, opts = {}) => {
    const started = istAt(-startAgo, between(9, 20));
    const periodDays = plan === 'yearly' ? 365 : 30;
    // Monthly subs renew, so the current period ends within the next 30 days.
    const periods = Math.floor(startAgo / periodDays) + 1;
    subs.push({
      user_id: u.id, plan, platform: pick(platforms),
      status: opts.status ?? 'ACTIVE',
      started_at: started,
      expires_at: opts.expires_at ?? new Date(started.getTime() + periods * periodDays * DAY_MS),
      cancelled_at: opts.cancelled_at ?? null,
      created_at: started, updated_at: started,
    });
  };
  const trial = (u, startAgo, status) => {
    const started = istAt(-startAgo, 11);
    subs.push({
      user_id: u.id, plan: 'trial', platform: pick(platforms), status,
      started_at: started, expires_at: new Date(started.getTime() + 7 * DAY_MS),
      created_at: started, updated_at: started,
    });
  };

  // Long-running paid subscribers (spread over 90 days for the MRR curve).
  [[8, 'monthly', 70], [9, 'yearly', 66], [10, 'monthly', 58], [11, 'monthly', 51], [12, 'yearly', 44],
   [13, 'monthly', 37], [14, 'monthly', 29], [15, 'monthly', 22], [16, 'yearly', 15], [17, 'monthly', 9]]
    .forEach(([i, plan, ago]) => paid(users[i], plan, Math.min(ago, users[i].ago)));
  // New this week / today.
  paid(users[3], 'monthly', 0);
  paid(users[6], 'monthly', 2);
  paid(users[7], 'yearly', 4);
  // Converted trials: trial expired, then paid.
  [18, 19, 20].forEach((i) => {
    const ago = Math.min(users[i].ago, 40);
    trial(users[i], ago, 'EXPIRED');
    paid(users[i], 'monthly', Math.max(ago - 7, 0));
  });
  // Trials that didn't convert, and trials still running.
  [21, 22].forEach((i) => trial(users[i], Math.min(users[i].ago, 30), 'EXPIRED'));
  [0, 1, 4, 23].forEach((i) => trial(users[i], Math.min(users[i].ago, 3), 'TRIAL'));
  // Churned: two this week, one last month.
  paid(users[24], 'monthly', Math.min(users[24].ago, 50), { status: 'CANCELLED', cancelled_at: istAt(-2, 14), expires_at: daysFromNow(-1) });
  paid(users[25], 'monthly', Math.min(users[25].ago, 45), { status: 'CANCELLED', cancelled_at: istAt(-5, 18), expires_at: daysFromNow(-3) });
  paid(users[26], 'yearly', Math.min(users[26].ago, 60), { status: 'CANCELLED', cancelled_at: istAt(-25, 10), expires_at: daysFromNow(-24) });
  // Past due: period ended, never renewed.
  paid(users[27], 'monthly', Math.min(users[27].ago, 34), { expires_at: daysFromNow(-3) });
  paid(users[28], 'monthly', Math.min(users[28].ago, 33), { expires_at: daysFromNow(-1) });
  await prisma.subscriptions.createMany({ data: subs });

  // ── task purchases (one-off payments) ───────────────────
  const purchase = (u, ago, amount, status, provider) => {
    const at = istAt(-ago, between(9, 21));
    return {
      user_id: u.id, task_id: pick(tasks).id, amount, currency: 'USD', status,
      payment_provider: provider, payment_ref: `demo_${u.hunter_id}_${ago}_${status}`.toLowerCase(),
      paid_at: status === 'PAID' || status === 'REFUNDED' ? at : null,
      access_start: status === 'PAID' ? getISTDateOnly(-ago) : null,
      access_end: status === 'PAID' ? getISTDateOnly(-ago + 30) : null,
      created_at: at, updated_at: at,
    };
  };
  await prisma.task_purchases.createMany({
    data: [
      purchase(users[2], 0, 4.99, 'PAID', 'razorpay'),
      purchase(users[9], 1, 2.99, 'FAILED', 'razorpay'),
      purchase(users[11], 1, 4.99, 'PAID', 'stripe'),
      purchase(users[14], 3, 1.99, 'PENDING', 'razorpay'),
      purchase(users[15], 4, 4.99, 'FAILED', 'stripe'),
      purchase(users[16], 6, 2.99, 'REFUNDED', 'razorpay'),
      purchase(users[20], 8, 4.99, 'PAID', 'razorpay'),
    ],
  });

  // ── referrals ───────────────────────────────────────────
  // Referrers are older accounts; referees signed up after them.
  const referralPlan = { 8: [18, 19, 21, 29, 30], 9: [20, 22, 0], 12: [23, 24, 1], 10: [31, 2] };
  for (const [referrerIdx, refereeIdxs] of Object.entries(referralPlan)) {
    const referrer = users[referrerIdx];
    for (const idx of refereeIdxs) {
      const referee = users[idx];
      if (!referee) continue;
      await prisma.referrals.create({
        data: { referrer_id: referrer.id, referred_id: referee.id, xp_awarded: true, created_at: referee.created_at },
      });
      await prisma.users.update({ where: { id: referee.id }, data: { referred_by: referrer.id } });
    }
  }

  // ── reward cards (coupons) ──────────────────────────────
  const trigger = await prisma.reward_triggers.findFirst({ orderBy: { id: 'asc' } });
  const partners = [
    { name: 'Cult.fit', code: 'CULTDEMO25', type: 'PERCENT', value: 25 },
    { name: 'MuscleBlaze', code: 'MBDEMO15', type: 'PERCENT', value: 15 },
    { name: 'Decathlon', code: 'DECADEMO10', type: 'PERCENT', value: 10 },
  ];
  const coupons = [];
  if (trigger) {
    for (const p of partners) {
      coupons.push(await prisma.reward_coupons.create({
        data: {
          trigger_id: trigger.id,
          title: `${DEMO_COUPON_PREFIX} ${p.value}% off at ${p.name}`,
          coupon_code: p.code,
          discount_type: p.type,
          discount_value: p.value,
          product_name: p.name,
          is_active: false, // never awarded to real users
        },
      }));
    }
  }
  const rarityByTrigger = { STREAK_7: 'rare', STREAK_14: 'epic', STREAK_30: 'legendary', LEVEL_UP: 'common', BIRTHDAY: 'epic', REFERRAL: 'common' };
  const triggerTypes = Object.keys(rarityByTrigger);
  const rewards = [];
  users.forEach((u, i) => {
    const count = i % 3 === 0 ? 2 : 1;
    for (let k = 0; k < count; k++) {
      const coupon = coupons.length ? coupons[(i + k) % coupons.length] : null;
      const triggerType = triggerTypes[(i + k) % triggerTypes.length];
      const assignedAgo = Math.min(u.ago, between(0, 40));
      const assigned = istAt(-assignedAgo, between(8, 22));
      const roll = rand();
      // ~40% redeemed, ~20% expired, rest still unused.
      const status = roll < 0.4 ? 'CLAIMED' : roll < 0.6 ? 'EXPIRED' : 'ACTIVE';
      rewards.push({
        user_id: u.id,
        coupon_id: coupon?.id ?? null,
        trigger_type: triggerType,
        rarity: rarityByTrigger[triggerType],
        status,
        coupon_code: coupon?.coupon_code ?? `HX${u.hunter_id}${k}`,
        discount_type: coupon?.discount_type ?? 'PERCENT',
        discount_value: coupon?.discount_value ?? 10,
        reward_text: coupon ? null : '10% off',
        assigned_at: assigned,
        seen_at: assigned,
        scratched_at: status !== 'ACTIVE' ? assigned : null,
        claimed_at: status === 'CLAIMED' ? new Date(Math.min(Date.now(), assigned.getTime() + between(1, 72) * 3600 * 1000)) : null,
        expires_at: status === 'EXPIRED' ? new Date(Math.min(Date.now() - 3600 * 1000, assigned.getTime() + 2 * DAY_MS)) : daysFromNow(between(5, 30)),
      });
    }
  });
  await prisma.user_rewards.createMany({ data: rewards });
  // Keep each coupon's counter in step with the cards handed out, as the
  // reward engine does — the admin shows it as stock and uses it to explain
  // why a coupon someone holds is switched off instead of deleted.
  for (const c of coupons) {
    const awarded = rewards.filter((r) => r.coupon_id === c.id).length;
    await prisma.reward_coupons.update({ where: { id: c.id }, data: { awarded_count: awarded } });
  }

  // ── feedback ────────────────────────────────────────────
  const feedback = [
    [3, 'bug_report', 'Steps did not sync from Apple Health this morning, still shows 0.', 'received', 0],
    [7, 'suggestion', 'Would love a dark-blue theme option and weekly summary emails.', 'received', 0],
    [12, 'bug_report', 'App froze on the reward reveal screen after scratching the card.', 'in_review', 1],
    [15, 'other', 'How do I transfer my streak to a new phone?', 'received', 2],
    [19, 'bug_report', 'Leaderboard shows me twice after changing my name.', 'in_review', 3],
    [22, 'suggestion', 'Add a rest-day option that does not break the streak.', 'resolved', 6],
    [26, 'bug_report', 'Notification arrives at 3 AM instead of my set time.', 'resolved', 9],
  ];
  await prisma.feedback.createMany({
    data: feedback.map(([i, category, message, status, ago]) => ({
      user_id: users[i].id, category, message, status,
      app_version: '1.4.2', device_os: i % 2 ? 'android 15' : 'ios 18.2', user_level: users[i].level,
      created_at: istAt(-ago, between(8, 22)), updated_at: istAt(-ago, 23),
    })),
  });

  // ── bans ────────────────────────────────────────────────
  const admin = await prisma.users.findFirst({ where: { role: 'ADMIN' }, select: { id: true } });
  await prisma.users.update({ where: { id: users[29].id }, data: { is_banned: true, ban_reason: 'Submitted the same proof photo for 6 different tasks.', banned_at: istAt(-1, 16), banned_by: admin?.id ?? null } });
  await prisma.users.update({ where: { id: users[30].id }, data: { is_banned: true, ban_reason: 'Abusive language in display name.', banned_at: istAt(-4, 12), banned_by: admin?.id ?? null } });

  console.log(`Inserted ${users.length} users, ${completions.length} task completions, ${subs.length} subscriptions, ` +
    `${rewards.length} reward cards, ${feedback.length} feedback tickets, ${Object.values(referralPlan).flat().length} referrals.`);
  console.log(`Today (IST): ${today.toISOString().slice(0, 10)}`);
}

async function main() {
  assertLocalDb();
  await clean();
  if (!process.argv.includes('--clean')) await insert();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
