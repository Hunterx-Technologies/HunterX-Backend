// src/cron/pushDispatcher.js — Push outbox delivery.
//   * every minute: send due PENDING notifications (pushDispatchService.js)
//   * every 15 min: check Expo receipts and prune dead device tokens
// Each job skips a tick if its previous run is still going.

import cron from 'node-cron';
import { runPushDispatch, runPushReceiptCheck } from '../services/pushDispatchService.js';
import { logError } from '../utils/logger.js';

function nonOverlapping(name, fn) {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      logError(`${name} crashed: ${err.message}`);
    } finally {
      running = false;
    }
  };
}

export const pushDispatchJob = cron.schedule('* * * * *', nonOverlapping('Push dispatch', runPushDispatch));
export const pushReceiptJob  = cron.schedule('*/15 * * * *', nonOverlapping('Push receipt check', runPushReceiptCheck));

export default pushDispatchJob;
