// src/utils/dashboardRange.js — the admin Dashboard's date filter.
//
// Every dashboard endpoint takes either
//   ?range=7d | 30d | 60d | 90d | 6m | 1y | 3y     (ending today), or
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD                 (IST calendar days, inclusive)
// and defaults to the last 7 days. Days are IST, like the rest of the app.

import { getISTDateOnly, parseDateOnly } from './helpers.js';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_RANGE = '7d';
const PRESET_DAYS = { '7d': 7, '30d': 30, '60d': 60, '90d': 90 };
const PRESET_MONTHS = { '6m': 6, '1y': 12, '3y': 36 };
export const RANGE_PRESETS = [...Object.keys(PRESET_DAYS), ...Object.keys(PRESET_MONTHS)];
// Longest custom range, so one request can't scan years of history by accident.
const MAX_CUSTOM_DAYS = 5 * 366;

export class DashboardRangeError extends Error {
  constructor(reason) {
    super('INVALID_RANGE');
    this.reason = reason;
  }
}

const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const dateKey = (d) => d.toISOString().slice(0, 10);

// `from` is `months` calendar months before the day after `to` (so 6m on
// Nov 11 is May 12 – Nov 11), clamped for short months.
function monthsBefore(to, months) {
  const next = addDays(to, 1);
  const y = next.getUTCFullYear();
  const m = next.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(next.getUTCDate(), lastDay)));
}

/**
 * Resolves the query into a range. All Date values are UTC-midnight dates
 * standing for IST days (as getISTDateOnly returns), except *Utc / endAt,
 * which are real instants for comparing against UTC timestamp columns.
 *
 *   from, to          first / last IST day (inclusive)
 *   days              number of days
 *   startUtc, endUtc  [start, end) as instants: IST midnight of from / of to+1
 *   endAt             the range's "as of" moment for snapshots: now when the
 *                     range ends today, else the last instant of `to`
 *   prev              the same-length period just before (for % changes)
 */
export function resolveRange(query = {}) {
  const today = getISTDateOnly();
  let from;
  let to;
  let key;

  if (query.from !== undefined || query.to !== undefined) {
    from = parseDateOnly(query.from);
    to = parseDateOnly(query.to);
    if (!from || !to) throw new DashboardRangeError('from and to must both be dates (YYYY-MM-DD)');
    if (from > to) throw new DashboardRangeError('from must be on or before to');
    if (from > today) throw new DashboardRangeError('from cannot be in the future');
    if (to > today) to = today;
    if ((to - from) / DAY_MS + 1 > MAX_CUSTOM_DAYS) throw new DashboardRangeError('A custom range can be at most 5 years');
    key = 'custom';
  } else {
    key = query.range === undefined || query.range === '' ? DEFAULT_RANGE : String(query.range);
    if (!RANGE_PRESETS.includes(key)) throw new DashboardRangeError(`range must be one of ${RANGE_PRESETS.join(', ')}`);
    to = today;
    from = PRESET_DAYS[key] ? addDays(today, -(PRESET_DAYS[key] - 1)) : monthsBefore(today, PRESET_MONTHS[key]);
  }

  return build(key, from, to, today);
}

function build(key, from, to, today) {
  const days = Math.round((to - from) / DAY_MS) + 1;
  const startUtc = new Date(from.getTime() - IST_OFFSET_MS);
  const endUtc = new Date(addDays(to, 1).getTime() - IST_OFFSET_MS);
  const now = new Date();
  const endAt = to.getTime() === today.getTime() ? now : new Date(endUtc.getTime() - 1);
  const range = { key, from, to, days, startUtc, endUtc, endAt, fromKey: dateKey(from), toKey: dateKey(to) };
  if (key !== 'prev') {
    const prevTo = addDays(from, -1);
    range.prev = build('prev', addDays(prevTo, -(days - 1)), prevTo, today);
  }
  return range;
}

/**
 * Splits the range into chart buckets: one per day up to ~3 months, one per
 * week up to ~13 months, else one per calendar month. Each bucket has
 * { key: first day 'YYYY-MM-DD', from, to } (IST days, inclusive).
 */
export function rangeBuckets(range) {
  const unit = range.days <= 92 ? 'day' : range.days <= 400 ? 'week' : 'month';
  const buckets = [];
  let start = range.from;
  while (start <= range.to) {
    let end;
    if (unit === 'day') end = start;
    else if (unit === 'week') end = addDays(start, 6);
    else end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    if (end > range.to) end = range.to;
    buckets.push({ key: dateKey(start), from: start, to: end });
    start = addDays(end, 1);
  }
  return { unit, buckets };
}
