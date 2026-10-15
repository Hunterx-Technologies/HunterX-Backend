// src/middleware/rateLimiter.js — Rate limiting

import rateLimit from 'express-rate-limit';

// General — 1000 requests per 15 minutes in production, 5000 in development
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 5000 : 1000,
  message: {
    success: false,
    message: 'Too many requests. Try again later.',
  },
  standardHeaders: true,
  legacyHeaders:   false,
});

// Auth — stricter — 150 requests per 15 minutes in production, 1000 in development
export const authLimiter = rateLimit({
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
