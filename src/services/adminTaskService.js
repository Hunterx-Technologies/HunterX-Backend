// src/services/adminTaskService.js — Admin-authored task create + edit
//
// Admins create (and later edit) three kinds of tasks here, each over a date window
// [start_date, end_date]:
//   DAILY_ADMIN — one-time (is_recurring=false) is a single day
//                 (end_date = start_date); recurring repeats every day
//                 through end_date (or forever if none is given).
//   WEEKLY      — shown every day of its window, completable once per
//                 7-day period. One-time is a single 7-day window
//                 (end_date = start_date + 6); recurring repeats every
//                 7 days through end_date.
//   MONTHLY     — one-time is a 30-day window (end_date = start_date + 29).
// An admin-supplied end_date always wins over the derived one.
// Windows can start in the future — taskAssignmentService picks a task up
// automatically once `date` falls inside [start_date, end_date].
//
// Paid tasks (is_paid=true; price, start_date and end_date required): the
// task is shown locked to everyone from start_date to end_date. A buyer's
// access runs from the day they pay to end_date (see
// taskPurchaseService.js), and only buyers have it assigned. The nightly
// cron deactivates a paid task once end_date has passed.
//
// Editing (updateTask) runs the same rules over the existing task merged
// with the fields sent. For a paid task, edits never touch existing
// buyers: their access_end and the amount they paid are fixed on their
// task_purchases row, so a new end_date or price only applies to the
// offer and to new buyers.
//
// DAILY_FIXED is not creatable or editable here — those 3 routine tasks are seed-managed
// (prisma/seed.js) since every user gets exactly those three, every day.

import prisma from '../config/prisma.js';
import { parseDateOnly, getISTDateOnly } from '../utils/helpers.js';
import { uploadCompressedImage, deleteImages, ownPublicIdFromUrl } from './imageUploadService.js';
import { announceTaskChange } from './questNotificationService.js';
import { logError } from '../utils/logger.js';

const TASK_IMAGE_FOLDER = 'hunterx/tasks';

// Pushes for a task that starts today after the 08:00 IST announcement
// jobs already ran, or a paid offer coming back on sale. Fans out to every
// user, so it runs after the response instead of holding up the admin.
function announceInBackground(saved, existing = null) {
  announceTaskChange(saved, existing).catch((err) =>
    logError(`Quest announcement failed for task ${saved.id}: ${err.message}`)
  );
}

const CREATABLE_TYPES    = ['DAILY_ADMIN', 'WEEKLY', 'MONTHLY'];
const MS_PER_DAY         = 24 * 60 * 60 * 1000;
const WEEKLY_WINDOW_DAYS = 6; // a week window is start_date .. start_date+6 (7 days inclusive)

// Window length in days (inclusive) for a one-time free task with no end_date.
const DEFAULT_WINDOW_DAYS = { DAILY_ADMIN: 1, WEEKLY: 7, MONTHLY: 30 };

// Design cap from the task XP system (see prisma/seed.js commit notes):
// daily tasks max out at 10 XP, weekly quests at 70 — keeps admin-created
// challenges in line with the fixed routine tasks instead of skewing the
// XP economy.
const XP_CAP = { DAILY_ADMIN: 10, WEEKLY: 70, MONTHLY: 300 };

function addDays(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function dateKey(date) {
  return date ? date.toISOString().slice(0, 10) : null;
}

// Validates a full task definition and returns the tasks row fields.
// `existing` (edit only) relaxes the "not in the past" checks to dates the
// admin actually changed, so a task that has already started stays editable.
function buildTaskData(input, existing = null) {
  const {
    title,
    description,
    tag,
    image_url,
    image_url_male,
    image_url_female,
    task_type,
    xp_reward,
    allows_partial,
    target_value,
    target_unit,
    is_recurring,
    start_date,
    end_date,
    is_paid,
    price,
  } = input;

  if (!title?.trim()) throw new Error('TITLE_REQUIRED');
  if (!CREATABLE_TYPES.includes(task_type)) throw new Error('INVALID_TASK_TYPE');
  if (typeof is_recurring !== 'boolean') throw new Error('IS_RECURRING_REQUIRED');
  if (typeof allows_partial !== 'boolean') throw new Error('INVALID_ALLOWS_PARTIAL');
  if (typeof is_paid !== 'boolean') throw new Error('INVALID_IS_PAID');

  if (
    target_value !== undefined && target_value !== null &&
    (typeof target_value !== 'number' || !Number.isFinite(target_value) || target_value < 0)
  ) throw new Error('INVALID_TARGET_VALUE');

  if (xp_reward === undefined || xp_reward === null) throw new Error('XP_REWARD_REQUIRED');
  if (!Number.isInteger(xp_reward) || xp_reward <= 0) throw new Error('INVALID_XP_REWARD');
  if (xp_reward > XP_CAP[task_type]) throw new Error('XP_REWARD_EXCEEDS_CAP');

  // Partial XP is always half the full reward, never admin-supplied.
  const xpPartial = allows_partial ? Math.floor(xp_reward / 2) : 0;
  if (allows_partial && xpPartial < 1) throw new Error('XP_REWARD_TOO_LOW_FOR_PARTIAL');

  let resolvedPrice = null;
  if (is_paid) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0)
      throw new Error('PRICE_REQUIRED');
    if (Math.abs(Math.round(price * 100) - price * 100) > 1e-6) throw new Error('INVALID_PRICE');
    resolvedPrice = price.toFixed(2);
  }

  // ── Date window. start_date is always required. end_date is required for
  // paid tasks (it ends the offer and every buyer's access); for free ones
  // it's optional — one-time tasks derive it, recurring tasks have no end.
  const today = getISTDateOnly();
  if (!start_date) throw new Error('START_DATE_REQUIRED');
  const parsedStart = parseDateOnly(start_date);
  if (!parsedStart) throw new Error('INVALID_START_DATE');
  if (start_date !== dateKey(existing?.start_date) && parsedStart.getTime() < today.getTime())
    throw new Error('START_DATE_IN_PAST');
  if (is_paid && !end_date) throw new Error('END_DATE_REQUIRED_FOR_PAID');

  let parsedEnd;
  if (end_date) {
    parsedEnd = parseDateOnly(end_date);
    if (!parsedEnd) throw new Error('INVALID_END_DATE');
    if (parsedEnd.getTime() < parsedStart.getTime()) throw new Error('END_DATE_BEFORE_START_DATE');
    if (existing && end_date !== dateKey(existing.end_date) && parsedEnd.getTime() < today.getTime())
      throw new Error('END_DATE_IN_PAST');
    if (task_type === 'WEEKLY' && is_recurring &&
        parsedEnd.getTime() < addDays(parsedStart, WEEKLY_WINDOW_DAYS).getTime())
      throw new Error('END_DATE_TOO_SOON'); // must span at least one full 7-day week
  } else if (is_recurring) {
    parsedEnd = null;
  } else {
    parsedEnd = addDays(parsedStart, DEFAULT_WINDOW_DAYS[task_type] - 1);
  }

  return {
    title:            title.trim(),
    description:      description ?? null,
    tag:              tag ?? null,
    image_url:        image_url ?? image_url_male ?? null,
    image_url_male:   image_url_male ?? image_url ?? null,
    image_url_female: image_url_female ?? null,
    task_type,
    xp_reward,
    xp_partial:       xpPartial,
    allows_partial,
    target_value:     target_value ?? null,
    target_unit:      target_unit ?? null,
    is_recurring,
    start_date:       parsedStart,
    end_date:         parsedEnd,
    recurrence_days:  [], // no longer used — weekly tasks run every day of their window
    is_paid,
    price:            resolvedPrice,
  };
}

// Compresses + uploads any new images onto `data`, runs `write`, and
// removes newly created uploads again if the DB write fails. Uploading
// only after validation means a rejected request never leaves orphan
// images.
//
// On edit (`existing` set), a new file for a gender whose current image is
// one we uploaded overwrites that same Cloudinary image instead of adding
// another — unless both genders share that image, in which case
// overwriting would change the other one too. After a successful write,
// any of our images no longer referenced by the task are deleted (e.g. an
// image swapped for a different URL).
async function writeWithImages(data, files, write, existing = null) {
  const ownId = url => ownPublicIdFromUrl(url, TASK_IMAGE_FOLDER);
  const maleId   = ownId(existing?.image_url_male ?? existing?.image_url);
  const femaleId = ownId(existing?.image_url_female);
  const shared   = maleId && maleId === femaleId;

  const [male, female] = await Promise.all([
    files.image_male
      ? uploadCompressedImage(files.image_male, TASK_IMAGE_FOLDER, { publicId: shared ? null : maleId })
      : null,
    files.image_female
      ? uploadCompressedImage(files.image_female, TASK_IMAGE_FOLDER, { publicId: shared ? null : femaleId })
      : null,
  ]);
  if (male) {
    data.image_url_male = male.url;
    data.image_url      = male.url;
  }
  if (female) data.image_url_female = female.url;

  let saved;
  try {
    saved = await write(data);
  } catch (err) {
    await deleteImages([male, female].filter(i => i && !i.replaced).map(i => i.public_id));
    throw err;
  }

  if (existing) {
    const before = [existing.image_url, existing.image_url_male, existing.image_url_female].map(ownId);
    const after  = new Set([saved.image_url, saved.image_url_male, saved.image_url_female].map(ownId));
    const candidates = [...new Set(before.filter(id => id && !after.has(id)))];
    // An admin may have pasted the same image URL into another task.
    const orphaned = [];
    for (const id of candidates) {
      const usedElsewhere = await prisma.tasks.count({
        where: {
          id: { not: existing.id },
          OR: [
            { image_url:        { contains: id } },
            { image_url_male:   { contains: id } },
            { image_url_female: { contains: id } },
          ],
        },
      });
      if (!usedElsewhere) orphaned.push(id);
    }
    if (orphaned.length) await deleteImages(orphaned);
  }
  return saved;
}

// files: optional uploaded images { image_male, image_female }, each a
// buffer — compressed and stored on Cloudinary, overriding any URL fields.
export async function createTask(adminId, body, files = {}) {
  const input = { allows_partial: false, is_paid: false, ...(body ?? {}) };
  const data = {
    ...buildTaskData(input),
    is_default_daily: false,
    is_active:        true,
    created_by:       BigInt(adminId),
  };
  const saved = await writeWithImages(data, files, d => prisma.tasks.create({ data: d }));
  announceInBackground(saved);
  return saved;
}

// Partial update: any field left out keeps its current value; the merged
// result must pass the same rules as createTask. Also accepts is_active.
export async function updateTask(taskId, body, files = {}) {
  const existing = await prisma.tasks.findUnique({ where: { id: BigInt(taskId) } });
  if (!existing) throw new Error('TASK_NOT_FOUND');
  if (!CREATABLE_TYPES.includes(existing.task_type)) throw new Error('TASK_NOT_EDITABLE');

  const changes = Object.fromEntries(
    Object.entries(body ?? {}).filter(([, v]) => v !== undefined)
  );
  if (changes.is_active !== undefined && typeof changes.is_active !== 'boolean')
    throw new Error('INVALID_IS_ACTIVE');

  // Paid -> free would hand buyers' purchase to everyone for nothing.
  if (existing.is_paid && changes.is_paid === false) {
    const buyers = await prisma.task_purchases.count({ where: { task_id: existing.id, status: 'PAID' } });
    if (buyers > 0) throw new Error('TASK_HAS_BUYERS');
  }

  const current = {
    title:            existing.title,
    description:      existing.description,
    tag:              existing.tag,
    image_url:        existing.image_url,
    image_url_male:   existing.image_url_male,
    image_url_female: existing.image_url_female,
    task_type:        existing.task_type,
    xp_reward:        existing.xp_reward,
    allows_partial:   existing.allows_partial,
    target_value:     existing.target_value,
    target_unit:      existing.target_unit,
    is_recurring:     existing.is_recurring,
    start_date:       dateKey(existing.start_date),
    end_date:         dateKey(existing.end_date),
    is_paid:          existing.is_paid,
    price:            existing.price === null ? undefined : Number(existing.price),
  };
  const input = { ...current, ...changes };

  // A one-time free task's end_date was derived from start_date — moving
  // the start without sending an end re-derives it rather than keeping
  // the old (now stale) one.
  if ('start_date' in changes && !('end_date' in changes) && !input.is_recurring && !input.is_paid)
    input.end_date = undefined;

  // Images: a new URL for one gender shouldn't be overwritten by the other
  // gender's old URL through the image_url fallbacks.
  if ('image_url_male' in changes && !('image_url' in changes)) input.image_url = changes.image_url_male;
  if ('image_url' in changes && !('image_url_male' in changes)) input.image_url_male = changes.image_url;

  const data = buildTaskData(input, existing);

  if (typeof changes.is_active === 'boolean') {
    data.is_active = changes.is_active;
  } else if (data.is_paid && !existing.is_active && data.end_date &&
             data.end_date.getTime() >= getISTDateOnly().getTime() &&
             dateKey(data.end_date) !== dateKey(existing.end_date)) {
    // Moving a paid task's end_date forward brings back an offer the
    // nightly cron already deactivated for passing its old end_date.
    data.is_active = true;
  }
  data.updated_at = new Date();

  const saved = await writeWithImages(data, files, d => prisma.tasks.update({ where: { id: existing.id }, data: d }), existing);
  announceInBackground(saved, existing);
  return saved;
}
