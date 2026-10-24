// src/routes/index.js — Mount all API routes

import { Router } from 'express';
import prisma from '../config/prisma.js';
import authRouter from './auth.js';
import usersRouter from './users.js';
import avatarsRouter from './avatars.js';
import tasksRouter from './tasks.js';
import adminRouter from './admin.js';
import mediaRouter from './media.js';
import ratingsRouter from './ratings.js';
import feedbackRouter from './feedback.js';
import leaderboardRouter from './leaderboard.js';
import notificationsRouter from './notifications.js';
import rewardsRouter from './rewards.js';

const router = Router();

// Health check — 503 when the database is unreachable, so an uptime
// monitor / Railway healthcheck sees a real outage.
router.get('/health', async (req, res) => {
  let database = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'down';
  }
  res.status(database === 'ok' ? 200 : 503).json({
    success:   database === 'ok',
    message:   database === 'ok' ? 'HunterX API is running' : 'Database unreachable',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV,
    database,
  });
});

// Auth and onboarding
router.use('/auth', authRouter);

// User profiles
router.use('/users', usersRouter);

// Avatars catalog
router.use('/avatars', avatarsRouter);

// Daily & weekly tasks
router.use('/tasks', tasksRouter);

// Admin
router.use('/admin', adminRouter);

// Signed Cloudinary uploads
router.use('/media', mediaRouter);

// Rate HunterX (single current rating per user)
router.use('/ratings', ratingsRouter);

// Send Feedback screen
router.use('/feedback', feedbackRouter);

// Leaderboard (global / friends)
router.use('/leaderboard', leaderboardRouter);

// Notification inbox (Home bell)
router.use('/notifications', notificationsRouter);

// Reward wallet + streak scratch cards
router.use('/rewards', rewardsRouter);

export default router;


