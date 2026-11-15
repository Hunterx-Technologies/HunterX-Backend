// src/utils/adminClock.js — The admin panel's calendar.
//
// Admin dashboards, filters and date checks use the zone of the admin's
// browser (the X-Timezone header the admin panel sends), set for the whole
// request by middleware/adminAuth.js. Without it (older admin build, or code
// running outside an admin request) it falls back to IST.
//
// Per-hunter data keeps its own calendar (utils/userClock.js): schedule_date
// and last_active_date are each hunter's local day.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_TIMEZONE, getLocalTime, isValidTimeZone } from './timezone.js';
import { getLocalDateOnly, localDayEnd } from './userClock.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const store = new AsyncLocalStorage();

/** Runs `fn` (and everything it awaits) with the admin's zone. */
export function runWithAdminTimezone(tz, fn) {
  return store.run(isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE, fn);
}

export function getAdminTimezone() {
  return store.getStore() ?? DEFAULT_TIMEZONE;
}

/** Today (+ offsetDays) on the admin's calendar, as a UTC-midnight Date. */
export function getAdminToday(offsetDays = 0) {
  return getLocalDateOnly(getAdminTimezone(), offsetDays);
}

/** The real instant an admin-calendar day (UTC-midnight Date) starts. */
export function adminDayStart(dateOnly) {
  return localDayEnd(new Date(dateOnly.getTime() - DAY_MS), getAdminTimezone());
}

/** 'YYYY-MM-DD' of the admin-calendar day an instant falls on. */
export function adminDateKey(instant) {
  return getLocalTime(getAdminTimezone(), instant).dateStr;
}
