// src/utils/throttle.js — Per-key counters for limits the IP rate limiters
// can't express: failed logins per account, and codes sent per email.
//
// Kept in Redis so every instance shares them; while Redis is down (or not
// configured) they fall back to this process's memory, which still holds
// the limit for a single instance.

import redis, { isRedisUp } from '../config/redis.js';

const memory = new Map(); // key -> { count, expiresAt }

function memoryIncr(key, windowSec) {
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= now) {
    memory.set(key, { count: 1, expiresAt: now + windowSec * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function memoryGet(key) {
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return 0;
  return entry.count;
}

// Expired entries are dropped lazily; this keeps the map from growing
// without bound under a stream of one-off keys.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memory) if (entry.expiresAt <= now) memory.delete(key);
}, 60_000).unref();

/** Adds one to `key` (window starts at the first hit) and returns the new count. */
export async function hit(key, windowSec) {
  if (isRedisUp()) {
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSec);
      return count;
    } catch {
      // fall through to memory
    }
  }
  return memoryIncr(key, windowSec);
}

/** Current count for `key` (0 when unset or expired). */
export async function peek(key) {
  if (isRedisUp()) {
    try {
      return Number(await redis.get(key)) || 0;
    } catch {
      // fall through to memory
    }
  }
  return memoryGet(key);
}

export async function clear(key) {
  memory.delete(key);
  if (isRedisUp()) {
    try {
      await redis.del(key);
    } catch {
      // best-effort
    }
  }
}

// ── Policies ──────────────────────────────────────────────

const LOGIN_FAIL_WINDOW_SEC = 15 * 60;
const LOGIN_FAIL_MAX        = 10;

const loginKey = (email) => `throttle:login:${email}`;

/** True when this account has had too many failed logins in the last 15 minutes. */
export async function isLoginLocked(email) {
  return (await peek(loginKey(email))) >= LOGIN_FAIL_MAX;
}

export function recordLoginFailure(email) {
  return hit(loginKey(email), LOGIN_FAIL_WINDOW_SEC);
}

export function clearLoginFailures(email) {
  return clear(loginKey(email));
}

const CODE_COOLDOWN_SEC = 60;
const CODE_DAILY_MAX    = 10;

/**
 * Codes emailed to one address for one purpose: at most one a minute and
 * ten a day. Applied the same way whether or not the address has an
 * account, so the limit itself reveals nothing. Returns true when sending
 * is allowed (and counts it).
 */
export async function allowCodeEmail(purpose, email) {
  const cooldownKey = `throttle:code:${purpose}:cool:${email}`;
  const dailyKey    = `throttle:code:${purpose}:day:${email}`;
  if ((await peek(cooldownKey)) > 0) return false;
  if ((await peek(dailyKey)) >= CODE_DAILY_MAX) return false;
  await hit(cooldownKey, CODE_COOLDOWN_SEC);
  await hit(dailyKey, 24 * 60 * 60);
  return true;
}
