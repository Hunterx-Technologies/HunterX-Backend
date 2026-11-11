// Built-in (DAILY_FIXED) tasks: title, description, XP, partial completion
// and images are editable; type, tag, target and schedule are not
// (adminTaskService.updateBuiltInTask).
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma, model } from './support/fakePrisma.js';

delete process.env.REDIS_URL;

const fake = createFakePrisma();
for (const name of ['tasks', 'user_routine_tasks', 'task_admin_targets', 'task_completions', 'task_purchases', 'user_rewards', 'task_schedule']) {
  fake.models[name] = model([]);
}

mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/services/questNotificationService.js', import.meta.url).href, {
  namedExports: { announceTaskChange: async () => {} },
});
mock.module(new URL('../src/services/imageUploadService.js', import.meta.url).href, {
  namedExports: { uploadCompressedImage: async () => null, deleteImages: async () => {}, ownPublicIdFromUrl: () => null },
});

const { updateTask } = await import('../src/services/adminTaskService.js');

const steps = () => ({
  id: 4n, title: 'Daily Steps', description: 'Hit your step target', tag: 'STEPS',
  image_url: 'm.jpg', image_url_male: 'm.jpg', image_url_female: 'f.jpg',
  task_type: 'DAILY_FIXED', xp_reward: 10, xp_partial: 5, allows_partial: true,
  target_value: null, target_unit: 'steps', is_recurring: true, is_routine: true,
  is_default_daily: true, is_active: true, is_paid: false, price: null, proof_count: 0,
  special_reward_id: null, start_date: new Date('2026-09-13'), end_date: null,
});

const row = () => fake.models.tasks.rows.find((t) => t.id === 4n);

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  fake.models.tasks.rows.push(steps());
});

test('title, description, XP and partial completion can be changed', async () => {
  await updateTask('4', { title: '  Walk 10k  ', description: 'Move more', xp_reward: 8, allows_partial: true });
  const t = row();
  assert.equal(t.title, 'Walk 10k');
  assert.equal(t.description, 'Move more');
  assert.equal(t.xp_reward, 8);
  assert.equal(t.xp_partial, 4);
  assert.equal(t.tag, 'STEPS');
  assert.equal(t.task_type, 'DAILY_FIXED');
});

test('switching partial off zeroes partial XP', async () => {
  await updateTask('4', { allows_partial: false });
  assert.equal(row().allows_partial, false);
  assert.equal(row().xp_partial, 0);
});

test('a new male image URL also updates image_url', async () => {
  await updateTask('4', { image_url_male: 'new.jpg' });
  assert.equal(row().image_url_male, 'new.jpg');
  assert.equal(row().image_url, 'new.jpg');
  assert.equal(row().image_url_female, 'f.jpg');
});

test('locked fields are refused and nothing is saved', async () => {
  for (const body of [{ tag: 'WALK' }, { target_value: 5000 }, { task_type: 'WEEKLY' }, { title: 'X', start_date: '2027-01-01' }]) {
    await assert.rejects(updateTask('4', body), /TASK_FIELD_LOCKED/);
  }
  assert.equal(row().title, 'Daily Steps');
});

test('XP stays within the daily cap and must allow partial XP', async () => {
  await assert.rejects(updateTask('4', { xp_reward: 11 }), /XP_REWARD_EXCEEDS_CAP/);
  await assert.rejects(updateTask('4', { xp_reward: 0 }), /INVALID_XP_REWARD/);
  await assert.rejects(updateTask('4', { xp_reward: 1, allows_partial: true }), /XP_REWARD_TOO_LOW_FOR_PARTIAL/);
  await assert.rejects(updateTask('4', { title: '   ' }), /TITLE_REQUIRED/);
});

test('switching on and off still works', async () => {
  await updateTask('4', { is_active: false });
  assert.equal(row().is_active, false);
});
