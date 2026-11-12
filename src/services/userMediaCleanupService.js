// src/services/userMediaCleanupService.js — Removes a deleted account's
// uploads from Cloudinary.
//
// The app uploads into per-user folders, hunterx/<folder>/<userId>/ (see
// routes/media.js): quest proof photos, a custom avatar, guest passes and
// misc images. When an account is deleted, deleteUserAccount writes a
// pending_media_cleanup row inside the same transaction as the DELETE, then
// calls cleanupUserMedia after commit. The row is only removed once every
// folder is verified empty, so a Cloudinary outage or a crash between the
// two steps never leaves photos behind: the hourly housekeeping job
// (cron/accountDeletion.js → retryPendingMediaCleanup) tries again.
//
// Logs carry the user id only — never names, emails or URLs.

import prisma from '../config/prisma.js';
import cloudinary from '../config/cloudinary.js';
import { info, logError } from '../utils/logger.js';

// Same list as routes/media.js#ALLOWED_FOLDERS.
export const USER_MEDIA_FOLDERS = ['task-proof', 'avatars', 'guest-pass', 'misc'];

// Each user's folder paths.
export function userMediaFolders(userId) {
  return USER_MEDIA_FOLDERS.map((f) => `hunterx/${f}/${userId}`);
}

// Delete calls per folder before giving up for this run (1,000 assets each).
const MAX_DELETE_PAGES = 20;
const RETRY_BATCH = 50;

const notFound = (err) => err?.http_code === 404 || err?.error?.http_code === 404;

function errorText(err) {
  const msg = err?.message || err?.error?.message || String(err);
  return msg.slice(0, 500);
}

async function emptyFolder(folder) {
  // The trailing slash keeps user 13 from matching user 130's assets.
  const prefix = `${folder}/`;
  for (let page = 0; page < MAX_DELETE_PAGES; page += 1) {
    // Removes up to 1,000 matching assets; `partial` means more remain.
    const res = await cloudinary.api.delete_resources_by_prefix(prefix, { resource_type: 'image', type: 'upload' });
    if (!res?.partial) break;
  }

  // Verify, so the cleanup row is only cleared when nothing is left.
  const left = await cloudinary.api.resources({ type: 'upload', resource_type: 'image', prefix, max_results: 1 });
  if (left?.resources?.length) throw new Error(`assets still present in ${folder}`);

  try {
    await cloudinary.api.delete_folder(folder);
  } catch (err) {
    // Never created (the user never uploaded there) or already gone.
    if (!notFound(err)) throw err;
  }
}

/** Empties and removes every Cloudinary folder of `userId`. Throws on failure. */
export async function deleteUserMedia(userId) {
  for (const folder of userMediaFolders(userId)) await emptyFolder(folder);
}

/**
 * After deleteUserAccount's commit: tries the cleanup once. On success the
 * pending row goes; on failure it stays (with the error) for the retry job.
 * Never throws — the account is already deleted.
 */
export async function cleanupUserMedia(userId) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  try {
    await deleteUserMedia(bUserId);
    await prisma.pending_media_cleanup.deleteMany({ where: { user_id: bUserId } });
    return true;
  } catch (err) {
    logError(`Media cleanup for deleted user ${bUserId} failed (will retry): ${errorText(err)}`);
    await recordFailure(bUserId, err);
    return false;
  }
}

async function recordFailure(bUserId, err) {
  try {
    const row = await prisma.pending_media_cleanup.findUnique({ where: { user_id: bUserId } });
    const data = { attempts: (row?.attempts ?? 0) + 1, last_error: errorText(err), updated_at: new Date() };
    if (row) await prisma.pending_media_cleanup.update({ where: { user_id: bUserId }, data });
    else await prisma.pending_media_cleanup.create({ data: { user_id: bUserId, ...data } });
  } catch (dbErr) {
    logError(`Could not record media cleanup failure for user ${bUserId}: ${errorText(dbErr)}`);
  }
}

/** Hourly: retries cleanups that failed or were interrupted. Returns the number finished. */
export async function retryPendingMediaCleanup() {
  const pending = await prisma.pending_media_cleanup.findMany({
    orderBy: { updated_at: 'asc' },
    take:    RETRY_BATCH,
    select:  { user_id: true },
  });
  let done = 0;
  for (const { user_id: userId } of pending) {
    if (await cleanupUserMedia(userId)) done += 1;
  }
  if (done > 0) info(`Media cleanup: removed uploads of ${done} deleted account(s)`);
  return done;
}
