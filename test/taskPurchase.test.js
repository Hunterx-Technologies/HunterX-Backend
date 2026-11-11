// Paid task access windows (taskPurchaseService.js): a buyer gets one full
// period from the day they pay, whatever day of the sale that is, and the
// task stays active past its sale until the last buyer's access ends.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (s) => new Date(`${s}T00:00:00.000Z`);

let purchaseRow;
let updateData;
let updateManyWhere;
const prismaStub = {
  task_purchases: {
    findUnique: async () => purchaseRow,
    update: async ({ data }) => { updateData = data; return { ...purchaseRow, ...data }; },
  },
  tasks: {
    updateMany: async ({ where }) => { updateManyWhere = where; return { count: 0 }; },
  },
};

let today = day('2026-12-10');
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: prismaStub });
mock.module(new URL('../src/services/taskAssignmentService.js', import.meta.url).href, {
  namedExports: { assignDailyTasks: async () => ({ assigned: 1 }) },
});
mock.module(new URL('../src/services/notificationService.js', import.meta.url).href, {
  namedExports: { createNotification: async () => null },
});
const helpers = await import('../src/utils/helpers.js');
mock.module(new URL('../src/utils/helpers.js', import.meta.url).href, {
  namedExports: { ...helpers, getISTDateOnly: () => today },
});

const { accessEndFor, markPurchasePaid, deactivateExpiredPaidTasks } =
  await import('../src/services/taskPurchaseService.js');

beforeEach(() => {
  updateData = undefined;
  updateManyWhere = undefined;
});

function pending(taskType, endDate) {
  return {
    id: 1n, user_id: 7n, task_id: 11n, status: 'PENDING',
    tasks: { title: 'Running Rookie', task_type: taskType, end_date: day(endDate), is_active: true },
  };
}

test('access is one full period of the task type', () => {
  const start = day('2026-11-11');
  assert.equal(accessEndFor({ task_type: 'MONTHLY' }, start).getTime(), start.getTime() + 29 * DAY_MS);
  assert.equal(accessEndFor({ task_type: 'WEEKLY' }, start).getTime(), start.getTime() + 6 * DAY_MS);
  assert.equal(accessEndFor({ task_type: 'DAILY_ADMIN' }, start).getTime(), start.getTime());
});

test('a monthly task bought near the end of its sale still gets 30 days', async () => {
  today = day('2026-12-10');
  purchaseRow = pending('MONTHLY', '2026-12-11');
  await markPurchasePaid(1n);
  assert.equal(updateData.access_start.getTime(), day('2026-12-10').getTime());
  assert.equal(updateData.access_end.getTime(), day('2027-01-08').getTime());
});

test('a monthly task bought on its first day gets exactly one 30-day period', async () => {
  today = day('2026-11-11');
  purchaseRow = pending('MONTHLY', '2026-12-11');
  await markPurchasePaid(1n);
  assert.equal(updateData.access_end.getTime(), day('2026-12-10').getTime());
});

test('buying after the sale has ended is still refused', async () => {
  today = day('2026-12-12');
  purchaseRow = pending('MONTHLY', '2026-12-11');
  await assert.rejects(markPurchasePaid(1n), /TASK_NOT_ON_SALE/);
  assert.equal(updateData, undefined);
});

test('the nightly job leaves a finished sale active while a buyer still has access', async () => {
  const now = day('2026-12-20');
  await deactivateExpiredPaidTasks(now);
  assert.deepEqual(updateManyWhere.end_date, { lt: now });
  assert.deepEqual(updateManyWhere.task_purchases, {
    none: { status: 'PAID', completed_at: null, access_end: { gte: now } },
  });
});
