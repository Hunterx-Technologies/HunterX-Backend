// src/config/prisma.js — Single Prisma client instance for entire app

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { invalidateAuthUser } from '../services/authUserCache.js';

// pg's defaults: 10 connections, and a request waits forever for one. Cap the
// wait so a stuck pool or unreachable database fails the request (500)
// instead of hanging it, and recycle idle connections. DB_POOL_MAX can raise
// the size if Postgres allows more connections.
const pool = new pg.Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     Number(process.env.DB_POOL_MAX) || 10,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis:       30_000,
});
// An idle client losing its connection (DB restart, network blip) emits an
// error on the pool; without a listener that would crash the process.
pool.on('error', (err) => {
  console.error(`[db] idle connection error: ${err.message}`);
});
const adapter = new PrismaPg(pool);

const baseClient = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'error', 'warn']
    : ['error'],
});

// Every write to `users` clears that user's cached auth row (see
// services/authUserCache.js), so a ban, deletion, role or profile change
// applies to the very next request. Bulk writes clear everyone.
const USER_WRITES = new Set(['create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn', 'upsert', 'delete', 'deleteMany']);

function singleUserId(args) {
  const id = args?.where?.id;
  return typeof id === 'bigint' || typeof id === 'number' || typeof id === 'string' ? id : null;
}

const prisma = baseClient.$extends({
  query: {
    users: {
      async $allOperations({ operation, args, query }) {
        const result = await query(args);
        if (USER_WRITES.has(operation)) {
          const id = singleUserId(args);
          // create* adds a row nobody has cached yet — nothing to clear.
          if (!operation.startsWith('create')) invalidateAuthUser(id ?? undefined);
        }
        return result;
      },
    },
  },
});

export default prisma;
