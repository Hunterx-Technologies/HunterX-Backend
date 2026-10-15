// src/utils/timezone.js — Per-user local time helpers for push scheduling.
// Users store an IANA zone (user_settings.timezone, default Asia/Kolkata).

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

export function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "HH:MM", 24h
export function isValidTimeOfDay(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

const formatterCache = new Map();

function getFormatter(tz) {
  let fmt = formatterCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    formatterCache.set(tz, fmt);
  }
  return fmt;
}

// Wall-clock parts in `tz` for `date`:
// { dateStr: 'YYYY-MM-DD', weekday (0=Sun..6=Sat), hour, minute, minutesOfDay }.
// Falls back to DEFAULT_TIMEZONE if `tz` is invalid.
export function getLocalTime(tz, date = new Date()) {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE;
  const parts = Object.fromEntries(
    getFormatter(zone).formatToParts(date).map((p) => [p.type, p.value])
  );
  const hour    = Number(parts.hour);
  const minute  = Number(parts.minute);
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    timezone: zone,
    dateStr,
    weekday: new Date(`${dateStr}T00:00:00Z`).getUTCDay(),
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
  };
}

export function timeOfDayToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// True when local time falls in [startHour:00, endHour:00), wrapping midnight.
export function isWithinHours(local, startHour, endHour) {
  const start = startHour * 60;
  const end   = endHour * 60;
  const t     = local.minutesOfDay;
  return start <= end ? t >= start && t < end : t >= start || t < end;
}

// Minutes from `local` until the next occurrence of `hour`:00 local.
export function minutesUntilLocalHour(local, hour) {
  const diff = hour * 60 - local.minutesOfDay;
  return diff > 0 ? diff : diff + 24 * 60;
}
