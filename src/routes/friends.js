// src/routes/friends.js — Friends between existing hunters (friendService.js).
//
// GET    /api/friends/card/:userId          a hunter's card (tapped on the leaderboard)
// GET    /api/friends/card/code/:code       a hunter's card by invite code (pasted, or a link)
// GET    /api/friends/requests              requests waiting for me → { requests, count }
// POST   /api/friends/requests/:userId      ask them (accepts theirs if they already asked me)
// POST   /api/friends/requests/:userId/accept
// POST   /api/friends/requests/:userId/decline   (silent)
// DELETE /api/friends/requests/:userId      withdraw my request (silent)
// POST   /api/friends/link/:code            opened their invite link → friends straight away
// DELETE /api/friends/:userId               remove friend (silent)
// POST   /api/friends/blocks/:userId        block · DELETE to unblock
//
// Card: { userId, name, avatarThumbUrl, level, rankName, totalXp, streak,
//   longestStreak, joinedAt, friendsSince, relationship }; relationship is
//   self | none | friends | requested | incoming | blocked. Writes return
//   { relationship }. Asking or accepting is refused while the account
//   waits to be deleted (ACCOUNT_PENDING_DELETION).

import { Router } from 'express';
import { verifyToken } from '../middleware/auth.js';
import { blockPendingDeletion } from '../middleware/pendingDeletion.js';
import { friendsLimiter, friendCodeLimiter } from '../middleware/rateLimiter.js';
import { success, error } from '../utils/response.js';
import * as friends from '../services/friendService.js';

const router = Router();

const ERRORS = {
  USER_NOT_FOUND:     [404, 'This hunter could not be found.'],
  INVALID_CODE:       [400, 'That invite code doesn\'t look right. Codes are 6 letters and numbers.'],
  CANNOT_FRIEND_SELF: [400, 'That\'s you.'],
  USER_BLOCKED:       [409, 'You blocked this hunter. Unblock them first.'],
  NO_PENDING_REQUEST: [409, 'This request is no longer waiting.'],
  REQUEST_COOLDOWN:   [429, `You can send this hunter another request after ${friends.REQUEST_COOLDOWN_DAYS} days.`],
  REQUEST_LIMIT:      [429, `You've sent ${friends.DAILY_REQUEST_LIMIT} friend requests today. Try again tomorrow.`],
};

// Wraps a handler: known service errors become their status + code.
const handle = (fn, message) => async (req, res, next) => {
  try {
    return success(res, await fn(req), message);
  } catch (err) {
    const known = ERRORS[err.message];
    if (known) return error(res, known[1], known[0], err.message);
    next(err);
  }
};

router.use(verifyToken, friendsLimiter);

router.get('/card/code/:code', friendCodeLimiter,
  handle((req) => friends.getCard(req.user.id, { code: req.params.code }), 'Hunter found'));
router.get('/card/:userId',
  handle((req) => friends.getCard(req.user.id, { userId: req.params.userId }), 'Hunter found'));

router.get('/requests',
  handle((req) => friends.listIncomingRequests(req.user.id), 'Friend requests'));
router.post('/requests/:userId', blockPendingDeletion,
  handle((req) => friends.sendRequest(req.user.id, req.params.userId), 'Friend request sent'));
router.post('/requests/:userId/accept', blockPendingDeletion,
  handle((req) => friends.acceptRequest(req.user.id, req.params.userId), 'Friend request accepted'));
router.post('/requests/:userId/decline',
  handle((req) => friends.declineRequest(req.user.id, req.params.userId), 'Friend request declined'));
router.delete('/requests/:userId',
  handle((req) => friends.cancelRequest(req.user.id, req.params.userId), 'Friend request cancelled'));

router.post('/link/:code', friendCodeLimiter, blockPendingDeletion,
  handle((req) => friends.addByInviteLink(req.user.id, req.params.code), 'You are now friends'));

router.post('/blocks/:userId',
  handle((req) => friends.blockUser(req.user.id, req.params.userId), 'Hunter blocked'));
router.delete('/blocks/:userId',
  handle((req) => friends.unblockUser(req.user.id, req.params.userId), 'Hunter unblocked'));

router.delete('/:userId',
  handle((req) => friends.removeFriend(req.user.id, req.params.userId), 'Friend removed'));

export default router;
