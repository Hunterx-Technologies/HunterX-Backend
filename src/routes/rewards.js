// src/routes/rewards.js — The user's reward wallet + streak scratch cards.
// Cards are granted by rewardService.js when a streak milestone is hit;
// these routes list them and move them through
// UNSEEN → SEEN → SCRATCHED → USED. Failures carry error.code so the app
// can branch (REWARD_EXPIRED, REWARD_USED, NO_COUPON_AVAILABLE, ...).

import { Router }         from 'express';
import { verifyToken }    from '../middleware/auth.js';
import { rewardLimiter }  from '../middleware/rateLimiter.js';
import { success, error } from '../utils/response.js';
import * as rewardService from '../services/rewardService.js';

const router = Router();

const REWARD_ERRORS = {
  REWARD_NOT_FOUND:     [404, 'Reward not found'],
  REWARD_EXPIRED:       [409, 'This reward has expired'],
  REWARD_USED:          [409, 'This reward has already been used'],
  REWARD_NOT_SCRATCHED: [409, 'Scratch this card before using it'],
  NO_COUPON_AVAILABLE:  [422, 'Rewards are being restocked. Try again later.'],
  INVALID_TAB:          [400, `tab must be one of: ${rewardService.REWARD_TABS.join(', ')}`],
  INVALID_CURSOR:       [400, 'Invalid cursor'],
};

function handleRewardError(res, next, err) {
  const known = REWARD_ERRORS[err.message];
  if (known) return error(res, known[1], known[0], err.message);
  next(err);
}

// ── GET /api/rewards?tab=ACTIVE|USED|EXPIRED&cursor=<id> ──
// Newest first, 20 per page. Returns { items, next_cursor, counts }.
// Prize fields appear only on SCRATCHED / USED items.
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const result = await rewardService.listRewards(req.user.id, {
      tab:    req.query.tab ? String(req.query.tab).toUpperCase() : 'ACTIVE',
      cursor: req.query.cursor,
    });
    return success(res, result, 'Rewards fetched successfully');
  } catch (err) {
    handleRewardError(res, next, err);
  }
});

// ── GET /api/rewards/unseen ────────────────────────────────
// Cards not shown to the user yet (replayed on app launch). No prizes.
// Returns { rewards }.
router.get('/unseen', verifyToken, async (req, res, next) => {
  try {
    const result = await rewardService.listUnseenRewards(req.user.id);
    return success(res, result, 'Unseen rewards fetched successfully');
  } catch (err) {
    handleRewardError(res, next, err);
  }
});

// ── POST /api/rewards/:id/seen ─────────────────────────────
// Idempotent. Returns the reward.
router.post('/:id/seen', verifyToken, rewardLimiter, async (req, res, next) => {
  try {
    const reward = await rewardService.markRewardSeen(req.user.id, req.params.id);
    return success(res, reward, 'Reward marked as seen');
  } catch (err) {
    handleRewardError(res, next, err);
  }
});

// ── POST /api/rewards/:id/scratch ──────────────────────────
// Reveals the prize. Idempotent: every call returns the same prize.
// 409 REWARD_EXPIRED | REWARD_USED, 422 NO_COUPON_AVAILABLE (card stays
// scratchable), 404 when it isn't the caller's reward.
router.post('/:id/scratch', verifyToken, rewardLimiter, async (req, res, next) => {
  try {
    const reward = await rewardService.scratchReward(req.user.id, req.params.id);
    return success(res, reward, 'Reward revealed');
  } catch (err) {
    handleRewardError(res, next, err);
  }
});

// ── POST /api/rewards/:id/use ──────────────────────────────
// Marks a scratched reward as used. Idempotent.
router.post('/:id/use', verifyToken, rewardLimiter, async (req, res, next) => {
  try {
    const reward = await rewardService.markRewardUsed(req.user.id, req.params.id);
    return success(res, reward, 'Reward marked as used');
  } catch (err) {
    handleRewardError(res, next, err);
  }
});

export default router;
