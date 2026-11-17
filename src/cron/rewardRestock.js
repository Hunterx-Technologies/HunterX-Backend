// src/cron/rewardRestock.js — every 15 minutes, gives coupons to reward
// cards hunters earned while a reward was out of stock
// (rewardService.js#fulfillAwaitingCards). Admin edits fill them straight
// away; this catches the rest: a coupon whose start date (valid_from) has
// just arrived, and any fill that failed.

import { scheduleJob } from './lock.js';
import { fulfillAwaitingCards } from '../services/rewardService.js';
import { info } from '../utils/logger.js';

export async function runRewardRestock() {
  const filled = await fulfillAwaitingCards();
  if (filled > 0) info(`Reward restock: ${filled} owed card(s) filled`);
}

// :10, :25, :40, :55 — off the other 15-minute jobs
export const rewardRestockJob = scheduleJob('Reward restock', '10,25,40,55 * * * *', 14 * 60, runRewardRestock);

export default rewardRestockJob;
