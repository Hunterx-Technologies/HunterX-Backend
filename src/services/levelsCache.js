// src/services/levelsCache.js — the `levels` table, held in memory.
//
// It's a small, static table (only the seed script writes it), read on every
// GET /auth/me. Loaded on first use and re-read every REFRESH_MS so a re-seed
// is picked up without a restart. If a lookup misses (e.g. a level added
// since the last load), the rows are read from the database instead.

import prisma from '../config/prisma.js';

const REFRESH_MS = 10 * 60 * 1000;

let byNumber = null;        // Map<level_number, levels row>
let loadedAt = 0;
let loading = null;         // in-flight load, shared by concurrent callers

async function load() {
  const rows = await prisma.levels.findMany();
  byNumber = new Map(rows.map((row) => [row.level_number, row]));
  loadedAt = Date.now();
}

async function ensureLoaded() {
  if (byNumber && Date.now() - loadedAt < REFRESH_MS) return;
  loading ??= load().finally(() => {
    loading = null;
  });
  try {
    await loading;
  } catch {
    // Database hiccup: keep serving the previous copy if there is one.
    if (!byNumber) throw new Error('LEVELS_UNAVAILABLE');
  }
}

/** The `levels` rows for these level numbers (missing ones are left out). */
export async function getLevelRows(levelNumbers) {
  try {
    await ensureLoaded();
    const rows = levelNumbers.map((n) => byNumber.get(n)).filter(Boolean);
    if (rows.length === levelNumbers.length) return rows;
  } catch {
    // fall through to the database
  }
  return prisma.levels.findMany({ where: { level_number: { in: levelNumbers } } });
}

/** Tests / seed scripts: forget the cached copy. */
export function resetLevelsCache() {
  byNumber = null;
  loadedAt = 0;
}
