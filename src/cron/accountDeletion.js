// src/cron/accountDeletion.js — Hourly housekeeping for accounts:
//   * deletes accounts whose 30-day deletion grace period is over
//     (accountDeletionService.js#purgeDueAccounts)
//   * drops refresh-token rows past their expiry (sessionService.js)

import { scheduleJob } from './lock.js';
import { purgeDueAccounts } from '../services/accountDeletionService.js';
import { deleteExpiredSessions } from '../services/sessionService.js';
import { info } from '../utils/logger.js';

export async function runAccountHousekeeping() {
  const deleted = await purgeDueAccounts();
  if (deleted > 0) info(`Account deletion: ${deleted} account(s) deleted after their grace period`);
  const { count } = await deleteExpiredSessions();
  if (count > 0) info(`Sessions: ${count} expired refresh token(s) removed`);
}

// :05 past every hour
export const accountDeletionJob = scheduleJob('Account housekeeping', '5 * * * *', 55 * 60, runAccountHousekeeping);

export default accountDeletionJob;
