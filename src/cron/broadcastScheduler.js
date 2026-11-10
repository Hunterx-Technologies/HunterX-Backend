// src/cron/broadcastScheduler.js — Admin-scheduled broadcasts.
//   * every minute: send due scheduled / recurring broadcasts, advance
//     recurring ones, close out and clean up finished one-time ones
//     (broadcastScheduleService.js)
// Runs on one instance per tick (cron/lock.js). Delivery itself goes
// through the push outbox (cron/pushDispatcher.js).

import { runBroadcastScheduler } from '../services/broadcastScheduleService.js';
import { scheduleJob } from './lock.js';

export const broadcastSchedulerJob = scheduleJob('Broadcast scheduler', '* * * * *', 55, () => runBroadcastScheduler());

export default broadcastSchedulerJob;
