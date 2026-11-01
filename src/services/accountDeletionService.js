// src/services/accountDeletionService.js — Permanent account deletion.
//
// Backs DELETE /api/users/me, the scheduled deletion below and
// scripts/delete-user.js (App Store Guideline 5.1.1(v): an app that lets
// users create an account must let them delete it in-app). Most user-owned tables cascade from users; the
// relations declared onDelete: NoAction are cleared or unlinked by hand
// first, inside the same transaction, so the final DELETE can't fail on a
// foreign key. The leaderboard's Redis copy is dropped after commit.

import prisma from '../config/prisma.js';
import { removeLeaderboardMember } from './leaderboardService.js';
import crypto from 'crypto';
import { createAccountOtp, consumeAccountOtp, OTP_PURPOSES } from './accountOtpService.js';
import { revokeAllSessions } from './sessionService.js';
import { normalizeEmail, sha256 } from '../utils/helpers.js';
import { allowCodeEmail } from '../utils/throttle.js';
import { brandedEmail } from '../utils/emailTemplates.js';
import { sendMail } from '../utils/mailer.js';
import { info, logError } from '../utils/logger.js';

export async function deleteUserAccount(userId, { allowAdmin = false } = {}) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  const user = await prisma.users.findUnique({
    where:  { id: bUserId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.role === 'ADMIN' && !allowAdmin) throw new Error('CANNOT_DELETE_ADMIN');

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
  });

  await removeLeaderboardMember(bUserId);
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
const LINK_TTL_MS = 10 * 60 * 1000;

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
  if (user.email) {
    sendMail({
      to:      user.email,
      subject: 'Your HunterX account will be deleted',
      html: brandedEmail({
        heading:    'Your account is scheduled for deletion',
        paragraphs: [
          `Your HunterX account and its data will be permanently deleted on <strong style="color:#ffffff;">${deleteAt.toDateString()}</strong>.`,
          'Changed your mind? Log in to the app and tap <strong style="color:#ffffff;">Keep my account</strong> any time before then.',
        ],
      }),
    }).catch((err) => logError(`Deletion-scheduled notice for ${user.id} failed: ${err.message || err}`));
  }
  return deleteAt;
}

async function unschedule(user) {
  if (!user.delete_at) throw new Error('NO_PENDING_DELETION');
  await prisma.users.update({
    where: { id: user.id },
    data:  { deletion_requested_at: null, delete_at: null, deletion_token_hash: null, deletion_token_expiry: null },
  });
  info(`Account ${user.id} deletion cancelled`);
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
  await unschedule(user);
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
