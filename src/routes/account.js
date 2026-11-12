// src/routes/account.js — The signed-in hunter's account deletion
// (30-day grace period, see services/accountDeletionService.js).

import { Router }         from 'express';
import { verifyToken }    from '../middleware/auth.js';
import { authLimiter }    from '../middleware/rateLimiter.js';
import { success, error } from '../utils/response.js';
import { createDeletionLink, cancelDeletion } from '../services/accountDeletionService.js';

const router = Router();

// ── POST /api/account/delete/link ─────────────────────────
// A one-time (10-minute) link to the website's delete-account page, which
// confirms and schedules the deletion. Returns { url, expiresInSeconds }.
router.post('/delete/link', authLimiter, verifyToken, async (req, res, next) => {
  try {
    const link = await createDeletionLink(req.user.id);
    return success(res, link, 'Deletion link created');
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND')
      return error(res, 'User not found', 404, 'ACCOUNT_NOT_FOUND');
    if (err.message === 'CANNOT_DELETE_ADMIN')
      return error(res, 'Admin accounts cannot be deleted from the app', 403, 'CANNOT_DELETE_ADMIN');
    if (err.message === 'WEBSITE_URL_NOT_SET')
      return error(res, 'Account deletion is not available right now. Please try again later.', 503, 'NOT_CONFIGURED');
    next(err);
  }
});

// ── POST /api/account/delete/cancel ───────────────────────
// "Keep my account": cancels a scheduled deletion.
router.post('/delete/cancel', verifyToken, async (req, res, next) => {
  try {
    await cancelDeletion(req.user.id);
    return success(res, null, 'Your account will not be deleted.');
  } catch (err) {
    if (err.message === 'USER_NOT_FOUND')
      return error(res, 'User not found', 404, 'ACCOUNT_NOT_FOUND');
    if (err.message === 'NO_PENDING_DELETION')
      return error(res, 'Your account is not scheduled for deletion.', 409, 'NO_PENDING_DELETION');
    if (err.message === 'DELETION_ALREADY_DUE')
      return error(res, 'Your account\'s deletion date has passed, so it can no longer be kept.', 409, 'DELETION_ALREADY_DUE');
    next(err);
  }
});

export default router;
