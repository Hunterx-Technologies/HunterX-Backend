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
import './cron/midnight.js';           // starts the nightly task-assignment cron
import './cron/leaderboardNightly.js'; // starts the nightly leaderboard rebuild cron
import './cron/pushDispatcher.js';     // starts push outbox delivery + receipt checks
import './cron/notificationScheduler.js'; // starts local-time scheduled notifications

const app  = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(morgan('dev'));
app.use(express.json());
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

    if (isRedisUp() && !(await redis.exists(REDIS_KEYS.global))) {
      info('lb:global not found in Redis — running an automatic leaderboard rebuild');
      await rebuildLeaderboard();
    }
  } catch (err) {
    logError(`Leaderboard startup init failed: ${err.message}`);
  }
}

// Start
app.listen(PORT, '0.0.0.0', () => {
  info(`HunterX backend running on port ${PORT}`);
  info(`Health: http://localhost:${PORT}/api/health`);
  info(`LAN Health: http://192.168.1.9:${PORT}/api/health`);
  initLeaderboard();
});

export default app;
