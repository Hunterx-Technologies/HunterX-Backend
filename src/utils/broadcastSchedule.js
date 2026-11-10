// src/utils/broadcastSchedule.js — Occurrence math for scheduled broadcasts.
//
// A schedule is a *local* wall-clock time: "10 Nov, 09:00" means 09:00 on
// 10 Nov in each hunter's own timezone — India first, then London, then
// New York. Occurrences are therefore "floating" wall-clock values, kept
// in a Date whose UTC fields hold the wall clock (stored in a TIMESTAMP
// without zone), and only become real instants per timezone via
// localToUtc().
//
// Every timezone reaches a given wall clock between EARLIEST_AHEAD_MS
// before it (UTC+14, Kiribati) and LATEST_BEHIND_MS after it (UTC-12).
//
// Occurrences are computed from the original anchor (start date + time),
// never by adding to the previous run — so a monthly schedule anchored on
// the 31st lands on the 31st whenever the month has one and on the
// month's last day otherwise, instead of drifting to the 28th forever.

import { getLocalTime } from './timezone.js';

export const ADMIN_TIMEZONE = 'Asia/Kolkata'; // "is this in the future?" is judged on the admin's clock
export const RECURRENCES = ['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'];

const MINUTE_MS = 60 * 1000;
const HOUR_MS   = 60 * MINUTE_MS;
const DAY_MS    = 24 * HOUR_MS;

export const EARLIEST_AHEAD_MS = 14 * HOUR_MS;
export const LATEST_BEHIND_MS  = 12 * HOUR_MS;

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** 'YYYY-MM-DD' (or a UTC-midnight Date) → { y, m (0-11), d }. */
function dateParts(startDate) {
  if (startDate instanceof Date) {
    return { y: startDate.getUTCFullYear(), m: startDate.getUTCMonth(), d: startDate.getUTCDate() };
  }
  const [y, m, d] = String(startDate).split('-').map(Number);
  return { y, m: m - 1, d };
}

/** Wall clock 'YYYY-MM-DD' + 'HH:MM' → floating Date. */
export function wallClock(startDate, sendTime) {
  const { y, m, d } = dateParts(startDate);
  const [hh, mm] = sendTime.split(':').map(Number);
  return new Date(Date.UTC(y, m, d, hh, mm));
}

/** The n-th occurrence as a floating wall clock (n = 0 is the anchor). */
export function occurrenceAt({ startDate, sendTime, recurrence }, n) {
  const { y, m, d } = dateParts(startDate);
  const [hh, mm] = sendTime.split(':').map(Number);
  switch (recurrence) {
    case 'DAILY':
      return new Date(Date.UTC(y, m, d + n, hh, mm));
    case 'WEEKLY':
      return new Date(Date.UTC(y, m, d + 7 * n, hh, mm));
    case 'MONTHLY': {
      const monthIndex = m + n;
      const year = y + Math.floor(monthIndex / 12);
      const month = ((monthIndex % 12) + 12) % 12;
      return new Date(Date.UTC(year, month, Math.min(d, daysInMonth(year, month)), hh, mm));
    }
    default:
      return n === 0 ? new Date(Date.UTC(y, m, d, hh, mm)) : null;
  }
}

/**
 * First occurrence strictly after the floating wall clock `after`, or null
 * (a one-time schedule already past it). Skipped occurrences are not replayed.
 */
export function nextOccurrence(schedule, after) {
  const first = occurrenceAt(schedule, 0);
  if (first > after) return first;
  if (schedule.recurrence === 'NONE' || !RECURRENCES.includes(schedule.recurrence)) return null;

  // Jump close to `after`, then step forward — the estimate can undershoot
  // (month lengths) but never needs more than a couple of steps.
  const elapsed = after.getTime() - first.getTime();
  let n;
  if (schedule.recurrence === 'DAILY') n = Math.floor(elapsed / DAY_MS);
  else if (schedule.recurrence === 'WEEKLY') n = Math.floor(elapsed / (7 * DAY_MS));
  else n = Math.max(0, Math.floor(elapsed / (31 * DAY_MS)));

  let candidate = occurrenceAt(schedule, n);
  while (candidate <= after) {
    n += 1;
    candidate = occurrenceAt(schedule, n);
  }
  return candidate;
}

// UTC offset of `tz` at instant `ms`, to the minute.
function offsetAt(tz, ms) {
  const local = getLocalTime(tz, new Date(ms));
  const [y, mo, d] = local.dateStr.split('-').map(Number);
  const localAsUtc = Date.UTC(y, mo - 1, d, local.hour, local.minute);
  return localAsUtc - Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant a floating wall clock happens in `tz` (invalid zones fall
 * back to Asia/Kolkata, like the rest of push scheduling). Two passes
 * settle DST; a wall time inside a spring-forward gap lands just after it.
 */
export function localToUtc(wall, tz) {
  const w = wall.getTime();
  const first = w - offsetAt(tz, w);
  return new Date(w - offsetAt(tz, first));
}

/** The admin's current wall clock (IST), as a floating Date. */
export function adminWallNow(now = new Date()) {
  return new Date(now.getTime() + offsetAt(ADMIN_TIMEZONE, now.getTime()));
}

/** Floating Date → 'YYYY-MM-DDTHH:MM'. */
export function formatWall(wall) {
  return wall ? wall.toISOString().slice(0, 16) : null;
}
