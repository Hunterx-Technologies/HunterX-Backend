// src/services/accountDeletionService.js — Permanent account deletion.
//
// Backs DELETE /api/users/me, the scheduled deletion below and
// scripts/delete-user.js (App Store Guideline 5.1.1(v): an app that lets
// users create an account must let them delete it in-app). Most user-owned tables cascade from users; the
// relations declared onDelete: NoAction are cleared or unlinked by hand
// first, inside the same transaction, so the final DELETE can't fail on a
// foreign key. The leaderboard's Redis copy is dropped after commit.

import prisma from '../config/prisma.js';
import { removeLeaderboardMember, syncLeaderboardMember } from './leaderboardService.js';
import crypto from 'crypto';
import { createAccountOtp, consumeAccountOtp, OTP_PURPOSES } from './accountOtpService.js';
import { revokeAllSessions } from './sessionService.js';
import { revokeAppleRefreshToken } from './appleTokenService.js';
import { normalizeEmail, sha256 } from '../utils/helpers.js';
import { allowCodeEmail } from '../utils/throttle.js';
import { brandedEmail } from '../utils/emailTemplates.js';
import { sendMail } from '../utils/mailer.js';
import { createNotification } from './notificationService.js';
import { info, logError } from '../utils/logger.js';
import { cleanupUserMedia } from './userMediaCleanupService.js';
import { shiftStreakPastPause } from './streakService.js';
import { extendRewardsPastPause } from './rewardService.js';

export async function deleteUserAccount(userId, { allowAdmin = false } = {}) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  const user = await prisma.users.findUnique({
    where:  { id: bUserId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.role === 'ADMIN' && !allowAdmin) throw new Error('CANNOT_DELETE_ADMIN');

  // Read before the rows cascade away; revoked after commit (below).
  const appleProviders = await prisma.auth_providers.findMany({
    where:  { user_id: bUserId, provider: 'APPLE', apple_refresh_token: { not: null } },
    select: { apple_refresh_token: true },
  });

  await prisma.$transaction(async (tx) => {
    // NoAction relations pointing at this user.
    await tx.users.updateMany({ where: { referred_by: bUserId }, data: { referred_by: null } });
    await tx.tasks.updateMany({ where: { created_by: bUserId }, data: { created_by: null } });
    await tx.discovery_matches.updateMany({ where: { unmatched_by: bUserId }, data: { unmatched_by: null } });
    await tx.messages.deleteMany({ where: { sender_id: bUserId } });
    await tx.referrals.deleteMany({ where: { OR: [{ referrer_id: bUserId }, { referred_id: bUserId }] } });

    if (user.email) {
      await tx.email_otps.deleteMany({ where: { email: { equals: user.email, mode: 'insensitive' } } });
    }

    // Everything else (progression, completions, schedule, XP history,
    // notifications, push tokens, settings, feedback, ratings, purchases,
    // health data, ...) cascades from the users row.
    await tx.users.delete({ where: { id: bUserId } });

    // Cloudinary uploads are removed after commit; this row (no FK, so it
    // outlives the user) makes sure that's retried if it fails or the
    // process dies first — see userMediaCleanupService.js.
    await tx.pending_media_cleanup.deleteMany({ where: { user_id: bUserId } });
    await tx.pending_media_cleanup.create({ data: { user_id: bUserId } });
  });

  await removeLeaderboardMember(bUserId);
  await cleanupUserMedia(bUserId);

  // Sign in with Apple (Guideline 5.1.1(v)): unlink the Apple ID. After the
  // commit so an Apple outage can't block the deletion; failures are logged.
  for (const p of appleProviders) await revokeAppleRefreshToken(p.apple_refresh_token);

  info(`Deleted account ${bUserId}`);
}

// ─────────────────────────────────────────────────────────────
// Scheduled deletion (30-day grace period)
//
// The app's Delete Account opens a one-time link on the website
// (createDeletionLink); the website confirms it (confirmDeletionByToken),
// or — without a link — by an emailed code (requestDeletionCode +
// confirmDeletionByCode). Either way the account is only SCHEDULED: it
// keeps working, quest and reward actions are refused
// (middleware/pendingDeletion.js), and "Keep my account" in the app
// (cancelDeletion) or a code on the website (cancelDeletionByCode) undoes
// it. The hourly purge (cron/accountDeletion.js) deletes accounts whose
// delete_at has passed.
// ─────────────────────────────────────────────────────────────

export const DELETION_GRACE_DAYS = 30;
// Reminders (push + email): once the deletion is DELETION_REMINDER_DAYS
// away, then a final "last day" one within DELETION_LAST_DAY_DAYS of it.
export const DELETION_REMINDER_DAYS = 3;
export const DELETION_LAST_DAY_DAYS = 1;
const LINK_TTL_MS = 10 * 60 * 1000;
const DAY_MS = 86_400_000;
const PROFILE_URL = '/(tabs)/profile';

// "12 December 2026" — the IST calendar day, like the rest of the app.
export function formatDeletionDate(date) {
  return new Date(date).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

const strong = (text) => `<strong style="color:#ffffff;">${text}</strong>`;

const daysText = (n) => `${n} day${n === 1 ? '' : 's'}`;

// Push copy — shared with scripts/send-deletion-test-pushes.js so device
// tests show exactly what hunters will see.
export const DELETION_PUSH = {
  scheduled: (day) => ({
    type:  'ACCOUNT_DELETION',
    title: '⚠️ Account deletion scheduled',
    body:  `Your HunterX account will be permanently deleted on ${day}. Changed your mind? Tap to keep it.`,
  }),
  reminder: (daysLeft, day) => ({
    type:  'ACCOUNT_DELETION_REMINDER',
    title: `⏳ ${daysText(daysLeft)} until your account is deleted`,
    body:  `On ${day} your XP, streaks and rewards are gone for good. Tap Keep my account to stay, Hunter.`,
  }),
  lastDay: () => ({
    type:  'ACCOUNT_DELETION_REMINDER',
    title: '🚨 Last day to keep your account',
    body:  'Within 24 hours your HunterX account and all your XP, streaks and rewards are deleted forever. Tap now to keep it, Hunter.',
  }),
  cancelled: () => ({
    type:  'ACCOUNT_DELETION',
    title: '✅ Your account is safe',
    body:  'Deletion cancelled. Your XP, streaks and rewards stay right where they are.',
  }),
};

// Pushes about the deletion never block or fail the deletion itself.
async function notifyHunter(userId, { type, title, body }, event, options) {
  try {
    return await createNotification(prisma, userId, type, title, body, { event, url: PROFILE_URL }, options);
  } catch (err) {
    logError(`${event} push for ${userId} failed: ${err.message || err}`);
    return null;
  }
}

function mailHunter(user, subject, heading, paragraphs, event) {
  if (!user.email) return Promise.resolve();
  return sendMail({ to: user.email, subject, html: brandedEmail({ heading, paragraphs }) })
    .catch((err) => logError(`${event} email for ${user.id} failed: ${err.message || err}`));
}

function websiteUrl() {
  return (process.env.WEBSITE_URL || process.env.APP_URL || '').replace(/\/+$/, '');
}

function findByEmail(email) {
  return prisma.users.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
}

async function schedule(user) {
  if (user.role === 'ADMIN') throw new Error('CANNOT_DELETE_ADMIN');
  // Asking again while already scheduled keeps the original date.
  if (user.delete_at) return user.delete_at;
  const now = new Date();
  const deleteAt = new Date(now.getTime() + DELETION_GRACE_DAYS * 86_400_000);
  await prisma.users.update({
    where: { id: user.id },
    data:  {
      deletion_requested_at: now,
      delete_at:             deleteAt,
      deletion_token_hash:   null,
      deletion_token_expiry: null,
    },
  });
  info(`Account ${user.id} scheduled for deletion on ${deleteAt.toISOString()}`);
  // Off the leaderboards while pending (computeEligibility).
  await syncLeaderboardMember(user.id);
  const day = formatDeletionDate(deleteAt);
  mailHunter(user, 'Your HunterX account will be deleted', 'Your account is scheduled for deletion', [
    `Your HunterX account and its data will be permanently deleted on ${strong(day)}.`,
    `Changed your mind? Log in to the app and tap ${strong('Keep my account')} any time before then.`,
  ], 'Deletion-scheduled');
  await notifyHunter(user.id, DELETION_PUSH.scheduled(day), 'DELETION_SCHEDULED');
  return deleteAt;
}

// via: 'app' (Keep my account — the hunter is in the app and sees a toast,
// so no push) or 'website' (cancel code — pushed so the phone confirms it).
async function unschedule(user, { via = 'app' } = {}) {
  if (!user.delete_at) throw new Error('NO_PENDING_DELETION');
  // When the pause began. delete_at is always request + grace, so it
  // stands in if the request time is missing (rows from before it existed).
  const pausedAt = user.deletion_requested_at
    ?? new Date(new Date(user.delete_at).getTime() - DELETION_GRACE_DAYS * DAY_MS);
  await prisma.$transaction(async (tx) => {
    await tx.users.update({
      where: { id: user.id },
      data:  { deletion_requested_at: null, delete_at: null, deletion_token_hash: null, deletion_token_expiry: null },
    });
    // Streak and reward clocks were frozen while pending: give the time back.
    await shiftStreakPastPause(tx, user.id, pausedAt);
    await extendRewardsPastPause(tx, user.id, pausedAt);
  });
  await syncLeaderboardMember(user.id); // back on the leaderboards
  info(`Account ${user.id} deletion cancelled (${via})`);
  mailHunter(user, 'Your HunterX account will not be deleted', 'Your account is safe', [
    'You cancelled the deletion of your HunterX account. Your XP, streaks and rewards stay right where they are.',
    'If this wasn’t you, contact customercare@hunterx.co.in.',
  ], 'Deletion-cancelled');
  if (via === 'website') {
    await notifyHunter(user.id, DELETION_PUSH.cancelled(), 'DELETION_CANCELLED');
  }
}

/**
 * Hourly (cron/accountDeletion.js): push + email reminders per scheduled
 * deletion — "N days left" once it is DELETION_REMINDER_DAYS away, then
 * "last day" once it is within DELETION_LAST_DAY_DAYS. The notification
 * row's dedupe key (per stage and delete_at) keeps each to one, across runs
 * and instances; cancelling and deleting again gets a new date and so new
 * reminders. If the job missed the 3-day window, only the last-day one goes.
 * The last-day one goes ~24h ahead, so quiet hours (≤ 9h) never push it
 * past the deletion.
 */
export async function sendDeletionReminders(now = new Date()) {
  const due = await prisma.users.findMany({
    where:  {
      delete_at: { gt: now, lte: new Date(now.getTime() + DELETION_REMINDER_DAYS * DAY_MS) },
      role:      { not: 'ADMIN' },
    },
    select: { id: true, email: true, delete_at: true },
    take:   500,
  });

  let sent = 0;
  for (const user of due) {
    const deleteAt = new Date(user.delete_at);
    const msLeft   = deleteAt.getTime() - now.getTime();
    const lastDay  = msLeft <= DELETION_LAST_DAY_DAYS * DAY_MS;
    const daysLeft = Math.max(1, Math.ceil(msLeft / DAY_MS));
    const inDays   = daysText(daysLeft);
    const day      = formatDeletionDate(deleteAt);
    const stage    = lastDay ? 'last_day' : `${DELETION_REMINDER_DAYS}d`;

    const notification = await notifyHunter(
      user.id,
      lastDay ? DELETION_PUSH.lastDay() : DELETION_PUSH.reminder(daysLeft, day),
      lastDay ? 'DELETION_LAST_DAY' : 'DELETION_REMINDER',
      { dedupeKey: `deletion_reminder:${stage}:${deleteAt.toISOString()}`, expiresAt: deleteAt },
    );
    // null = this stage was already sent (dedupe) — the email rides on the same row.
    if (!notification) continue;
    sent += 1;
    if (lastDay) {
      await mailHunter(user, 'Last day to keep your HunterX account', 'Last day to keep your account', [
        `Your HunterX account and all its data will be permanently deleted on ${strong(day)}. After that it can't be recovered.`,
        `Want to keep it? Log in to the app and tap ${strong('Keep my account')} now.`,
      ], 'Deletion-last-day');
    } else {
      await mailHunter(user, `Your HunterX account will be deleted in ${inDays}`, `${inDays} left`, [
        `Your HunterX account and its data will be permanently deleted on ${strong(day)}.`,
        `Want to keep it? Log in to the app and tap ${strong('Keep my account')} before then.`,
      ], 'Deletion-reminder');
    }
  }
  return sent;
}

/** App: a one-time (10-minute) website link that confirms deletion. */
export async function createDeletionLink(userId) {
  const user = await prisma.users.findUnique({ where: { id: BigInt(userId) } });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.role === 'ADMIN') throw new Error('CANNOT_DELETE_ADMIN');
  const base = websiteUrl();
  if (!base) throw new Error('WEBSITE_URL_NOT_SET');

  const token = crypto.randomBytes(32).toString('hex');
  await prisma.users.update({
    where: { id: user.id },
    data:  { deletion_token_hash: sha256(token), deletion_token_expiry: new Date(Date.now() + LINK_TTL_MS) },
  });
  return { url: `${base}/delete-account?t=${token}`, expiresInSeconds: LINK_TTL_MS / 1000 };
}

/** Website: the link's token schedules the deletion. Returns the date. */
export async function confirmDeletionByToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('INVALID_TOKEN');
  const user = await prisma.users.findUnique({ where: { deletion_token_hash: sha256(token) } });
  if (!user) throw new Error('INVALID_TOKEN');
  if (!user.deletion_token_expiry || user.deletion_token_expiry <= new Date()) throw new Error('EXPIRED_TOKEN');
  return schedule(user);
}

/** App: "Keep my account". */
export async function cancelDeletion(userId) {
  const user = await prisma.users.findUnique({ where: { id: BigInt(userId) } });
  if (!user) throw new Error('USER_NOT_FOUND');
  await unschedule(user);
}

/**
 * Website, no link: emails a code to delete (purpose 'delete') or to keep
 * (purpose 'cancel') the account. Silent when the email has no account,
 * so the website can't be used to look up which emails are registered.
 */
export async function requestDeletionCode(rawEmail, purpose) {
  const email = normalizeEmail(rawEmail);
  if (!(await allowCodeEmail(`deletion-${purpose}`, email))) throw new Error('OTP_COOLDOWN');
  const user = await findByEmail(email);
  if (!user || user.role === 'ADMIN') return;
  if (purpose === 'cancel' && !user.delete_at) return;

  const otpPurpose = purpose === 'cancel' ? OTP_PURPOSES.CANCEL_DELETION : OTP_PURPOSES.DELETE_ACCOUNT;
  const code = await createAccountOtp(user.id, otpPurpose, email);
  try {
    await sendMail({
      to:      user.email,
      subject: purpose === 'cancel' ? 'Keep your HunterX account' : 'Confirm deleting your HunterX account',
      html: brandedEmail({
        heading:    purpose === 'cancel' ? 'Keep your account' : 'Confirm account deletion',
        paragraphs: [purpose === 'cancel'
          ? 'Enter this code on the HunterX website to cancel your account deletion.'
          : `Enter this code on the HunterX website to delete your account. It will be permanently deleted ${DELETION_GRACE_DAYS} days later, and you can keep it any time before then.`],
        code,
        note:       'If you did not ask for this, ignore this email — nothing will change.',
      }),
    });
  } catch (err) {
    logError(`Deletion code (${purpose}) for ${user.id} failed: ${err.message || err}`);
  }
}

async function userForCode(rawEmail) {
  const user = await findByEmail(normalizeEmail(rawEmail));
  if (!user) throw new Error('OTP_INVALID');
  return user;
}

export async function confirmDeletionByCode(rawEmail, otp) {
  const user = await userForCode(rawEmail);
  await consumeAccountOtp(user.id, OTP_PURPOSES.DELETE_ACCOUNT, otp);
  return schedule(user);
}

export async function cancelDeletionByCode(rawEmail, otp) {
  const user = await userForCode(rawEmail);
  await consumeAccountOtp(user.id, OTP_PURPOSES.CANCEL_DELETION, otp);
  await unschedule(user, { via: 'website' });
}

/** Hourly: deletes every account whose grace period is over. */
export async function purgeDueAccounts() {
  const due = await prisma.users.findMany({
    where:  { delete_at: { lte: new Date() }, role: { not: 'ADMIN' } },
    select: { id: true },
    take:   200,
  });
  let deleted = 0;
  for (const { id } of due) {
    try {
      await revokeAllSessions(id);
      await deleteUserAccount(id);
      deleted += 1;
    } catch (err) {
      logError(`Scheduled deletion of account ${id} failed: ${err.message || err}`);
    }
  }
  return deleted;
}
