// src/index.js — Express application entry point

import 'dotenv/config';
import express            from 'express';
import cors               from 'cors';
import helmet             from 'helmet';
import morgan             from 'morgan';
import { generalLimiter } from './middleware/rateLimiter.js';
import { errorHandler }   from './middleware/errorHandler.js';
import router             from './routes/index.js';
import { info, logError } from './utils/logger.js';
import prisma              from './config/prisma.js';
import redis, { isRedisUp, assertScorePackingSafe } from './config/redis.js';
import { loadLevelsCache } from './services/leaderboardService.js';
import { REDIS_KEYS }      from './config/leaderboardConfig.js';
import { rebuildLeaderboard } from '../scripts/rebuildLeaderboard.js';
import { ensureDefaultAdmin } from './services/adminBootstrapService.js';
import { waitForRedis } from './config/redis.js';
import cron              from 'node-cron';
import './cron/midnight.js';           // starts the nightly task-assignment cron
import './cron/leaderboardNightly.js'; // starts the nightly leaderboard rebuild cron
import './cron/pushDispatcher.js';     // starts push outbox delivery + receipt checks
import './cron/notificationScheduler.js'; // starts local-time scheduled notifications

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
app.use(cors({ origin: '*' }));
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
// rebuilds lb:global/lb:genz from Postgres if they don't exist yet
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
    await Promise.allSettled([prisma.$disconnect(), redis?.quit()]);
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logError(`Unhandled promise rejection: ${reason?.stack || reason}`);
});

export default app;
