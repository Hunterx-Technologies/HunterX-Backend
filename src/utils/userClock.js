// src/utils/userClock.js — "Today" on each hunter's own calendar.
//
// Quests, streaks and every other per-user day roll over at the user's
// local midnight, in the IANA zone their phone reports
// (user_settings.timezone, kept current by the X-Timezone header — see
// middleware/auth.js). Dates come back in the @db.Date convention: a
// UTC-midnight Date standing for that local calendar day.
//
// Admin dashboards and admin-entered dates use the admin's own calendar
// instead (utils/adminClock.js).

import prisma from '../config/prisma.js';
import { DEFAULT_TIMEZONE, getLocalTime, isValidTimeZone } from './timezone.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ── Pure helpers (no DB) ─────────────────────────────────────

// The calendar day it is in `tz` at `now` (+ offsetDays), as a UTC-midnight Date.
export function getLocalDateOnly(tz, offsetDays = 0, now = new Date()) {
  const [y, m, d] = getLocalTime(tz, now).dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays));
}

// Monday of the current week in `tz`, as a UTC-midnight Date.
export function getLocalWeekStart(tz, now = new Date()) {
  const today = getLocalDateOnly(tz, 0, now);
  const day = today.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  return new Date(today.getTime() - (day === 0 ? 6 : day - 1) * MS_PER_DAY);
}

// The calendar day in `tz` that the instant `date` falls on.
export function localDayOf(date, tz) {
  return getLocalDateOnly(tz, 0, date);
}

// The real instant a local calendar day (UTC-midnight Date) ends in `tz`,
// i.e. the next local midnight. Found from the zone's UTC offset at that
// moment, so DST days come out right.
export function localDayEnd(dateOnly, tz) {
  const nextMidnightUtc = dateOnly.getTime() + MS_PER_DAY;
  // Offset = how far the zone's wall clock is ahead of UTC around then.
  const wall = getLocalTime(tz, new Date(nextMidnightUtc));
  const [y, m, d] = wall.dateStr.split('-').map(Number);
  const offsetMs = Date.UTC(y, m - 1, d, wall.hour, wall.minute) - nextMidnightUtc;
  return new Date(nextMidnightUtc - offsetMs);
}

// ── Per-user zone, cached ────────────────────────────────────

// userId → { tz, at }. Short-lived so a zone change made on another server
// instance is picked up within minutes; this instance updates it at once.
const zoneCache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50_000;

function cacheSet(key, tz) {
  if (zoneCache.size >= CACHE_MAX) zoneCache.clear();
  zoneCache.set(key, { tz, at: Date.now() });
}

export async function getUserTimezone(userId) {
  const key = String(userId);
  const hit = zoneCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.tz;
  const row = await prisma.user_settings.findUnique({
    where:  { user_id: BigInt(key) },
    select: { timezone: true },
  });
  const tz = isValidTimeZone(row?.timezone) ? row.timezone : DEFAULT_TIMEZONE;
  cacheSet(key, tz);
  return tz;
}

// Zones for many users at once (leaderboards, friend lists) → Map(idString → tz).
export async function getUserTimezones(userIds) {
  const out = new Map();
  const missing = [];
  for (const id of userIds) {
    const key = String(id);
    const hit = zoneCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) out.set(key, hit.tz);
    else missing.push(key);
  }
  if (missing.length > 0) {
    const rows = await prisma.user_settings.findMany({
      where:  { user_id: { in: missing.map((k) => BigInt(k)) } },
      select: { user_id: true, timezone: true },
    });
    const found = new Map(rows.map((r) => [r.user_id.toString(), r.timezone]));
    for (const key of missing) {
      const tz = isValidTimeZone(found.get(key)) ? found.get(key) : DEFAULT_TIMEZONE;
      cacheSet(key, tz);
      out.set(key, tz);
    }
  }
  return out;
}

/**
 * Called on every authenticated request with the phone's X-Timezone header:
 * saves the zone when it changed (travel, first launch, users who never
 * allowed notifications). Never throws: a bad header just keeps the old zone.
 */
export async function rememberUserTimezone(userId, tz) {
  if (!isValidTimeZone(tz)) return;
  try {
    if ((await getUserTimezone(userId)) === tz) return;
    const bUserId = BigInt(userId);
    await prisma.user_settings.upsert({
      where:  { user_id: bUserId },
      create: { user_id: bUserId, timezone: tz },
      update: { timezone: tz, updated_at: new Date() },
    });
    cacheSet(String(userId), tz);
  } catch {
    // Best effort: the next request tries again.
  }
}

// Clears the cache entry, e.g. after PUT /users/settings changed the zone.
export function forgetUserTimezone(userId) {
  zoneCache.delete(String(userId));
}

// ── Per-user "today" ─────────────────────────────────────────

export async function getUserToday(userId, offsetDays = 0) {
  return getLocalDateOnly(await getUserTimezone(userId), offsetDays);
}

export async function getUserWeekStart(userId) {
  return getLocalWeekStart(await getUserTimezone(userId));
}
