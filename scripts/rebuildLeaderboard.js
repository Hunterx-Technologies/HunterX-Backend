// scripts/rebuildLeaderboard.js — Full rebuild of the lb:global / lb:genz
// Redis sorted sets from Postgres (the source of truth).
//
// Reads users in keyset batches of 5k (by id), pipelines ZADDs into
// temporary keys, then RENAMEs over the live keys at the end — so
// readers never see a half-built or empty leaderboard mid-rebuild.
// Guarded by a Redis lock (lb:rebuild:lock) so two instances racing
// (e.g. two containers both noticing lb:global is missing right after
// deploy) can't rebuild concurrently; the loser just logs and exits.
//
// Run manually: `npm run rebuild:leaderboard`
// Also called automatically from src/index.js if lb:global doesn't
// exist at startup, and wired into railway.json's deploy command.

import 'dotenv/config';
import crypto from 'crypto';
import prisma from '../src/config/prisma.js';
import redis, { isRedisUp } from '../src/config/redis.js';
import { info, logError } from '../src/utils/logger.js';
import {
  REDIS_KEYS,
  DISPLAY_HASH_TTL_SECONDS,
  GENZ_BIRTH_YEAR_START,
  GENZ_BIRTH_YEAR_END,
} from '../src/config/leaderboardConfig.js';
import { encodeScore, buildAvatarThumbUrl } from '../src/services/leaderboardService.js';

const BATCH_SIZE = 5000;
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes — generous for a 10M-row scan

function isGenzDob(dob) {
  if (!dob) return false;
  const year = dob.getUTCFullYear();
  return year >= GENZ_BIRTH_YEAR_START && year <= GENZ_BIRTH_YEAR_END;
}

async function acquireLock() {
  const token = crypto.randomUUID();
  const ok = await redis.set(REDIS_KEYS.rebuildLock, token, 'NX', 'PX', LOCK_TTL_MS);
  return ok === 'OK' ? token : null;
}

async function releaseLock(token) {
  const current = await redis.get(REDIS_KEYS.rebuildLock);
  if (current === token) await redis.del(REDIS_KEYS.rebuildLock);
}

export async function rebuildLeaderboard({ batchSize = BATCH_SIZE } = {}) {
  if (!isRedisUp()) {
    logError('rebuildLeaderboard: Redis is unreachable, skipping rebuild');
    return { skipped: true, reason: 'REDIS_DOWN' };
  }

  const token = await acquireLock();
  if (!token) {
    info('rebuildLeaderboard: another instance already holds the rebuild lock, skipping');
    return { skipped: true, reason: 'LOCKED' };
  }

  const tmpGlobal = `${REDIS_KEYS.global}:rebuilding`;
  const tmpGenz = `${REDIS_KEYS.genz}:rebuilding`;

  try {
    await redis.del(tmpGlobal, tmpGenz);

    let lastId = 0n;
    let scanned = 0;
    let globalCount = 0;
    let genzCount = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rows = await prisma.users.findMany({
        where: { id: { gt: lastId } },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: {
          id: true,
          name: true,
          onboarding_done: true,
          is_banned: true,
          role: true,
          date_of_birth: true,
          avatars: { select: { image_url: true } },
          user_settings: { select: { leaderboard_visible: true } },
          user_progression: { select: { total_xp: true } },
        },
      });

      if (rows.length === 0) break;

      const pipeline = redis.pipeline();
      for (const row of rows) {
        const totalXp = row.user_progression?.total_xp ?? 0;
        const visible = row.user_settings?.leaderboard_visible ?? true;
        const eligible = Boolean(row.onboarding_done) && !row.is_banned && row.role === 'USER' && visible && totalXp > 0;

        if (eligible) {
          const score = encodeScore(totalXp, row.id);
          const member = row.id.toString();
          pipeline.zadd(tmpGlobal, score, member);
          globalCount++;

          if (isGenzDob(row.date_of_birth)) {
            pipeline.zadd(tmpGenz, score, member);
            genzCount++;
          }

          const thumbUrl = buildAvatarThumbUrl(row.avatars?.image_url) ?? '';
          pipeline.hset(REDIS_KEYS.userHash(member), { name: row.name ?? '', avatarThumbUrl: thumbUrl });
          pipeline.expire(REDIS_KEYS.userHash(member), DISPLAY_HASH_TTL_SECONDS);
        }
      }
      await pipeline.exec();

      scanned += rows.length;
      lastId = rows[rows.length - 1].id;

      if (scanned % (batchSize * 10) === 0) {
        info(`rebuildLeaderboard: scanned ${scanned} users so far...`);
      }
    }

    // Atomic swap — RENAME replaces the destination key in one step, so
    // there's no window where lb:global/lb:genz is missing or empty.
    // Empty-set edge case: RENAME fails if the source key was never
    // written to (e.g. zero eligible users) — ZADD a sentinel-free empty
    // set via DEL+creating the key isn't needed; guard with EXISTS.
    if (await redis.exists(tmpGlobal)) await redis.rename(tmpGlobal, REDIS_KEYS.global);
    else await redis.del(REDIS_KEYS.global);

    if (await redis.exists(tmpGenz)) await redis.rename(tmpGenz, REDIS_KEYS.genz);
    else await redis.del(REDIS_KEYS.genz);

    info(`rebuildLeaderboard: done — scanned ${scanned} users, lb:global=${globalCount}, lb:genz=${genzCount}`);
    return { skipped: false, scanned, globalCount, genzCount };
  } finally {
    await redis.del(tmpGlobal, tmpGenz).catch(() => {});
    await releaseLock(token).catch((err) => logError(`rebuildLeaderboard: failed to release lock: ${err.message}`));
  }
}

const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  rebuildLeaderboard()
    .then((result) => {
      info(`rebuildLeaderboard script finished: ${JSON.stringify(result)}`);
      process.exit(0);
    })
    .catch((err) => {
      logError(`rebuildLeaderboard script crashed: ${err.message}`);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
