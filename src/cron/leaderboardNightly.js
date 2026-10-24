// src/cron/leaderboardNightly.js — Nightly leaderboard reconciliation,
// scheduled for 03:00 IST (21:30 UTC) — clear of midnight.js's 00:30 IST
// task-assignment run.
//
// Two jobs in one pass:
//   1. Drain lb:dirty — users whose Redis sync failed at write time (see
//      leaderboardService.js#syncLeaderboardMember) get resynced here.
//   2. Full rebuild of lb:global from Postgres (same
//      RENAME-swap script as scripts/rebuildLeaderboard.js, with its
//      own lock so this never races a manual or post-deploy run).
//
// This runs an unconditional full rebuild every night rather than
// measuring drift first and rebuilding only past a threshold. At the
// current user count a full rebuild is cheap enough that the simpler,
// unconditional version is the better trade — no drift math to get
// wrong, and it also quietly fixes any staleness a dirty-set failure
// didn't account for. The drift-measure-then-rebuild design (ZCARD vs.
// a Postgres COUNT per scope, rebuild only if they differ by more than
// 0.5%) is the intended path once the user count makes a nightly full
// rebuild expensive enough to want to avoid doing it unconditionally —
// see the version of this file before this change for that
// implementation (checkDrift/DRIFT_REBUILD_THRESHOLD) to resurrect.

import cron from 'node-cron';
import redis, { isRedisUp } from '../config/redis.js';
import { info, logError } from '../utils/logger.js';
import { REDIS_KEYS } from '../config/leaderboardConfig.js';
import { syncLeaderboardMember } from '../services/leaderboardService.js';
import { rebuildLeaderboard } from '../../scripts/rebuildLeaderboard.js';

async function drainDirtySet() {
  const dirtyIds = await redis.smembers(REDIS_KEYS.dirty);
  if (dirtyIds.length === 0) return 0;

  // Clear first — any id that fails again during reprocessing gets
  // re-added by syncLeaderboardMember's own failure path, so this never
  // loses a genuinely-still-broken id.
  await redis.del(REDIS_KEYS.dirty);

  for (const id of dirtyIds) {
    await syncLeaderboardMember(BigInt(id));
  }
  return dirtyIds.length;
}

export async function runLeaderboardNightlyJob() {
  if (!isRedisUp()) {
    logError('Leaderboard nightly job skipped — Redis is down');
    return;
  }

  try {
    const drained = await drainDirtySet();
    if (drained > 0) info(`Leaderboard nightly job: resynced ${drained} dirty user(s)`);

    const result = await rebuildLeaderboard();
    info(`Leaderboard nightly job: rebuild result ${JSON.stringify(result)}`);
  } catch (err) {
    logError(`Leaderboard nightly job crashed: ${err.message}`);
  }
}

// 30 21 * * * = 03:00 IST
export const leaderboardNightlyJob = cron.schedule('30 21 * * *', () => {
  runLeaderboardNightlyJob();
});

export default leaderboardNightlyJob;
