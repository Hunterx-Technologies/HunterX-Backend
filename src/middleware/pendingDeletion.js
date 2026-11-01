// src/middleware/pendingDeletion.js — Refuses quest and reward actions
// while the account waits to be deleted (30-day grace period, see
// accountDeletionService.js). Reading stays allowed; "Keep my account"
// lifts it. Runs after verifyToken.

import { error } from '../utils/response.js';

export function blockPendingDeletion(req, res, next) {
  if (req.user?.delete_at) {
    return error(
      res,
      'Your account is scheduled for deletion. Keep your account to continue.',
      403,
      'ACCOUNT_PENDING_DELETION'
    );
  }
  next();
}
