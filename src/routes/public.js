// src/routes/public.js — Unauthenticated endpoints (invite codes, onboarding
// options, the website's account-deletion page)

import { Router }                from 'express';
import { referralLookupLimiter, accountDeletionLimiter } from '../middleware/rateLimiter.js';
import { success, error }        from '../utils/response.js';
import { isValidEmail }          from '../utils/helpers.js';
import * as accountDeletion      from '../services/accountDeletionService.js';
import { lookupReferralCode }    from '../services/referralService.js';
import { listRoutineTasks }      from '../services/routineTaskService.js';

const router = Router();

// ── GET /api/public/referral/:code ────────────────────────
// Public, rate limited. Whether an invite code can be used, plus the
// inviter's display name — nothing else about them. Valid and invalid
// codes get the same status and take the same time (see referralService).
// Response data: { valid: true, inviterName } | { valid: false }
router.get('/referral/:code', referralLookupLimiter, async (req, res, next) => {
  try {
    const result = await lookupReferralCode(req.params.code);
    return success(res, result, 'Referral code checked');
  } catch (err) {
    next(err);
  }
});

// ── GET /api/public/routine-tasks ─────────────────────────
// Public. The routine tasks the onboarding picker offers (built-in +
// admin-marked routine) — the hunter has no account yet at that point.
// Picks are sent with sign-up as routine_task_ids.
router.get('/routine-tasks', async (req, res, next) => {
  try {
    const tasks = await listRoutineTasks();
    return success(res, { tasks }, 'Routine tasks fetched');
  } catch (err) {
    next(err);
  }
});

// ── /api/public/account-deletion/* ─────────────────────────
// The website's delete-account page (HunterX-web
// src/lib/account-deletion-api.ts). Errors carry error.code; the status
// codes are the ones that client maps: 400 invalid, 410 expired, 423 too
// many attempts, 409 nothing to cancel, 429 rate limited.
const DELETION_ERRORS = {
  OTP_INVALID:           [400, 'Invalid code'],
  OTP_EXPIRED:           [410, 'This code has expired'],
  OTP_TOO_MANY_ATTEMPTS: [423, 'Too many attempts'],
  OTP_COOLDOWN:          [429, 'Please wait a minute before requesting another code'],
  INVALID_TOKEN:         [400, 'Invalid link'],
  EXPIRED_TOKEN:         [410, 'This link has expired'],
  NO_PENDING_DELETION:   [409, 'No deletion is pending for this account'],
  DELETION_ALREADY_DUE:  [409, 'This account\'s deletion date has passed, so it can no longer be kept'],
  CANNOT_DELETE_ADMIN:   [403, 'This account cannot be deleted here'],
};

function deletionError(res, next, err) {
  const known = DELETION_ERRORS[err.message];
  if (known) return error(res, known[1], known[0], err.message);
  next(err);
}

const scheduled = (deleteAt) => ({ scheduledFor: new Date(deleteAt).toISOString() });

// Body: { email, purpose: 'delete' | 'cancel' }. Same answer whether or
// not the email has an account.
router.post('/account-deletion/request', accountDeletionLimiter, async (req, res, next) => {
  try {
    const { email, purpose = 'delete' } = req.body || {};
    if (typeof email !== 'string' || !isValidEmail(email.trim()))
      return error(res, 'A valid email is required', 400, 'INVALID_EMAIL');
    if (!['delete', 'cancel'].includes(purpose))
      return error(res, "purpose must be 'delete' or 'cancel'", 400, 'INVALID_PURPOSE');
    await accountDeletion.requestDeletionCode(email, purpose);
    return success(res, null, 'If an account exists for this email, we sent it a code.');
  } catch (err) {
    deletionError(res, next, err);
  }
});

// Body: { email, otp } → { scheduledFor }
router.post('/account-deletion/confirm', accountDeletionLimiter, async (req, res, next) => {
  try {
    const { email, otp } = req.body || {};
    if (typeof email !== 'string' || typeof otp !== 'string')
      return error(res, 'email and otp are required', 400, 'OTP_INVALID');
    const deleteAt = await accountDeletion.confirmDeletionByCode(email, otp);
    return success(res, scheduled(deleteAt), 'Account scheduled for deletion');
  } catch (err) {
    deletionError(res, next, err);
  }
});

// Body: { token } (from the app's one-time link) → { scheduledFor }
router.post('/account-deletion/confirm-token', accountDeletionLimiter, async (req, res, next) => {
  try {
    const deleteAt = await accountDeletion.confirmDeletionByToken(req.body?.token);
    return success(res, scheduled(deleteAt), 'Account scheduled for deletion');
  } catch (err) {
    deletionError(res, next, err);
  }
});

// Body: { email, otp }
router.post('/account-deletion/cancel', accountDeletionLimiter, async (req, res, next) => {
  try {
    const { email, otp } = req.body || {};
    if (typeof email !== 'string' || typeof otp !== 'string')
      return error(res, 'email and otp are required', 400, 'OTP_INVALID');
    await accountDeletion.cancelDeletionByCode(email, otp);
    return success(res, null, 'Your account will not be deleted.');
  } catch (err) {
    deletionError(res, next, err);
  }
});

export default router;
