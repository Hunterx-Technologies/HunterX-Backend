// src/cron/pushDispatcher.js — Push outbox delivery.
//   * every minute: send due PENDING notifications (pushDispatchService.js)
//   * every 15 min: check Expo receipts and prune dead device tokens
// Each job skips a tick if its previous run is still going, and runs on
// one instance only (cron/lock.js).

import { runPushDispatch, runPushReceiptCheck } from '../services/pushDispatchService.js';
import { scheduleJob } from './lock.js';

export const pushDispatchJob = scheduleJob('Push dispatch', '* * * * *', 55, runPushDispatch);
export const pushReceiptJob  = scheduleJob('Push receipt check', '*/15 * * * *', 14 * 60, runPushReceiptCheck);

export default pushDispatchJob;
