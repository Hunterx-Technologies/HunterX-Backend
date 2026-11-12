// src/middleware/rateLimiter.js — Rate limiting

import rateLimit, { MemoryStore } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import redis, { isRedisUp } from '../config/redis.js';
import { verifyAccessToken } from '../utils/helpers.js';

// Counters live in Redis when it's available, so limits hold across every
// server instance (and survive a redeploy). If Redis is missing or down, the
// limiter quietly counts in this instance's memory instead — requests are
// never blocked or let through unlimited because of a Redis problem.
class RedisWithMemoryFallback {
  constructor(prefix) {
    this.prefix = prefix;
    this.memory = new MemoryStore();
    this.redisStore = null; // created on first use once Redis is up
    this.localKeys = false;
  }

  init(options) {
    this.options = options;
    this.memory.init(options);
  }

  redisOrNull() {
    if (!redis || !isRedisUp()) return null;
    if (!this.redisStore) {
      this.redisStore = new RedisStore({ prefix: this.prefix, sendCommand: (...args) => redis.call(...args) });
      this.redisStore.init(this.options);
    }
    return this.redisStore;
  }

  async get(key) {
    const store = this.redisOrNull();
    if (store) {
      try { return await store.get(key); } catch { /* fall back */ }
    }
    return this.memory.get(key);
  }

  async increment(key) {
    const store = this.redisOrNull();
    if (store) {
      try { return await store.increment(key); } catch { /* fall back */ }
    }
    return this.memory.increment(key);
  }

  async decrement(key) {
    const store = this.redisOrNull();
    if (store) {
      try { return await store.decrement(key); } catch { /* fall back */ }
    }
    return this.memory.decrement(key);
  }

  async resetKey(key) {
    const store = this.redisOrNull();
    if (store) await store.resetKey(key).catch(() => {});
    return this.memory.resetKey(key);
  }

  shutdown() {
    this.memory.shutdown?.();
  }
}

// Signed-in requests are counted per user, not per IP: mobile carriers put
// many people behind one shared IP (CGNAT), and they'd otherwise share a
// single bucket. The token's signature is checked, so a made-up token can't
// be used to get a fresh bucket; anything else falls back to the IP.
function userOrIpKey(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      const { userId } = verifyAccessToken(header.slice(7));
      if (userId != null) return `user:${userId}`;
    } catch {
      // Expired or invalid — counted against the IP like any anonymous call.
    }
  }
  return `ip:${req.ip}`;
}

// General — 1000 requests per 15 minutes in production, 5000 in development
export const generalLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:generalLimiter:'),
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 5000 : 1000,
  keyGenerator: userOrIpKey,
  message: {
    success: false,
    message: 'Too many requests. Try again later.',
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Auth — stricter — 150 requests per 15 minutes in production, 1000 in development
export const authLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:authLimiter:'),
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 1000 : 150,
  message: {
    success: false,
    message: 'Too many auth attempts. Try again later.',
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Leaderboard — 60/min per user (not per IP; relies on verifyToken
// running first so req.user is populated). Infinite-scroll + background
// revalidation on 3 tabs can be chatty, but 60/min comfortably covers
// normal use without opening it up to a scraping risk.
export const leaderboardLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:leaderboardLimiter:'),
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id?.toString() || req.ip,
  message: {
    success: false,
    message: 'Too many leaderboard requests. Try again in a moment.',
  },
});

// Friends (cards, requests, blocks) — 60/min per user. Looking a hunter up
// by invite code has its own, tighter limit below (friendCodeLimiter), so
// codes can't be enumerated through the signed-in API either.
export const friendsLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:friendsLimiter:'),
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id?.toString() || req.ip,
  message: {
    success: false,
    message: 'Too many requests. Try again in a moment.',
    error:   { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a moment.' },
  },
});

export const friendCodeLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:friendCodeLimiter:'),
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id?.toString() || req.ip,
  message: {
    success: false,
    message: 'Too many code lookups. Try again in a moment.',
    error:   { code: 'RATE_LIMITED', message: 'Too many code lookups. Try again in a moment.' },
  },
});

// Public referral-code lookup — 20/min per IP. Unauthenticated, so this
// is what stops anyone enumerating codes (and inviter names).
export const referralLookupLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:referralLookupLimiter:'),
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Too many invite lookups. Try again in a moment.',
    error:   { code: 'RATE_LIMITED', message: 'Too many invite lookups. Try again in a moment.' },
  },
});

// Rewards writes (seen / scratch / use) — 30/min per user. Scratch is
// idempotent anyway; this just keeps a stuck retry loop from hammering
// the row locks.
export const rewardLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:rewardLimiter:'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id?.toString() || req.ip,
  message: {
    success: false,
    message: 'Too many reward requests. Try again in a moment.',
    error:   { code: 'RATE_LIMITED', message: 'Too many reward requests. Try again in a moment.' },
  },
});

// Token refresh — 60 per 15 minutes per IP. A healthy client refreshes
// about every 15 minutes per device.
export const refreshLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:refreshLimiter:'),
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 1000 : 60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Too many requests. Try again later.',
    error:   { code: 'RATE_LIMITED', message: 'Too many requests. Try again later.' },
  },
});

// Public account-deletion endpoints (website) — 10/min per IP.
export const accountDeletionLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:accountDeletionLimiter:'),
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Too many attempts. Try again in a moment.',
    error:   { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a moment.' },
  },
});

// Upload signatures — 30/min per user.
export const uploadLimiter = rateLimit({
  store: new RedisWithMemoryFallback('rl:uploadLimiter:'),
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) => req.user?.id?.toString() || req.ip,
  message: {
    success: false,
    message: 'Too many uploads. Try again in a moment.',
    error:   { code: 'RATE_LIMITED', message: 'Too many uploads. Try again in a moment.' },
  },
});
