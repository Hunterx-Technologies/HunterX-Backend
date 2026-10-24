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

// special_reward_id from a request: null / '' / 'none' = no special reward;
// otherwise it must be a special (TASK kind) reward. Returns a BigInt or null.
async function resolveSpecialReward(value) {
  if (value === null || value === '' || value === 'none') return null;
  if (!/^\d+$/.test(String(value))) throw new Error('INVALID_SPECIAL_REWARD');
  const trigger = await prisma.reward_triggers.findUnique({ where: { id: BigInt(value) } });
  if (!trigger || trigger.kind !== 'TASK') throw new Error('INVALID_SPECIAL_REWARD');
  return trigger.id;
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
    proof_count,
  } = input;

  if (!title?.trim()) throw new Error('TITLE_REQUIRED');
  if (!CREATABLE_TYPES.includes(task_type)) throw new Error('INVALID_TASK_TYPE');
  if (typeof is_recurring !== 'boolean') throw new Error('IS_RECURRING_REQUIRED');
  if (typeof allows_partial !== 'boolean') throw new Error('INVALID_ALLOWS_PARTIAL');
  if (typeof is_paid !== 'boolean') throw new Error('INVALID_IS_PAID');
  // 0 = no proof; 1–5 photos the hunter uploads for an admin to review.
  const proofCount = proof_count === undefined || proof_count === null || proof_count === '' ? 0 : Number(proof_count);
  if (!Number.isInteger(proofCount) || proofCount < 0 || proofCount > 5) throw new Error('INVALID_PROOF_COUNT');

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
    proof_count:      proofCount,
  };
}

// Compresses + uploads any new images onto `data`, runs `write`, and
// removes newly created uploads again if the DB write fails. Uploading
// only after validation means a rejected request never leaves orphan
// images.
//
// On edit (`existing` set), a new file for a gender whose current image is
// one we uploaded overwrites that same Cloudinary image instead of adding
// another — unless that image is also shown elsewhere (the other gender,
// or another task the URL was pasted into), where overwriting would change
// it there too; then a new image is uploaded. After a successful write,
// any of our images no longer referenced by the task are deleted (e.g. an
// image swapped for a different URL).
async function writeWithImages(data, files, write, existing = null) {
  const ownId = url => ownPublicIdFromUrl(url, TASK_IMAGE_FOLDER);
  const maleId   = ownId(existing?.image_url_male ?? existing?.image_url);
  const femaleId = ownId(existing?.image_url_female);
  const shared   = maleId && maleId === femaleId;

  // The id to overwrite for a replaced image, or null to upload a new one.
  const overwriteId = async (id) => {
    if (!id || shared) return null;
    return (await usedByOtherTask(id, existing.id)) ? null : id;
  };

  const [male, female] = await Promise.all([
    files.image_male
      ? overwriteId(maleId).then(publicId => uploadCompressedImage(files.image_male, TASK_IMAGE_FOLDER, { publicId }))
      : null,
    files.image_female
      ? overwriteId(femaleId).then(publicId => uploadCompressedImage(files.image_female, TASK_IMAGE_FOLDER, { publicId }))
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
    const orphaned = [];
    for (const id of candidates) {
      if (!(await usedByOtherTask(id, existing.id))) orphaned.push(id);
    }
    if (orphaned.length) await deleteImages(orphaned);
  }
  return saved;
}

// An admin may have pasted one task's image URL into another task.
async function usedByOtherTask(publicId, taskId) {
  const count = await prisma.tasks.count({
    where: {
      id: { not: taskId },
      OR: [
        { image_url:        { contains: publicId } },
        { image_url_male:   { contains: publicId } },
        { image_url_female: { contains: publicId } },
      ],
    },
  });
  return count > 0;
}

// Every task, active and inactive, newest first — for the admin Tasks
// page. The app only ever sees active ones (taskService.js /
// taskAssignmentService.js filter on is_active). DAILY_FIXED routine tasks
// are listed too but are seed-managed, so updateTask refuses them.
// can_delete: no hunter has ever been touched by it (see deleteTask).
export async function listTasks() {
  const [tasks, used] = await Promise.all([
    prisma.tasks.findMany({ orderBy: [{ created_at: 'desc' }, { id: 'desc' }] }),
    prisma.$queryRaw`
      SELECT task_id FROM task_schedule
      UNION SELECT task_id FROM task_completions
      UNION SELECT task_id FROM task_purchases
      UNION SELECT task_id FROM xp_transactions WHERE task_id IS NOT NULL`,
  ]);
  const usedIds = new Set(used.map((r) => String(r.task_id)));
  return tasks.map((t) => ({
    ...t,
    can_delete: CREATABLE_TYPES.includes(t.task_type) && !usedIds.has(String(t.id)),
  }));
}

// For the admin task page's Assignment Stats tab: how many hunters have
// had the task on their list, when it was first / last shown to anyone,
// and how many of them completed it at least once (COMPLETED or PARTIAL).
export async function getTaskAssignmentStats(taskId) {
  if (!/^\d+$/.test(String(taskId))) throw new Error('TASK_NOT_FOUND');
  const bTaskId = BigInt(taskId);
  const task = await prisma.tasks.findUnique({ where: { id: bTaskId }, select: { id: true } });
  if (!task) throw new Error('TASK_NOT_FOUND');

  const [[shown], [done]] = await Promise.all([
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT user_id)::int AS users, MIN(active_date) AS first_shown, MAX(active_date) AS last_shown,
             COUNT(*) FILTER (WHERE active_date = ${getISTDateOnly()})::int AS today
      FROM task_schedule WHERE task_id = ${bTaskId}`,
    prisma.$queryRaw`
      SELECT COUNT(DISTINCT user_id)::int AS users, COUNT(*)::int AS completions
      FROM task_completions WHERE task_id = ${bTaskId} AND status IN ('COMPLETED', 'PARTIAL')`,
  ]);
  return {
    users_assigned:   shown.users,
    shown_today:      shown.today,
    first_shown_on:   shown.first_shown ? dateKey(shown.first_shown) : null,
    last_shown_on:    shown.last_shown ? dateKey(shown.last_shown) : null,
    users_completed:  done.users,
    completions:      done.completions,
    // Share of assigned hunters who completed it at least once.
    completion_rate:  shown.users ? Math.round((done.users / shown.users) * 100) : 0,
  };
}

// Permanently deletes a task no hunter has been touched by: never assigned
// (task_schedule), completed, bought, or paid XP for. Anything else can
// only be deactivated, so users' history stays intact. Its Cloudinary
// images go too (unless another task uses the same image). The row lock
// makes a concurrent assignment wait, so it can't slip in between the
// check and the delete.
export async function deleteTask(taskId) {
  if (!/^\d+$/.test(String(taskId))) throw new Error('TASK_NOT_FOUND');
  const bTaskId = BigInt(taskId);

  const deleted = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${bTaskId} FOR UPDATE`;
    if (!row) throw new Error('TASK_NOT_FOUND');
    const task = await tx.tasks.findUnique({ where: { id: bTaskId } });
    if (!CREATABLE_TYPES.includes(task.task_type)) throw new Error('TASK_NOT_EDITABLE');

    const [scheduled, completed, purchased, xp] = await Promise.all([
      tx.task_schedule.count({ where: { task_id: bTaskId } }),
      tx.task_completions.count({ where: { task_id: bTaskId } }),
      tx.task_purchases.count({ where: { task_id: bTaskId } }),
      tx.xp_transactions.count({ where: { task_id: bTaskId } }),
    ]);
    if (scheduled + completed + purchased + xp > 0) throw new Error('TASK_IN_USE');

    await tx.tasks.delete({ where: { id: bTaskId } });
    return task;
  });

  const imageIds = [...new Set(
    [deleted.image_url, deleted.image_url_male, deleted.image_url_female]
      .map((url) => ownPublicIdFromUrl(url, TASK_IMAGE_FOLDER))
      .filter(Boolean)
  )];
  const orphaned = [];
  for (const id of imageIds) {
    if (!(await usedByOtherTask(id, bTaskId))) orphaned.push(id);
  }
  if (orphaned.length) await deleteImages(orphaned);
  return { deleted: true };
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
  // Optional special reward: completing the task grants a card from it.
  if (input.special_reward_id !== undefined) data.special_reward_id = await resolveSpecialReward(input.special_reward_id);
  const saved = await writeWithImages(data, files, d => prisma.tasks.create({ data: d }));
  announceInBackground(saved);
  return saved;
}

// Partial update: any field left out keeps its current value; the merged
// result must pass the same rules as createTask. Also accepts is_active.
export async function updateTask(taskId, body, files = {}) {
  const existing = await prisma.tasks.findUnique({ where: { id: BigInt(taskId) } });
  if (!existing) throw new Error('TASK_NOT_FOUND');
  // Built-in daily tasks (DAILY_FIXED, seed-managed) can only be switched
  // on or off — nothing else about them is editable.
  if (!CREATABLE_TYPES.includes(existing.task_type)) {
    const keys = Object.keys(body ?? {}).filter((k) => body[k] !== undefined);
    if (keys.length !== 1 || keys[0] !== 'is_active' || typeof body.is_active !== 'boolean') throw new Error('TASK_NOT_EDITABLE');
    return prisma.tasks.update({ where: { id: existing.id }, data: { is_active: body.is_active, updated_at: new Date() } });
  }

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
    proof_count:      existing.proof_count,
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

  // Special reward: can be added, swapped or removed until it has given a
  // hunter a card for this task — then it's fixed, so what was promised
  // for the task stays the same for everyone (switch the reward off to stop it).
  if ('special_reward_id' in changes) {
    const next = await resolveSpecialReward(changes.special_reward_id);
    if (next !== existing.special_reward_id) {
      if (existing.special_reward_id) {
        const granted = await prisma.user_rewards.count({
          where: { trigger_id: existing.special_reward_id, period: Number(existing.id) },
        });
        if (granted > 0) throw new Error('SPECIAL_REWARD_LOCKED');
      }
      data.special_reward_id = next;
    }
  }

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
