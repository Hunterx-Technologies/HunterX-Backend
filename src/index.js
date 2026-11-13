// src/index.js — Express application entry point

import 'dotenv/config';
import express            from 'express';
import cors               from 'cors';
import helmet             from 'helmet';
import morgan             from 'morgan';
import compression        from 'compression';
import { generalLimiter } from './middleware/rateLimiter.js';
import { errorHandler }   from './middleware/errorHandler.js';
import router             from './routes/index.js';
import { info, logError } from './utils/logger.js';
import prisma, { pool }    from './config/prisma.js';
import redis, { isRedisUp, assertScorePackingSafe } from './config/redis.js';
import { loadLevelsCache } from './services/leaderboardService.js';
import { REDIS_KEYS }      from './config/leaderboardConfig.js';
import { rebuildLeaderboard } from '../scripts/rebuildLeaderboard.js';
import { ensureDefaultAdmin } from './services/adminBootstrapService.js';
import { waitForRedis } from './config/redis.js';
import { clearAuthUserLocal, setAuthUserInvalidationPublisher } from './services/authUserCache.js';
import cron              from 'node-cron';
import './cron/midnight.js';           // starts the nightly task-assignment cron
import './cron/leaderboardNightly.js'; // starts the nightly leaderboard rebuild cron
import './cron/pushDispatcher.js';     // starts push outbox delivery + receipt checks
import './cron/notificationScheduler.js'; // starts local-time scheduled notifications
import './cron/broadcastScheduler.js'; // starts admin-scheduled / recurring broadcasts
import './cron/accountDeletion.js';   // starts the hourly scheduled-deletion purge

const app  = express();
const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

// Railway (and any load balancer) sits in front of the app — trust its one
// X-Forwarded-For hop so req.ip is the real client. Without this every
// request appears to come from the proxy and the rate limiters share a
// single bucket across ALL users.
app.set('trust proxy', 1);

// Middleware
app.use(helmet());
// gzip JSON responses (the task list, leaderboard and profile shrink ~70-80%).
// Clients opt in via Accept-Encoding, so nothing changes for one that doesn't.
app.use(compression());
// CORS_ORIGINS: comma-separated browser origins allowed to call the API
// (the admin panel, the website's delete-account page). The mobile app
// sends no Origin and is unaffected. Unset = any origin, as before — the
// API uses bearer tokens, not cookies, so this is defence in depth.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
if (corsOrigins.length === 0 && isProduction) {
  logError('CORS_ORIGINS is not set — allowing every origin. Set it to the admin and website origins.');
}
app.use(cors({ origin: corsOrigins.length > 0 ? corsOrigins : '*' }));
app.use(morgan(isProduction ? 'combined' : 'dev'));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(generalLimiter);

// Routes
app.use('/api', router);

// 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.url} not found`,
  });
});

// Global error handler — must be last
app.use(errorHandler);

// Leaderboard startup — loads the in-memory levels cache, checks the
// Redis score-packing bit widths still hold against live data, and
// rebuilds lb:global from Postgres if it doesn't exist yet
// (fresh Redis instance, or one that lost its data). None of this
// blocks the server from accepting requests — on failure it logs and
// the API falls back to the Postgres leaderboard path.
async function initLeaderboard() {
  try {
    await loadLevelsCache();
    await assertScorePackingSafe(prisma);
    await waitForRedis();

    if (isRedisUp() && !(await redis.exists(REDIS_KEYS.global))) {
      info('lb:global not found in Redis — running an automatic leaderboard rebuild');
      await rebuildLeaderboard();
    }
  } catch (err) {
    logError(`Leaderboard startup init failed: ${err.message}`);
  }
}

// Auth-user cache: with Redis, a cleared entry is broadcast so every server
// instance drops it (a ban on one applies on all). Without Redis — or while
// it's down — each instance relies on its own clearing plus the short TTL.
const AUTH_CACHE_CHANNEL = 'hx:auth-user-invalidate';
let authCacheSubscriber = null;
function startAuthCacheSync() {
  if (!redis) return;
  // Its own connection (a subscribed client can't run other commands). Unlike
  // the main client it may queue while connecting, so the SUBSCRIBE below
  // isn't lost at startup; ioredis re-subscribes after any reconnect.
  authCacheSubscriber = redis.duplicate({ enableOfflineQueue: true, maxRetriesPerRequest: null });
  authCacheSubscriber.on('error', (err) => logError(`Auth cache subscriber: ${err.message}`));
  authCacheSubscriber.subscribe(AUTH_CACHE_CHANNEL).catch((err) => logError(`Auth cache subscribe failed: ${err.message}`));
  authCacheSubscriber.on('message', (_channel, key) => clearAuthUserLocal(key === '*' ? null : key));
  setAuthUserInvalidationPublisher((key) => {
    if (isRedisUp()) redis.publish(AUTH_CACHE_CHANNEL, key).catch(() => {});
  });
}
startAuthCacheSync();

// Start
const server = app.listen(PORT, '0.0.0.0', () => {
  info(`HunterX backend running on port ${PORT}`);
  info(`Health: http://localhost:${PORT}/api/health`);
  initLeaderboard();
  ensureDefaultAdmin().catch((err) => logError(`Default admin bootstrap failed: ${err.message}`));
});

// Graceful shutdown — Railway sends SIGTERM on every redeploy. Stop taking
// new connections and cron ticks, let in-flight requests finish, then
// close the DB pool and Redis. Hard exit after 10s either way.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  info(`${signal} received — shutting down`);
  for (const task of cron.getTasks().values()) task.stop();
  setTimeout(() => process.exit(1), 10_000).unref();
  server.close(async () => {
    await Promise.allSettled([prisma.$disconnect(), redis?.quit(), authCacheSubscriber?.quit()]);
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logError(`Unhandled promise rejection: ${reason?.stack || reason}`);
});

export default app;
