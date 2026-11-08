// src/services/authUserCache.js — the user row verifyToken loads on every
// authenticated request (ban / deletion check + req.user), kept briefly in
// memory so a burst of requests from one app (it fires several at once on
// launch) costs one query instead of one each.
//
// Never lets a ban or deletion lag behind:
//   • every write to `users` through the shared Prisma client clears that
//     user's entry the moment it completes (see config/prisma.js), and again
//     a moment later in case it was inside a transaction that hadn't
//     committed yet;
//   • with Redis, the clear is broadcast so every server instance drops it;
//   • anything else (a one-off script, a manual SQL edit) is covered by the
//     short TTL.

const TTL_MS = 15_000;
const MAX_ENTRIES = 10_000;
// A write inside a transaction commits after the query itself returns; a
// request in between could re-cache the old row. Clearing again after this
// delay closes that window.
const RECLEAR_AFTER_MS = 2_000;

const entries = new Map(); // userId string → { user, expiresAt }
let publish = null;        // set by the server when Redis is available

export function getCachedAuthUser(userId) {
  const key = String(userId);
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return undefined;
  }
  return entry.user;
}

export function setCachedAuthUser(userId, user) {
  if (entries.size >= MAX_ENTRIES) {
    // Map keeps insertion order — drop the oldest entry.
    entries.delete(entries.keys().next().value);
  }
  entries.set(String(userId), { user, expiresAt: Date.now() + TTL_MS });
}

/** Drops one user (or everyone, with no id) on this instance only. */
export function clearAuthUserLocal(userId) {
  if (userId === undefined || userId === null) entries.clear();
  else entries.delete(String(userId));
}

/**
 * A user row changed: drop it here, tell the other instances, and drop it
 * again shortly after (see RECLEAR_AFTER_MS). No id = clear everyone.
 */
export function invalidateAuthUser(userId) {
  const key = userId === undefined || userId === null ? null : String(userId);
  clearAuthUserLocal(key);
  publish?.(key ?? '*');
  setTimeout(() => clearAuthUserLocal(key), RECLEAR_AFTER_MS).unref?.();
}

/** Called by the server once Redis pub/sub is set up. */
export function setAuthUserInvalidationPublisher(fn) {
  publish = fn;
}
