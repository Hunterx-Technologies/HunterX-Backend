// src/config/redis.js — Single ioredis client for the Leaderboard feature.
//
// Leaderboard code must never let a Redis outage break anything else
// (an XP award, a profile edit, ...), so this client is configured to
// retry quietly in the background rather than throw into callers:
// commands fail fast (one retry) when Redis is down, and
// isRedisUp() lets call sites take the Postgres-fallback path instead of
// waiting on a command that's going to fail anyway.

import Redis from 'ioredis';
import { logError, info } from '../utils/logger.js';
import { MAX_SAFE_TOTAL_XP, MAX_SAFE_USER_ID } from './leaderboardConfig.js';

const REDIS_URL = process.env.REDIS_URL;

let redis = null;
let up = false;

if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
    lazyConnect: false,
    // While disconnected, fail commands immediately instead of queueing
    // them — a queued command would hold an API request (e.g. a task
    // completion's leaderboard sync) until Redis came back.
    enableOfflineQueue: false,
  });

  // 'ready', not 'connect': commands are only accepted once the
  // connection has finished its handshake.
  redis.on('ready', () => {
    up = true;
    info('Redis connected (leaderboard cache)');
  });

  redis.on('error', (err) => {
    up = false;
    logError(`Redis error: ${err.message}`);
  });

  redis.on('close', () => {
    up = false;
  });
} else {
  logError('REDIS_URL not set — leaderboard will run in Postgres-fallback mode only');
}

export function isRedisUp() {
  return up && !!redis;
}

// Resolves once Redis is ready (true) or after timeoutMs (false). For
// startup / one-off scripts that run before the first 'ready' event —
// isRedisUp() is always false that early.
export function waitForRedis(timeoutMs = 5000) {
  if (!redis) return Promise.resolve(false);
  if (isRedisUp()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      redis.off('ready', onReady);
      resolve(false);
    }, timeoutMs);
    function onReady() {
      clearTimeout(timer);
      resolve(true);
    }
    redis.once('ready', onReady);
  });
}

export default redis;

// Called once at startup. The score-packing scheme (see
// leaderboardConfig.js) silently corrupts ordering if totalXp or a
// user id ever exceeds its reserved bit width — this can't be caught
// by a type system, so it's checked against live data instead and
// logged loudly (never crashes the process; a corrupted ordering is
// a leaderboard bug, not a reason to take the whole API down).
export async function assertScorePackingSafe(prisma) {
  try {
    const [maxXp, maxUser] = await Promise.all([
      prisma.user_progression.aggregate({ _max: { total_xp: true } }),
      prisma.users.aggregate({ _max: { id: true } }),
    ]);

    const topXp   = maxXp._max.total_xp ?? 0;
    const topUser = maxUser._max.id != null ? Number(maxUser._max.id) : 0;

    if (topXp > MAX_SAFE_TOTAL_XP) {
      logError(
        `LEADERBOARD SCORE PACKING UNSAFE: max total_xp=${topXp} exceeds ` +
        `MAX_SAFE_TOTAL_XP=${MAX_SAFE_TOTAL_XP}. Leaderboard ordering may ` +
        `silently corrupt — widen XP_SHIFT_BITS in leaderboardConfig.js.`
      );
    }
    if (topUser > MAX_SAFE_USER_ID) {
      logError(
        `LEADERBOARD SCORE PACKING UNSAFE: max user id=${topUser} exceeds ` +
        `MAX_SAFE_USER_ID=${MAX_SAFE_USER_ID}. Leaderboard ordering may ` +
        `silently corrupt — widen XP_SHIFT_BITS in leaderboardConfig.js.`
      );
    }
  } catch (err) {
    logError(`Leaderboard score-packing startup check failed: ${err.message}`);
  }
}
