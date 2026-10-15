// src/config/leaderboardConfig.js — Tunables for the Leaderboard feature.
//
// Score packing (see src/services/leaderboardService.js#encodeScore): a
// ZSET member's score is totalXp * 2^XP_SHIFT_BITS + (2^XP_SHIFT_BITS - 1
// - userId), which only fits in a JS-safe integer (<= 2^53 - 1) while
// totalXp < 2^(53 - XP_SHIFT_BITS) and userId < 2^XP_SHIFT_BITS. With
// XP_SHIFT_BITS = 26 that's totalXp < 2^27 (~134M) and userId < 2^26
// (~67M) — checked against live data at startup, see
// src/config/redis.js#assertScorePackingSafe.
export const XP_SHIFT_BITS = 26;
export const XP_SHIFT = 2 ** XP_SHIFT_BITS;
export const MAX_SAFE_TOTAL_XP = 2 ** (53 - XP_SHIFT_BITS) - 1;
export const MAX_SAFE_USER_ID  = XP_SHIFT - 1;

// Gen Z scope — birth year window, inclusive on both ends.
export const GENZ_BIRTH_YEAR_START = 1997;
export const GENZ_BIRTH_YEAR_END   = 2012;

// Friends scope — bounds the worst case for a heavy referrer; only the
// most recently created referrals count toward the friend set.
export const FRIENDS_REFERRAL_CAP = 2000;

export const LEADERBOARD_DEFAULT_LIMIT = 20;
export const LEADERBOARD_MAX_LIMIT     = 50;

export const REDIS_KEYS = {
  global:      'lb:global',
  genz:        'lb:genz',
  dirty:       'lb:dirty',
  rebuildLock: 'lb:rebuild:lock',
  userHash:    (id) => `lb:u:${id}`,
};

export const DISPLAY_HASH_TTL_SECONDS = 24 * 60 * 60; // 24h
