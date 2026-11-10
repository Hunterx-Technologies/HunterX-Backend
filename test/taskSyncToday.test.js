// Admin task changes reach today's lists right away (taskAssignmentService
// trigger D, called from adminTaskService create / update / toggle).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma, model } from './support/fakePrisma.js';

delete process.env.REDIS_URL;

const fake = createFakePrisma();

// task_schedule with the UNIQUE(user_id, task_id, active_date) that
// createMany({ skipDuplicates }) relies on.
function scheduleModel() {
  const m = model([]);
  const key = (r) => `${r.user_id}:${r.task_id}:${r.active_date.getTime()}`;
  m.createMany = async ({ data, skipDuplicates }) => {
    const seen = new Set(m.rows.map(key));
    let count = 0;
    for (const row of data) {
      if (seen.has(key(row))) {
        if (!skipDuplicates) throw new Error('unique violation');
        continue;
      }
      seen.add(key(row));
      m.rows.push({ ...row });
      count += 1;
    }
    return { count };
  };
  return m;
}

for (const name of ['tasks', 'user_routine_tasks', 'task_admin_targets', 'task_completions', 'task_purchases', 'user_rewards']) {
  fake.models[name] = model([]);
}
fake.models.task_schedule = scheduleModel();

mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
const announced = [];
mock.module(new URL('../src/services/questNotificationService.js', import.meta.url).href, {
  namedExports: { announceTaskChange: async (saved) => { announced.push(saved.id); } },
});
mock.module(new URL('../src/services/imageUploadService.js', import.meta.url).href, {
  namedExports: { uploadCompressedImage: async () => null, deleteImages: async () => {}, ownPublicIdFromUrl: () => null },
});

const { syncTaskForToday, isTaskLiveOn } = await import('../src/services/taskAssignmentService.js');
const { updateTask } = await import('../src/services/adminTaskService.js');
const { getISTDateOnly } = await import('../src/utils/helpers.js');

const DAY = 24 * 60 * 60 * 1000;
const today = getISTDateOnly();
const yesterday = new Date(today.getTime() - DAY);
const tomorrow = new Date(today.getTime() + DAY);

function task(overrides = {}) {
  return {
    id: 5n, title: 'Daily Journaling', description: 'Write', tag: 'Mindfulness',
    image_url: null, image_url_male: null, image_url_female: null,
    task_type: 'DAILY_ADMIN', xp_reward: 5, xp_partial: 2, allows_partial: true,
    target_value: 10, target_unit: 'Mins', is_recurring: true, is_routine: true,
    is_active: true, is_paid: false, price: null, proof_count: 0, special_reward_id: null,
    start_date: yesterday, end_date: null, ...overrides,
  };
}

const onToday = () => fake.models.task_schedule.rows
  .filter((r) => r.task_id === 5n && r.active_date.getTime() === today.getTime())
  .map((r) => r.user_id)
  .sort();

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  announced.length = 0;
  fake.models.users.rows.push(
    { id: 1n, onboarding_done: true, is_banned: false },
    { id: 2n, onboarding_done: true, is_banned: false },
    { id: 3n, onboarding_done: true, is_banned: false },
    { id: 4n, onboarding_done: false, is_banned: false }, // still onboarding
    { id: 5n, onboarding_done: true, is_banned: true },   // banned
  );
});

test('a routine task goes on today\'s list for every hunter who hasn\'t turned it off', async () => {
  fake.models.tasks.rows.push(task());
  fake.models.user_routine_tasks.rows.push({ user_id: 2n, task_id: 5n, selected: false });
  fake.models.task_schedule.rows.push({ user_id: 3n, task_id: 5n, active_date: today }); // already has it

  const result = await syncTaskForToday(5n, today);
  assert.deepEqual(result, { added: 1, removed: 0 });
  assert.deepEqual(onToday(), [1n, 3n]);
});

test('a targeted admin task only reaches its targets', async () => {
  fake.models.tasks.rows.push(task({ is_routine: false, is_recurring: false, start_date: today, end_date: today }));
  fake.models.task_admin_targets.rows.push({ task_id: 5n, user_id: 2n });

  await syncTaskForToday(5n, today);
  assert.deepEqual(onToday(), [2n]);
});

test('moving a task out of today removes it, except for hunters who already acted on it', async () => {
  fake.models.tasks.rows.push(task({ is_routine: false, is_recurring: false, start_date: tomorrow, end_date: tomorrow }));
  for (const user_id of [1n, 2n, 3n]) fake.models.task_schedule.rows.push({ user_id, task_id: 5n, active_date: today });
  fake.models.task_completions.rows.push({ user_id: 2n, task_id: 5n, schedule_date: today, status: 'COMPLETED' });

  const result = await syncTaskForToday(5n, today);
  assert.deepEqual(result, { added: 0, removed: 2 });
  assert.deepEqual(onToday(), [2n]);
});

test('deactivating leaves today\'s rows alone (the list hides inactive tasks)', async () => {
  fake.models.tasks.rows.push(task({ is_active: false }));
  fake.models.task_schedule.rows.push({ user_id: 1n, task_id: 5n, active_date: today });

  assert.deepEqual(await syncTaskForToday(5n, today), { added: 0, removed: 0 });
  assert.deepEqual(onToday(), [1n]);
});

test('paid tasks are left to purchases', async () => {
  fake.models.tasks.rows.push(task({ is_routine: false, is_paid: true, price: 99, start_date: today, end_date: tomorrow }));
  fake.models.task_schedule.rows.push({ user_id: 1n, task_id: 5n, active_date: today }); // a buyer

  assert.deepEqual(await syncTaskForToday(5n, today), { added: 0, removed: 0 });
  assert.deepEqual(onToday(), [1n]);
});

test('isTaskLiveOn matches the nightly rules', () => {
  assert.equal(isTaskLiveOn(task(), today), true);
  assert.equal(isTaskLiveOn(task({ start_date: null }), today), true);           // built-in routine
  assert.equal(isTaskLiveOn(task({ start_date: tomorrow }), today), false);
  assert.equal(isTaskLiveOn(task({ end_date: yesterday }), today), false);
  assert.equal(isTaskLiveOn(task({ is_routine: false, start_date: null }), today), false);
  assert.equal(isTaskLiveOn(task({ is_routine: false, is_paid: true }), today), false);
  assert.equal(isTaskLiveOn(task({ is_active: false }), today), false);
});

test('switching a task on in the admin panel puts it on today\'s lists before the push', async () => {
  fake.models.tasks.rows.push(task({ is_active: false }));

  await updateTask('5', { is_active: true });
  assert.deepEqual(onToday(), [1n, 2n, 3n]);
  assert.deepEqual(announced, [5n]);
});
