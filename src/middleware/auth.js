// src/middleware/auth.js — Verify JWT on protected routes

import { verifyAccessToken } from '../utils/helpers.js';
import { error, accountSuspended } from '../utils/response.js';
import prisma from '../config/prisma.js';
import { getCachedAuthUser, setCachedAuthUser } from '../services/authUserCache.js';
import { rememberUserTimezone } from '../utils/userClock.js';

export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'Unauthorized — no token provided', 401);
    }

    const token = authHeader.split(' ')[1];
    const decoded = verifyAccessToken(token);

    // Fetch user to check banned / deleted status — from the short-lived
    // cache when this user made a request moments ago (it's cleared the
    // moment their row changes; see services/authUserCache.js).
    let user = getCachedAuthUser(decoded.userId);
    if (user === undefined) {
      user = await prisma.users.findUnique({
        where: { id: BigInt(decoded.userId) },
        select: {
          id:       true,
          role:     true,
          is_banned: true,
          ban_reason: true,
          onboarding_done: true,
          hunter_id: true,
          name:     true,
          email:    true,
          gender:   true,
          delete_at: true,
        },
      });
      // A missing user isn't cached: it's answered with a 401 either way.
      if (user) setCachedAuthUser(decoded.userId, user);
    }

    // Deleted, or past its scheduled deletion and waiting for the hourly
    // purge — the app signs out and says the account is gone.
    if (!user || (user.delete_at && user.delete_at <= new Date())) {
      return error(res, 'Unauthorized — user not found', 401, 'ACCOUNT_NOT_FOUND');
    }

    if (user.is_banned) {
      return accountSuspended(res, user.ban_reason);
    }

    req.user = {
      ...user,
      gender: decoded.gender || user.gender,
    };

    // The phone's IANA zone: quests and streaks roll over at the user's own
    // midnight (utils/userClock.js). Saved before the route runs so this
    // very request already uses it. Usually a cache hit, no DB work.
    const tz = req.headers['x-timezone'];
    if (typeof tz === 'string' && tz) await rememberUserTimezone(user.id, tz);

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return error(res, 'Token expired — please refresh', 401);
    }
    if (err.name === 'JsonWebTokenError') {
      return error(res, 'Invalid token', 401);
    }
    next(err);
  }
}
