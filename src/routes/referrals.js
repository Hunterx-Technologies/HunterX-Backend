// src/routes/referrals.js — The signed-in hunter's invites (attribution only, no rewards)

import { Router }              from 'express';
import { verifyToken }         from '../middleware/auth.js';
import { leaderboardLimiter }  from '../middleware/rateLimiter.js';
import { success }             from '../utils/response.js';
import { listInvitedFriends }  from '../services/referralService.js';

const router = Router();

// ── GET /api/referrals/invited ────────────────────────────
// Hunters who joined with my invite code, most recent first (up to 200;
// `count` covers all of them). Hunters with leaderboard visibility off
// are { id, visible: false } only. No emails or Hunter IDs.
// Response data: { count, friends: [{ id, visible, name?, avatarUrl?, rankName?, level? }] }
router.get('/invited', verifyToken, leaderboardLimiter, async (req, res, next) => {
  try {
    const result = await listInvitedFriends(req.user.id);
    return success(res, result, 'Invited friends');
  } catch (err) {
    next(err);
  }
});

export default router;
