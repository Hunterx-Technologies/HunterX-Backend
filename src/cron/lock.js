// src/cron/lock.js — One run per tick across every API instance.
//
// The crons start inside each API process (src/index.js), so with two or
// more instances each tick would run once per instance — double task
// assignment pushes, double push sends. withJobLock takes a Redis lock
// (SET NX EX) for the run; an instance that doesn't get it skips the tick.
// Without Redis (local dev, or Redis down) the job just runs, which is
// right for the single instance that setup implies. Also skips a tick
// while this process's previous run is still going.

import crypto from 'crypto';
import cron from 'node-cron';
import redis, { isRedisUp } from '../config/redis.js';
import { logError } from '../utils/logger.js';

const RELEASE_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export function withJobLock(name, ttlSec, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    const key = `cron:lock:${name}`;
    const token = crypto.randomBytes(12).toString('hex');
    let locked = false;
    try {
      if (isRedisUp()) {
        try {
          locked = (await redis.set(key, token, 'EX', ttlSec, 'NX')) === 'OK';
          if (!locked) return; // another instance has this tick
        } catch (err) {
          logError(`${name}: lock unavailable (${err.message}) — running without it`);
        }
      }
      await fn();
    } catch (err) {
      logError(`${name} crashed: ${err.message}`);
    } finally {
      if (locked) {
        try {
          await redis.eval(RELEASE_SCRIPT, 1, key, token);
        } catch {
          // expires by itself after ttlSec
        }
      }
      running = false;
    }
  };
}

// Every cron expression in src/cron is written in UTC (each file notes the
// IST time it lands on), so the clock is pinned to UTC rather than the
// host's zone — a dev machine set to IST, or a TZ variable on Railway,
// would otherwise shift every job by 5.5 hours.
export const CRON_TIMEZONE = 'UTC';

// node-cron 4 skips a tick it reaches more than this late (default 1 s) —
// enough slack that a busy event loop doesn't drop the nightly jobs, and
// still under the shortest gap (1 minute), so a tick never runs twice.
const MISSED_EXECUTION_TOLERANCE_MS = 30 * 1000;

/** Schedules `fn` on `expression` (UTC), one run per tick across instances. */
export function scheduleJob(name, expression, lockTtlSec, fn) {
  return cron.schedule(expression, withJobLock(name, lockTtlSec, fn), {
    name,
    timezone: CRON_TIMEZONE,
    missedExecutionTolerance: MISSED_EXECUTION_TOLERANCE_MS,
  });
}
