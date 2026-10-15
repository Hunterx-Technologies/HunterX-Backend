// src/routes/notifications.js — In-app notification inbox (Home bell icon).
// Rows are written by notificationService.createNotification; this only
// reads them and marks them read. See notificationService.js#listNotifications.

import { Router }         from 'express';
import { verifyToken }    from '../middleware/auth.js';
import { success, error } from '../utils/response.js';
import * as notificationService from '../services/notificationService.js';
import * as pushTestService from '../services/pushTestService.js';

const router = Router();

// ── POST /api/notifications/test ──────────────────────────
// Device testing: sends the caller a push immediately (ignores settings,
// quiet hours and the daily cap). 404 in production unless
// PUSH_TEST_ENABLED=true. Body (all optional):
//   { type: 'BROADCAST' | 'LEVEL_UP' | ... , title, body, url: '/rewards' }
// Returns { notification_id, type, url, devices, push_status, push_error }.
router.post('/test', verifyToken, async (req, res, next) => {
  if (!pushTestService.isPushTestEnabled()) return error(res, 'Not found', 404);
  try {
    const result = await pushTestService.sendTestPush(req.user.id, req.body || {});
    const message = result.devices === 0
      ? 'No device registered for this user — open the app and allow notifications first'
      : `Test push ${result.push_status === 'SENT' ? 'sent' : result.push_status?.toLowerCase()}`;
    return success(res, result, message);
  } catch (err) {
    if (err.message === 'INVALID_TYPE')
      return error(res, 'type must be a notification type, e.g. BROADCAST, LEVEL_UP, REWARD_READY', 400);
    if (err.message === 'INVALID_URL')
      return error(res, "url must be an app route like '/rewards'", 400);
    next(err);
  }
});

// ── GET /api/notifications?cursor=<id>&limit=20 ───────────
// Newest first. Returns { notifications, next_cursor, unread_count }.
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const result = await notificationService.listNotifications(req.user.id, {
      cursor: req.query.cursor,
      limit:  req.query.limit,
    });
    return success(res, result, 'Notifications fetched successfully');
  } catch (err) {
    if (err.message === 'INVALID_CURSOR')
      return error(res, 'Invalid cursor', 400);
    next(err);
  }
});

// ── GET /api/notifications/unread-count ───────────────────
// Cheap poll for the bell badge.
router.get('/unread-count', verifyToken, async (req, res, next) => {
  try {
    const unread_count = await notificationService.getUnreadCount(req.user.id);
    return success(res, { unread_count }, 'Unread count fetched successfully');
  } catch (err) {
    next(err);
  }
});

// ── POST /api/notifications/read ──────────────────────────
// Body: { ids: ["12", "13"] } or { all: true }. Returns { unread_count }.
router.post('/read', verifyToken, async (req, res, next) => {
  try {
    const { ids, all } = req.body || {};
    const result = await notificationService.markNotificationsRead(req.user.id, { ids, all: all === true });
    return success(res, result, 'Notifications marked as read');
  } catch (err) {
    if (err.message === 'INVALID_IDS')
      return error(res, 'ids must be a non-empty array of up to 100 notification ids, or pass all: true', 400);
    next(err);
  }
});

export default router;
