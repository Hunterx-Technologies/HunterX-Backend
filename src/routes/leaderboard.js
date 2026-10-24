// src/routes/leaderboard.js — GET /api/leaderboard?scope=global|friends
//
// Auth required. Ranks by user_progression.total_xp DESC (older account
// wins ties). Global is served from a Redis sorted set kept live by
// leaderboardService#syncLeaderboardMember, with an automatic Postgres
// keyset fallback if Redis is unreachable. Friends is always Postgres —
// the set is bounded (me + who I referred, capped, + who referred me),
// so OFFSET paging there is cheap regardless of total user count.

import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { leaderboardLimiter } from '../middleware/rateLimiter.js';
import { success, error } from '../utils/response.js';
import prisma from '../config/prisma.js';
import { getLeaderboard, buildAvatarThumbUrl, attachStreaks } from '../services/leaderboardService.js';
import { LEADERBOARD_DEFAULT_LIMIT, LEADERBOARD_MAX_LIMIT } from '../config/leaderboardConfig.js';

const router = Router();

const VALID_SCOPES = ['global', 'friends'];

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return LEADERBOARD_DEFAULT_LIMIT;
  return Math.min(LEADERBOARD_MAX_LIMIT, n);
}

// Only needed on the first page of a request (no cursor) — 'me' is
// never returned past page 1, so later pages skip this entirely.
async function loadMeSnapshot(meId) {
  const row = await prisma.users.findUnique({
    where: { id: meId },
    select: {
      name: true,
      avatars: { select: { image_url: true } },
      user_settings: { select: { leaderboard_visible: true } },
      user_progression: { select: { total_xp: true } },
    },
  });

  return {
    name: row?.name ?? '',
    avatarThumbUrl: buildAvatarThumbUrl(row?.avatars?.image_url),
    leaderboardVisible: row?.user_settings?.leaderboard_visible ?? true,
    totalXp: row?.user_progression?.total_xp ?? 0,
  };
}

router.get('/', verifyToken, leaderboardLimiter, async (req, res, next) => {
  try {
    const scope = req.query.scope;
    if (!VALID_SCOPES.includes(scope)) {
      return error(res, `scope must be one of: ${VALID_SCOPES.join(', ')}`, 400);
    }

    const limit = clampLimit(req.query.limit);
    const cursorStr = req.query.cursor || null;
    const meId = BigInt(req.user.id);

    const meSnapshot = cursorStr ? null : await loadMeSnapshot(meId);

    const { entries, me, nextCursor, emptyState } = await getLeaderboard({
      meId, meSnapshot, scope, cursorStr, limit,
    });
    await attachStreaks(entries, me, meId);

    res.set('Cache-Control', 'private, no-store');
    return success(res, { entries, me, nextCursor, emptyState }, 'Leaderboard fetched');
  } catch (err) {
    if (err.message === 'INVALID_CURSOR') {
      return error(res, 'Invalid or expired cursor', 400);
    }
    next(err);
  }
});

export default router;
