// src/routes/admin.js — Admin-only endpoints

import { Router }            from 'express';
import multer                from 'multer';
import { verifyToken }       from '../middleware/auth.js';
import { verifyAdmin }       from '../middleware/adminAuth.js';
import { success, error }    from '../utils/response.js';
import * as adminTaskService from '../services/adminTaskService.js';
import * as feedbackService  from '../services/feedbackService.js';
import * as adminUserService from '../services/adminUserService.js';
import * as broadcastService from '../services/broadcastService.js';
import * as adminRewardService from '../services/adminRewardService.js';
import * as taskProofService from '../services/taskProofService.js';

const router = Router();

// Task images arrive as multipart files, held in memory only long enough
// to compress and push to Cloudinary (see imageUploadService.js).
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // keep in sync with HunterX-Admin lib/upload-limits.ts
const taskImageUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_IMAGE_BYTES, files: 2 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('INVALID_IMAGE')),
}).fields([{ name: 'image_male', maxCount: 1 }, { name: 'image_female', maxCount: 1 }]);

function handleTaskImages(req, res, next) {
  taskImageUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return error(res, 'Each image must be 2MB or smaller', 400);
    if (err.message === 'INVALID_IMAGE') return error(res, 'Images must be image files (jpg, png, webp, ...)', 400);
    if (err instanceof multer.MulterError) return error(res, 'Only image_male and image_female files are accepted', 400);
    next(err);
  });
}

// Multipart fields are all strings — convert them back to the types the
// JSON body would carry. JSON requests pass through untouched.
const NUMBER_FIELDS  = ['xp_reward', 'target_value', 'price', 'proof_count'];
const BOOLEAN_FIELDS = ['is_recurring', 'allows_partial', 'is_paid', 'is_active'];

function coerceMultipartTaskBody(body) {
  const out = { ...body };
  for (const f of NUMBER_FIELDS)
    if (typeof out[f] === 'string') out[f] = out[f].trim() === '' ? undefined : Number(out[f]);
  for (const f of BOOLEAN_FIELDS)
    if (out[f] === 'true' || out[f] === 'false') out[f] = out[f] === 'true';
  for (const f of Object.keys(out)) if (out[f] === '') out[f] = undefined;
  return out;
}

// ── POST /api/admin/notifications/broadcast ───────────────
// Send an announcement (push + inbox) to an audience. See broadcastService.js.
// Body: { title (≤65), body (≤240), url?: '/rewards',
//         audience: 'all' | 'inactive' | 'users',
//         inactive_days?: 1–365 (audience=inactive), user_ids?: [...] (audience=users),
//         dry_run?: true → recipient counts only, nothing sent }
// Returns { dry_run, broadcast_id?, recipients, reachable_by_push }.
router.post('/notifications/broadcast', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await broadcastService.createBroadcast(req.user.id, req.body);
    return success(res, result, result.dry_run ? 'Broadcast preview' : 'Broadcast queued', result.dry_run ? 200 : 201);
  } catch (err) {
    const badRequest = {
      TITLE_REQUIRED:        'title is required',
      TITLE_TOO_LONG:        'title cannot exceed 65 characters',
      BODY_REQUIRED:         'body is required',
      BODY_TOO_LONG:         'body cannot exceed 240 characters',
      INVALID_URL:           "url must be an app route like '/rewards'",
      INVALID_AUDIENCE:      `audience must be one of: ${broadcastService.BROADCAST_AUDIENCES.join(', ')}`,
      INVALID_INACTIVE_DAYS: 'inactive_days must be a whole number from 1 to 365',
      INVALID_USER_IDS:      'user_ids must be a non-empty array of up to 5000 user ids',
    };
    if (badRequest[err.message]) return error(res, badRequest[err.message], 400);
    next(err);
  }
});

// ── GET /api/admin/notifications/broadcasts?limit=20 ──────
// Past broadcasts, newest first, with recipients / pushed / pending /
// not_pushed / read counts.
router.get('/notifications/broadcasts', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const broadcasts = await broadcastService.listBroadcasts({ limit: req.query.limit });
    return success(res, { broadcasts }, 'Broadcasts fetched successfully');
  } catch (err) {
    next(err);
  }
});

// 400 messages shared by task create + edit (adminTaskService throws the keys).
const TASK_ERRORS = {
  TITLE_REQUIRED:                'Title is required',
  INVALID_TASK_TYPE:             "task_type must be 'DAILY_ADMIN', 'WEEKLY', or 'MONTHLY' (DAILY_FIXED is seed-managed)",
  IS_RECURRING_REQUIRED:         'is_recurring must be true or false',
  INVALID_ALLOWS_PARTIAL:        'allows_partial must be true or false',
  INVALID_IS_PAID:               'is_paid must be true or false',
  INVALID_TARGET_VALUE:          'target_value must be a non-negative number',
  XP_REWARD_REQUIRED:            'xp_reward is required',
  INVALID_XP_REWARD:             'xp_reward must be a positive integer',
  XP_REWARD_EXCEEDS_CAP:         'xp_reward exceeds the cap for this task type (10 for DAILY_ADMIN, 70 for WEEKLY, 300 for MONTHLY)',
  XP_REWARD_TOO_LOW_FOR_PARTIAL: 'xp_reward must be at least 2 when allows_partial is true',
  PRICE_REQUIRED:                'price must be a positive number when is_paid is true',
  INVALID_PRICE:                 'price can have at most 2 decimal places',
  END_DATE_REQUIRED_FOR_PAID:    'end_date is required for paid tasks (last day of the offer and of access)',
  START_DATE_REQUIRED:           'start_date is required',
  INVALID_START_DATE:            'start_date must be a valid YYYY-MM-DD date',
  START_DATE_IN_PAST:            'start_date cannot be in the past',
  INVALID_END_DATE:              'end_date must be a valid YYYY-MM-DD date',
  END_DATE_BEFORE_START_DATE:    'end_date cannot be before start_date',
  END_DATE_TOO_SOON:             'end_date must be at least 6 days after start_date for a recurring WEEKLY task (a full 7-day week)',
  INVALID_IMAGE:                 'An uploaded image could not be read',
  INVALID_IS_ACTIVE:             'is_active must be true or false',
  INVALID_PROOF_COUNT:           'proof_count must be a whole number from 0 (no proof) to 5',
  INVALID_SPECIAL_REWARD:        'special_reward_id must be one of the special rewards (Rewards → Special rewards)',
  SPECIAL_REWARD_LOCKED:         "Hunters have already received this task's special reward, so it can't be changed or removed — switch the reward off instead",
  END_DATE_IN_PAST:              'end_date cannot be in the past',
  TASK_HAS_BUYERS:               'This task has buyers, so it cannot be changed from paid to free',
  TASK_NOT_EDITABLE:             'Routine (DAILY_FIXED) tasks are seed-managed and cannot be edited here',
};

// ── GET /api/admin/tasks ──────────────────────────────────
// Every task, active and inactive (is_active), newest first. Admin-only.
// Returns { tasks }.
router.get('/tasks', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const tasks = await adminTaskService.listTasks();
    return success(res, { tasks }, 'Tasks fetched');
  } catch (err) {
    next(err);
  }
});

// ── POST /api/admin/tasks ─────────────────────────────────
// Create a DAILY_ADMIN, WEEKLY or MONTHLY task, one-time or recurring,
// free or paid. DAILY_FIXED isn't creatable here — those 3 routine tasks
// are seed-managed (prisma/seed.js), not admin-authored.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
// Content-Type: multipart/form-data (with images) or application/json.
//
// Body:
//   title, task_type: 'DAILY_ADMIN' | 'WEEKLY' | 'MONTHLY',
//   is_recurring: boolean,             // false = one-time, true = repeats
//   start_date: 'YYYY-MM-DD',          // required, cannot be in the past
//   end_date?: 'YYYY-MM-DD',           // required for paid tasks; for free ones used if sent, otherwise one-time tasks derive it:
//                                       //   DAILY_ADMIN -> start_date (single day)
//                                       //   WEEKLY      -> start_date + 6 (7 days)
//                                       //   MONTHLY     -> start_date + 29 (30 days)
//                                       // and recurring tasks have no end
//   description?, tag?,
//   image_male?, image_female?          // multipart image files (≤2MB each), compressed to WebP and
//                                       // stored on Cloudinary — same for free and paid tasks
//   image_url?, image_url_male?, image_url_female?  // or existing URLs (JSON body)
//   xp_reward,                         // required, capped at 10 / 70 / 300 by task_type
//   allows_partial?,                   // partial XP is always xp_reward / 2 (rounded down)
//   target_value?, target_unit?,
//   special_reward_id?: id | null,     // optional special reward (Rewards → Special); every hunter who
//                                       // completes the task gets one card from it. 'none' clears it (multipart).
//   proof_count?: 0–5,                 // photos the hunter must upload; 0 = none. Proof tasks are
//                                       // reviewed (GET/POST /tasks/review-queue) before XP is paid
//   is_paid?: boolean,                 // default false
//   price?: number,                    // INR, required when is_paid (e.g. 199 or 199.50)
//                                       // Paid: shown locked start_date..end_date; a buyer gets access
//                                       // from the day they pay to end_date; deactivated after end_date
//
// Every task is shown every day from start_date to end_date. WEEKLY /
// MONTHLY tasks can be completed once per 7 / 30-day period within that.

router.post('/tasks', verifyToken, verifyAdmin, handleTaskImages, async (req, res, next) => {
  try {
    const body  = req.is('multipart/form-data') ? coerceMultipartTaskBody(req.body) : req.body;
    const files = {
      image_male:   req.files?.image_male?.[0]?.buffer,
      image_female: req.files?.image_female?.[0]?.buffer,
    };
    const task = await adminTaskService.createTask(req.user.id, body, files);
    return success(res, { task }, 'Task created', 201);
  } catch (err) {
    if (TASK_ERRORS[err.message]) return error(res, TASK_ERRORS[err.message], 400);
    next(err);
  }
});

// ── Proof review queue ────────────────────────────────────
// See taskProofService.js. Admin-only.
// GET  /api/admin/tasks/review-queue?status=IN_REVIEW|RESUBMIT|REJECTED|COMPLETED&cursor=
//      → { items, next_cursor, counts: { in_review, resubmit, rejected, completed } }
//      IN_REVIEW is the queue (oldest first); the others are past decisions.
// POST /api/admin/tasks/review-queue/:id/decision
//      { decision: 'APPROVE' | 'RESUBMIT' | 'REJECT', note? } — note (≤300)
//      is required for RESUBMIT / REJECT and shown to the hunter.
const REVIEW_ERRORS = {
  INVALID_REVIEW_STATUS: [400, `status must be one of: ${taskProofService.REVIEW_STATUSES.join(', ')}`],
  INVALID_CURSOR:        [400, 'Invalid cursor'],
  INVALID_DECISION:      [400, 'decision must be APPROVE, RESUBMIT or REJECT'],
  NOTE_REQUIRED:         [400, 'Give the hunter a reason when asking for new proof or rejecting'],
  NOTE_TOO_LONG:         [400, 'The reason must be 300 characters or fewer'],
  REVIEW_NOT_FOUND:      [404, 'Submission not found'],
  REVIEW_NOT_PENDING:    [409, 'This submission has already been reviewed'],
};

router.get('/tasks/review-queue', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await taskProofService.listReviewQueue({
      status: req.query.status ? String(req.query.status).toUpperCase() : 'IN_REVIEW',
      cursor: req.query.cursor,
    });
    return success(res, result, 'Review queue fetched');
  } catch (err) {
    const known = REVIEW_ERRORS[err.message];
    if (known) return error(res, known[1], known[0], err.message);
    next(err);
  }
});

router.post('/tasks/review-queue/:id/decision', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const item = await taskProofService.reviewProof(req.user.id, req.params.id, req.body || {});
    return success(res, { item }, 'Review saved');
  } catch (err) {
    const known = REVIEW_ERRORS[err.message];
    if (known) return error(res, known[1], known[0], err.message);
    next(err);
  }
});

// ── GET /api/admin/tasks/:id/assignment-stats ─────────────
// { users_assigned, shown_today, first_shown_on, last_shown_on,
//   users_completed, completions, completion_rate } — see adminTaskService.js.
router.get('/tasks/:id/assignment-stats', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    return success(res, await adminTaskService.getTaskAssignmentStats(req.params.id), 'Assignment stats fetched');
  } catch (err) {
    if (err.message === 'TASK_NOT_FOUND') return error(res, 'Task not found', 404);
    next(err);
  }
});

// ── DELETE /api/admin/tasks/:id ───────────────────────────
// Permanently deletes a task no hunter has been assigned, completed,
// bought or earned XP from (GET /tasks marks these can_delete), along with
// its images. Anything else: 409 TASK_IN_USE — deactivate it instead.
router.delete('/tasks/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    await adminTaskService.deleteTask(req.params.id);
    return success(res, { deleted: true }, 'Task deleted');
  } catch (err) {
    if (err.message === 'TASK_NOT_FOUND') return error(res, 'Task not found', 404);
    if (err.message === 'TASK_NOT_EDITABLE') return error(res, "Built-in daily tasks can't be deleted", 400);
    if (err.message === 'TASK_IN_USE')
      return error(res, 'Hunters have already been assigned this task, so it can only be deactivated', 409, 'TASK_IN_USE');
    next(err);
  }
});

// ── PATCH /api/admin/tasks/:id ────────────────────────────
// Edit any task created via POST /tasks, free or paid. Send only the
// fields to change (same names, types and content types as create —
// multipart for new image_male / image_female files); everything else
// keeps its current value, and the merged task must pass the same rules
// as create. Extra field: is_active (true/false) to switch a task off/on.
// Built-in daily tasks accept only { is_active }.
//
// Edit-only rules:
//   - start_date / end_date are only checked against "today" if changed,
//     so a task that's already running stays editable.
//   - Moving a one-time free task's start_date without an end_date
//     re-derives end_date (1 / 7 / 30 days).
//   - Paid tasks: existing buyers are never affected — their access_end
//     and amount paid are fixed. A later end_date extends the offer (and
//     reactivates it if the nightly cron already switched it off); a new
//     price applies to new buyers only.
//   - Paid -> free is refused once anyone has bought it.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)

router.patch('/tasks/:id', verifyToken, verifyAdmin, handleTaskImages, async (req, res, next) => {
  try {
    if (!/^\d+$/.test(String(req.params.id))) return error(res, 'Invalid task id', 400);

    const body  = req.is('multipart/form-data') ? coerceMultipartTaskBody(req.body) : req.body;
    const files = {
      image_male:   req.files?.image_male?.[0]?.buffer,
      image_female: req.files?.image_female?.[0]?.buffer,
    };
    const task = await adminTaskService.updateTask(req.params.id, body, files);
    return success(res, { task }, 'Task updated');
  } catch (err) {
    if (TASK_ERRORS[err.message]) return error(res, TASK_ERRORS[err.message], 400);
    if (err.message === 'TASK_NOT_FOUND') return error(res, 'Task not found', 404);
    next(err);
  }
});

// ── PATCH /api/admin/feedback/:id/status ──────────────────
// Admin-only. Updates a feedback submission's review status.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
router.patch('/feedback/:id/status', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const feedback = await feedbackService.updateFeedbackStatus(req.params.id, status);
    return success(res, { feedback }, 'Feedback status updated');
  } catch (err) {
    if (err.message === 'INVALID_STATUS')
      return error(res, `status must be one of: ${feedbackService.FEEDBACK_STATUSES.join(', ')}`, 400);
    if (err.message === 'INVALID_FEEDBACK_ID')
      return error(res, 'Invalid feedback id', 400);
    if (err.message === 'FEEDBACK_NOT_FOUND')
      return error(res, 'Feedback not found', 404);
    next(err);
  }
});

// ── GET /api/admin/users/stats ────────────────────────────
// Admin-only. The 4 summary cards above the Users table (total users,
// active today, avg level, avg streak) — always whole-roster, unaffected
// by the table's own filters below.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
router.get('/users/stats', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const stats = await adminUserService.getUserStats();
    return success(res, { stats }, 'User stats fetched');
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/users/ranks ────────────────────────────
// Admin-only. Distinct rank list for the "All Ranks" filter dropdown,
// ordered lowest-level-first.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
router.get('/users/ranks', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const ranks = await adminUserService.getRanks();
    return success(res, { ranks }, 'Ranks fetched');
  } catch (err) {
    next(err);
  }
});

// ── GET /api/admin/users ──────────────────────────────────
// Admin-only. Search/filter/paginate the user roster.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
// Query: search?, rank?, level? ("1-10"), status? (ACTIVE|BANNED),
//        date_preset? (7d|30d|90d|all), start_date?, end_date? (YYYY-MM-DD),
//        sort_by? (signup_date|name|level|streak), page?, limit? (max 100)
router.get('/users', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const data = await adminUserService.listUsers(req.query);
    return success(res, data, 'Users fetched');
  } catch (err) {
    const badRequest = {
      INVALID_STATUS:          `status must be one of: ${['ACTIVE', 'BANNED'].join(', ')}`,
      INVALID_RANK:             'Unknown rank',
      INVALID_LEVEL_RANGE:      "level must be a range like '1-10'",
      INVALID_SORT_BY:          'sort_by must be one of: signup_date, name, level, streak',
      INVALID_DATE_PRESET:      'date_preset must be one of: 7d, 30d, 90d, all',
      INVALID_START_DATE:       'start_date must be a valid YYYY-MM-DD date',
      INVALID_END_DATE:         'end_date must be a valid YYYY-MM-DD date',
      START_AFTER_END_DATE:     'start_date cannot be after end_date',
    };
    if (badRequest[err.message]) return error(res, badRequest[err.message], 400);
    next(err);
  }
});

// ── GET /api/admin/users/:id ──────────────────────────────
// Admin-only. Full detail for one user — profile, progression, body
// stats, recent activity, badges, rewards, and feedback/ratings.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
router.get('/users/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const user = await adminUserService.getUserDetail(req.params.id);
    return success(res, { user }, 'User fetched');
  } catch (err) {
    if (err.message === 'INVALID_USER_ID') return error(res, 'Invalid user id', 400);
    if (err.message === 'USER_NOT_FOUND') return error(res, 'User not found', 404);
    next(err);
  }
});

// ── PATCH /api/admin/users/:id/ban ────────────────────────
// Admin-only. Suspends the account: every authenticated request (even with
// a still-valid access token), login and token refresh return 403 until
// unbanned. Nothing is deleted. Admin accounts and yourself can't be banned.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
// Body: { reason?: string }  (max 500 chars)
router.patch('/users/:id/ban', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const user = await adminUserService.banUser(req.user.id, req.params.id, req.body?.reason);
    return success(res, { user }, 'User banned');
  } catch (err) {
    const known = {
      INVALID_USER_ID:     [400, 'Invalid user id'],
      BAN_REASON_TOO_LONG: [400, 'reason must be at most 500 characters'],
      CANNOT_BAN_SELF:     [400, 'You cannot ban your own account'],
      CANNOT_BAN_ADMIN:    [403, 'Admin accounts cannot be banned'],
      USER_NOT_FOUND:      [404, 'User not found'],
      ALREADY_BANNED:      [409, 'User is already banned'],
    }[err.message];
    if (known) return error(res, known[1], known[0]);
    next(err);
  }
});

// ── PATCH /api/admin/users/:id/unban ──────────────────────
// Admin-only. Lifts the suspension — the user can log in again and keeps
// all their progress. Clears the stored ban reason.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
router.patch('/users/:id/unban', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const user = await adminUserService.unbanUser(req.user.id, req.params.id);
    return success(res, { user }, 'User unbanned');
  } catch (err) {
    const known = {
      INVALID_USER_ID: [400, 'Invalid user id'],
      USER_NOT_FOUND:  [404, 'User not found'],
      NOT_BANNED:      [409, 'User is not banned'],
    }[err.message];
    if (known) return error(res, known[1], known[0]);
    next(err);
  }
});

// ── POST /api/admin/users/:id/reset-streak ────────────────
// Admin-only. Sets the current daily streak to 0 (longest streak and
// banked streak lives are kept). Their next completion starts at 1.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
router.post('/users/:id/reset-streak', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const user = await adminUserService.resetUserStreak(req.user.id, req.params.id);
    return success(res, { user }, 'Streak reset');
  } catch (err) {
    const known = {
      INVALID_USER_ID: [400, 'Invalid user id'],
      USER_NOT_FOUND:  [404, 'User not found'],
      NO_PROGRESSION:  [404, 'User has no progression record'],
    }[err.message];
    if (known) return error(res, known[1], known[0]);
    next(err);
  }
});

// ── POST /api/admin/admins ────────────────────────────────
// Create a new ADMIN-role account. Admin-only — there is no other way
// to reach ADMIN through the API; the first admin is seeded at deploy
// time (see adminBootstrapService.js) and every one after that is
// created by an existing admin here.
// Header: Authorization: Bearer <access_token>  (role must be ADMIN)
// Body: { name, email, password } — password must meet the same
// strength rules as the mobile app's signup (8+ chars, upper, number,
// special char).
router.post('/admins', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const { name, email, password } = req.body || {};
    const admin = await adminUserService.createAdmin(req.user.id, { name, email, password });
    return success(res, { admin }, 'Admin created', 201);
  } catch (err) {
    if (err.message === 'NAME_REQUIRED') return error(res, 'name is required', 400);
    if (err.message === 'INVALID_EMAIL') return error(res, 'A valid email is required', 400);
    if (err.message === 'EMAIL_EXISTS') return error(res, 'A user with this email already exists', 409);
    if (err.message === 'WEAK_PASSWORD') {
      return res.status(400).json({
        success: false,
        message: 'Password does not meet requirements',
        errors:  err.errors,
      });
    }
    next(err);
  }
});

// ── Scratch-card reward coupons ───────────────────────────
// See adminRewardService.js. All admin-only. Rewards are managed per kind
// (/rewards/streaks, /rewards/levels, /rewards/birthday — see below);
// coupons by their own id:
//   PATCH  /api/admin/rewards/coupons/:id              any subset of the coupon body
//   DELETE /api/admin/rewards/coupons/:id              hard delete, or deactivate if already awarded
// Coupon body: { title, coupon_code, discount_type: PERCENT|FLAT, discount_value,
//   currency? (FLAT), weight? (1–100, default 1), total_quantity? (null = unlimited),
//   valid_from?, valid_until?, valid_days_after_award?, description?,
//   product_name?, product_category?, is_active? }
// Coupon create/update also accept multipart/form-data with the same
// fields plus a `product_image` file (≤2MB; compressed to WebP, max
// 1200px) and, on update, remove_product_image=true to clear it.
// Images can't be set by URL.

// Coupon product images arrive as one multipart file (`product_image`),
// held in memory just long enough to compress and upload (adminRewardService.js).
const couponImageUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_IMAGE_BYTES, files: 1 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('INVALID_IMAGE')),
}).single('product_image');

function handleCouponImage(req, res, next) {
  couponImageUpload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return error(res, 'The image must be 2MB or smaller', 400);
    if (err.message === 'INVALID_IMAGE') return error(res, 'The product image must be an image file (jpg, png, webp, ...)', 400);
    if (err instanceof multer.MulterError) return error(res, 'Only one product_image file is accepted', 400);
    next(err);
  });
}

// Multipart fields are all strings; booleans go back to booleans. Empty
// strings stay as-is — they mean "clear this field" (e.g. no quantity limit).
function coerceMultipartCouponBody(body) {
  const out = { ...body };
  for (const f of ['is_active', 'remove_product_image'])
    if (out[f] === 'true' || out[f] === 'false') out[f] = out[f] === 'true';
  return out;
}

const couponBody = (req) => (req.is('multipart/form-data') ? coerceMultipartCouponBody(req.body || {}) : req.body || {});

function handleRewardAdminError(res, next, err) {
  if (err.message === 'INVALID_COUPON')       return error(res, err.reason, 400);
  if (err.message === 'INVALID_IMAGE')        return error(res, "That file couldn't be read as an image", 400);
  if (err.message === 'INVALID_STREAK_DAYS')  return error(res, 'value (streak days) must be a whole number from 1 to 3650', 400);
  if (err.message === 'INVALID_LEVEL')        return error(res, 'value must be an existing level number', 400);
  if (err.message === 'TRIGGER_EXISTS')       return error(res, 'That reward trigger already exists', 409);
  if (err.message === 'TRIGGER_NOT_FOUND')    return error(res, 'Reward trigger not found', 404);
  if (err.message === 'COUPON_NOT_FOUND')     return error(res, 'Coupon not found', 404);
  next(err);
}

// One API group per reward kind — the admin Rewards page has a tab for each:
//   /api/admin/rewards/streaks   streak milestones (value = streak days)
//   /api/admin/rewards/levels    level-ups (value = level number)
//   /api/admin/rewards/birthday  the birthday reward (at most one, no value)
//   /api/admin/rewards/special   special rewards, linked to tasks (POST { description: name });
//                                each lists the tasks it's linked to
// Each supports:
//   GET    /                → { rewards }  (newest-numbered last; birthday: 0 or 1 item)
//   POST   /                { value, description? } (birthday: no body)
//   PATCH  /:id             { is_active } — switch it off (no new cards) or on
//   DELETE /:id             only while it has never given anyone a card;
//                           deletes its coupons and their images too
//   POST   /:id/coupons     coupon body (below), multipart with an optional image
// An :id of another kind is 404. Coupons are edited/deleted by their own
// id under /api/admin/rewards/coupons/:id (below).
const REWARD_KIND_PATHS = { streaks: 'STREAK', levels: 'LEVEL_UP', birthday: 'BIRTHDAY', special: 'TASK' };

for (const [path, kind] of Object.entries(REWARD_KIND_PATHS)) {
  const base = `/rewards/${path}`;

  router.get(base, verifyToken, verifyAdmin, async (req, res, next) => {
    try {
      const rewards = await adminRewardService.listTriggers(kind);
      return success(res, { rewards }, 'Rewards fetched');
    } catch (err) {
      handleRewardAdminError(res, next, err);
    }
  });

  router.post(base, verifyToken, verifyAdmin, async (req, res, next) => {
    try {
      const { value, description } = req.body || {};
      const reward = await adminRewardService.createTrigger({ kind, value, description });
      return success(res, { reward }, 'Reward created', 201);
    } catch (err) {
      handleRewardAdminError(res, next, err);
    }
  });

  router.patch(`${base}/:id`, verifyToken, verifyAdmin, async (req, res, next) => {
    try {
      const reward = await adminRewardService.setTriggerActive(req.params.id, req.body?.is_active, kind);
      return success(res, { reward }, reward.is_active ? 'Reward switched on' : 'Reward switched off');
    } catch (err) {
      handleRewardAdminError(res, next, err);
    }
  });

  router.delete(`${base}/:id`, verifyToken, verifyAdmin, async (req, res, next) => {
    try {
      await adminRewardService.deleteTrigger(req.params.id, kind);
      return success(res, { deleted: true }, 'Reward deleted');
    } catch (err) {
      if (err.message === 'TRIGGER_IN_USE')
        return error(res, 'Hunters have already received cards from this reward, so it can only be switched off', 409, 'TRIGGER_IN_USE');
      handleRewardAdminError(res, next, err);
    }
  });

  router.post(`${base}/:id/coupons`, verifyToken, verifyAdmin, handleCouponImage, async (req, res, next) => {
    try {
      const coupon = await adminRewardService.createCoupon(req.params.id, couponBody(req), req.file?.buffer ?? null, kind);
      return success(res, { coupon }, 'Coupon created', 201);
    } catch (err) {
      handleRewardAdminError(res, next, err);
    }
  });
}

router.patch('/rewards/coupons/:id', verifyToken, verifyAdmin, handleCouponImage, async (req, res, next) => {
  try {
    const coupon = await adminRewardService.updateCoupon(req.params.id, couponBody(req), req.file?.buffer ?? null);
    return success(res, { coupon }, 'Coupon updated');
  } catch (err) {
    handleRewardAdminError(res, next, err);
  }
});

router.delete('/rewards/coupons/:id', verifyToken, verifyAdmin, async (req, res, next) => {
  try {
    const result = await adminRewardService.deleteCoupon(req.params.id);
    return success(res, result, result.deleted ? 'Coupon deleted' : 'Coupon already awarded — deactivated instead');
  } catch (err) {
    handleRewardAdminError(res, next, err);
  }
});

export default router;
