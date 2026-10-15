// scripts/test-streak-break-reconciliation.js
//
// Verifies that an unprotected gap (missed days > banked lives) breaks
// the streak to 0 the moment it's observed — via reconcileStreak(),
// reached through getStreakRiskStatus() — rather than only once the
// user completes another task. Mirrors the Monday-Saturday walkthrough:
//   Mon active (streak 5, lives 2) -> Tue/Wed missed (covered by lives)
//   -> Thu missed (lives exhausted -> streak breaks to 0 immediately)
//   -> Fri active (streak 1) -> Sat active (streak 2)
import 'dotenv/config'; // standalone script — src/index.js normally does this
import prisma from '../src/config/prisma.js';
import { getISTDateOnly } from '../src/utils/helpers.js';
import { getStreakRiskStatus, bumpDailyStreak } from '../src/services/streakService.js';

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`FAILED: ${label} — expected ${expected}, got ${actual}`);
  }
  console.log(`  ok: ${label} = ${actual}`);
}

async function runTest() {
  console.log('--- STARTING STREAK BREAK RECONCILIATION TEST ---');

  const timestamp = Date.now();
  const user = await prisma.users.create({
    data: {
      hunter_id:     `TST${String(timestamp).slice(-5)}`,
      name:          'Streak Break Test Hunter',
      email:         `test_streak_break_${timestamp}@example.com`,
      referral_code: `REF${String(timestamp).slice(-5)}`,
    },
  });
  const userId = user.id;

  try {
    // ── Scenario A: a gap within banked lives is NOT broken on read ──
    // Mon active (streak 5, lives 2); as of "today" 2 days have passed
    // (Tue + Wed missed) with 2 lives banked -> fully covered, at risk.
    console.log('\nScenario A: 2 missed days, 2 lives banked -> covered, not broken');
    await prisma.user_progression.create({
      data: {
        user_id:          userId,
        daily_streak:     5,
        longest_streak:   5,
        streak_lives:     2,
        last_active_date: getISTDateOnly(-3), // Monday, if "today" is Thursday
      },
    });

    let status = await getStreakRiskStatus(userId);
    assertEqual(status.daily_streak, 5, 'daily_streak stays put while covered');
    assertEqual(status.streak_lives, 2, 'lives untouched by a read-only check');
    assertEqual(status.at_risk, true, 'at_risk true — a decision is available');
    assertEqual(status.missed_days, 2, 'missed_days reported');

    // ── Scenario B: lives exhausted -> break is visible immediately ──
    // Same user, now 3 days have passed (Tue/Wed/Thu missed) with only
    // 2 lives banked -> exceeds coverage -> must read as broken (0) the
    // moment it's checked, without any task completion happening.
    console.log('\nScenario B: 3 missed days, 2 lives banked -> breaks immediately on read');
    await prisma.user_progression.update({
      where: { user_id: userId },
      data:  { last_active_date: getISTDateOnly(-4) }, // Monday, if "today" is Friday
    });

    status = await getStreakRiskStatus(userId);
    assertEqual(status.daily_streak, 0, 'streak reads as broken on the first read after the gap');
    assertEqual(status.streak_lives, 0, 'lives are exhausted, not carried forward');
    assertEqual(status.at_risk, false, 'no decision left — already broken');

    const reconciled = await prisma.user_progression.findUnique({ where: { user_id: userId } });
    assertEqual(reconciled.daily_streak, 0, 'break is persisted to the DB, not just the response');
    assertEqual(reconciled.streak_lives, 0, 'lives persisted to 0 in the DB');

    // Re-reading again must not error or change anything further.
    const statusAgain = await getStreakRiskStatus(userId);
    assertEqual(statusAgain.daily_streak, 0, 'idempotent: still 0 on a second read');

    // ── Scenario C: next completion starts a fresh streak at 1 ──
    console.log('\nScenario C: next completion after the break lands on streak 1');
    await prisma.$transaction((tx) => bumpDailyStreak(tx, userId));
    let progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
    assertEqual(progression.daily_streak, 1, 'fresh streak starts at 1, not resumed from 5');
    assertEqual(progression.streak_lives, 0, 'lives still 0 after the fresh completion');

    // ── Scenario D: the day after, streak continues normally ──
    console.log('\nScenario D: the following active day increments normally');
    await prisma.user_progression.update({
      where: { user_id: userId },
      data:  { last_active_date: getISTDateOnly(-1) }, // pretend that completion was yesterday
    });
    await prisma.$transaction((tx) => bumpDailyStreak(tx, userId));
    progression = await prisma.user_progression.findUnique({ where: { user_id: userId } });
    assertEqual(progression.daily_streak, 2, 'streak continues 1 -> 2 on the next active day');

    console.log('\nSUCCESS: All verification checks passed clean!');
  } finally {
    console.log('Cleaning up test user...');
    await prisma.user_progression.deleteMany({ where: { user_id: userId } });
    await prisma.users.delete({ where: { id: userId } });
    console.log('Cleanup finished.');
  }
}

runTest()
  .then(() => {
    console.log('--- VERIFICATION SUCCEEDED ---');
    process.exit(0);
  })
  .catch((err) => {
    console.error('--- VERIFICATION FAILED ---', err);
    process.exit(1);
  });
