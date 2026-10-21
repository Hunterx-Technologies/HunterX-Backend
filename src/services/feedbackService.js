// src/services/feedbackService.js — "Send Feedback" screen
//
// Saves feedback first, then best-effort pings the team on Discord
// (see discordService.js) — the Discord side never affects what the
// user sees back.

import prisma            from '../config/prisma.js';
import { notifyFeedback } from './discordService.js';
import { createNotification } from './notificationService.js';
import { logError }       from '../utils/logger.js';

export const FEEDBACK_CATEGORIES = ['bug_report', 'suggestion', 'other'];
export const FEEDBACK_STATUSES   = ['received', 'in_review', 'resolved'];

const MAX_MESSAGE_LENGTH = 1000;
const MAX_META_LENGTH    = 30; // matches feedback.app_version / device_os VARCHAR(30)
const truncateMeta = (value) => (typeof value === 'string' ? value.slice(0, MAX_META_LENGTH) : null);

// user-facing shape — never includes anything Discord-related
function toPublicFeedback(row) {
  return {
    id:             row.id.toString(),
    category:       row.category,
    message:        row.message,
    attachmentUrl:  row.attachment_url,
    allowFollowup:  row.allow_followup,
    status:         row.status,
    createdAt:      row.created_at,
  };
}

// ── Create ────────────────────────────────────────────────
// user comes from req.user (verifyToken) — id and hunter_id are trusted
// server-side and never taken from the request body. app_version/device_os
// are self-reported by the client (same pattern as ratingService.js) since
// there's no other way for the backend to know them; user_id and user_level
// are the fields a client could otherwise try to spoof, so those are always
// derived here, never read off req.body.
export async function submitFeedback(user, { category, message, attachmentUrl, allowFollowup, app_version, device_os }) {
  if (!FEEDBACK_CATEGORIES.includes(category)) {
    throw new Error('INVALID_CATEGORY');
  }
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('MESSAGE_REQUIRED');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new Error('MESSAGE_TOO_LONG');
  }

  if (attachmentUrl &&
      (typeof attachmentUrl !== 'string' || attachmentUrl.length > 500 || !/^https:\/\//.test(attachmentUrl))) {
    throw new Error('INVALID_ATTACHMENT_URL');
  }

  const bUserId = typeof user.id === 'bigint' ? user.id : BigInt(user.id);

  const progression = await prisma.user_progression.findUnique({
    where:  { user_id: bUserId },
    select: { current_level: true },
  });

  const feedback = await prisma.feedback.create({
    data: {
      user_id:        bUserId,
      category,
      message,
      attachment_url: attachmentUrl || null,
      allow_followup: allowFollowup !== false, // defaults true unless explicitly false
      app_version:    truncateMeta(app_version),
      device_os:      truncateMeta(device_os),
      user_level:     progression?.current_level ?? null,
    },
  });

  // notifyFeedback never throws (it catches internally) — a Discord outage
  // or bad webhook URL must never fail a submission that's already saved.
  await notifyFeedback(feedback, user);

  return { feedbackId: feedback.id.toString(), status: feedback.status };
}

// ── List (self) ───────────────────────────────────────────
export async function getMyFeedback(userId) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  const rows = await prisma.feedback.findMany({
    where:   { user_id: bUserId },
    orderBy: { created_at: 'desc' },
  });

  return rows.map(toPublicFeedback);
}

// ── Update status (admin) ────────────────────────────────
export async function updateFeedbackStatus(feedbackId, status) {
  if (!FEEDBACK_STATUSES.includes(status)) {
    throw new Error('INVALID_STATUS');
  }

  let bFeedbackId;
  try {
    bFeedbackId = BigInt(feedbackId);
  } catch {
    throw new Error('INVALID_FEEDBACK_ID');
  }

  const previous = await prisma.feedback.findUnique({
    where:  { id: bFeedbackId },
    select: { status: true },
  });

  let updated;
  try {
    updated = await prisma.feedback.update({
      where: { id: bFeedbackId },
      data:  { status, updated_at: new Date() },
    });
  } catch (err) {
    if (err.code === 'P2025') throw new Error('FEEDBACK_NOT_FOUND');
    throw err;
  }

  if (previous && previous.status !== status) {
    // Best-effort — a push hiccup never fails the admin's status change.
    await notifyFeedbackStatus(updated).catch((err) =>
      logError(`Feedback status push failed for #${updated.id}: ${err.message}`)
    );
  }
  return toPublicFeedback(updated);
}

// Only to users who ticked "allow follow-up" on the report, and only for
// forward progress (received is the initial state, never announced).
const STATUS_MESSAGES = {
  in_review: (id) => ({ title: 'Your report is under review', body: `Report #${id} is with the team now. We'll let you know when it's resolved.` }),
  resolved:  (id) => ({ title: 'Report resolved', body: `Report #${id} has been resolved. Thanks for helping the System get stronger, Hunter.` }),
};

async function notifyFeedbackStatus(feedback) {
  const message = STATUS_MESSAGES[feedback.status];
  if (!message || !feedback.user_id || !feedback.allow_followup) return;

  const id = feedback.id.toString();
  const { title, body } = message(id);
  await createNotification(
    prisma, feedback.user_id, 'FEEDBACK_UPDATE', title, body,
    { event: 'FEEDBACK_UPDATE', feedback_id: id, status: feedback.status },
    { dedupeKey: `feedback:${id}:${feedback.status}` }
  );
}
