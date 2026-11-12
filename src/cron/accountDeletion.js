// src/cron/accountDeletion.js — Hourly housekeeping for accounts:
//   * deletes accounts whose 30-day deletion grace period is over
//     (accountDeletionService.js#purgeDueAccounts)
//   * reminds hunters 3 days before their account is deleted (push +
//     email, accountDeletionService.js#sendDeletionReminders)
//   * drops refresh-token rows past their expiry (sessionService.js)

import { scheduleJob } from './lock.js';
import { purgeDueAccounts, sendDeletionReminders } from '../services/accountDeletionService.js';
import { deleteExpiredSessions } from '../services/sessionService.js';
import { info } from '../utils/logger.js';

export async function runAccountHousekeeping() {
  const deleted = await purgeDueAccounts();
  if (deleted > 0) info(`Account deletion: ${deleted} account(s) deleted after their grace period`);
  const reminded = await sendDeletionReminders();
  if (reminded > 0) info(`Account deletion: ${reminded} reminder(s) sent`);
  const { count } = await deleteExpiredSessions();
  if (count > 0) info(`Sessions: ${count} expired refresh token(s) removed`);
}

// :05 past every hour
export const accountDeletionJob = scheduleJob('Account housekeeping', '5 * * * *', 55 * 60, runAccountHousekeeping);

export default accountDeletionJob;
