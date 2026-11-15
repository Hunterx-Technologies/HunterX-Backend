// src/middleware/adminAuth.js — Restrict routes to admin role only

import { error } from '../utils/response.js';
import { runWithAdminTimezone } from '../utils/adminClock.js';

export function verifyAdmin(req, res, next) {
  if (!req.user) {
    return error(res, 'Unauthorized', 401);
  }
  if (req.user.role !== 'ADMIN') {
    return error(res, 'Forbidden — admin access required', 403);
  }
  // Dashboards and date checks use the admin's browser zone for the rest of
  // this request (utils/adminClock.js).
  runWithAdminTimezone(req.headers['x-timezone'], next);
}
