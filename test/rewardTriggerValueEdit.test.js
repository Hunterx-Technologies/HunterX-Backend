// Changing a streak / level-up reward's value (adminRewardService.updateTrigger),
// e.g. to fix a 1-day streak that should have been 21.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma, model } from './support/fakePrisma.js';

delete process.env.REDIS_URL;

const fake = createFakePrisma();
for (const name of ['reward_triggers', 'reward_coupons', 'levels', 'tasks']) fake.models[name] = model([]);

// The fake doesn't know Prisma's compound unique key or groupBy.
const triggers = fake.models.reward_triggers;
const plainFindUnique = triggers.findUnique;
triggers.findUnique = ({ where }) => plainFindUnique({ where: where.kind_value ?? where });
fake.models.user_rewards.groupBy = async () => [];

mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/services/imageUploadService.js', import.meta.url).href, {
  namedExports: { uploadCompressedImage: async () => null, deleteImages: async () => {}, ownPublicIdFromUrl: () => null },
});

const { updateTrigger } = await import('../src/services/adminRewardService.js');

const row = (id) => triggers.rows.find((t) => t.id === id);

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  triggers.rows.push(
    { id: 1n, kind: 'STREAK', value: 1, description: '1-day streak', is_active: true, reward_coupons: [], tasks: [] },
    { id: 2n, kind: 'STREAK', value: 7, description: '7-day streak', is_active: true, reward_coupons: [], tasks: [] },
    { id: 3n, kind: 'LEVEL_UP', value: 5, description: 'Level 5', is_active: true, reward_coupons: [], tasks: [] },
    { id: 4n, kind: 'BIRTHDAY', value: 0, description: 'Birthday', is_active: true, reward_coupons: [], tasks: [] },
  );
  fake.models.levels.rows.push({ id: 1n, level_number: 10 });
});

test('changes a streak reward\'s days and its label', async () => {
  const reward = await updateTrigger('1', { value: 21 }, 'STREAK');
  assert.equal(row(1n).value, 21);
  assert.equal(row(1n).description, '21-day streak');
  assert.equal(reward.value, 21);
});

test('refuses a value another streak reward already uses', async () => {
  await assert.rejects(updateTrigger('1', { value: 7 }, 'STREAK'), /TRIGGER_EXISTS/);
  assert.equal(row(1n).value, 1);
});

test('refuses out-of-range streak days', async () => {
  await assert.rejects(updateTrigger('1', { value: 0 }, 'STREAK'), /INVALID_STREAK_DAYS/);
  await assert.rejects(updateTrigger('1', { value: 2.5 }, 'STREAK'), /INVALID_STREAK_DAYS/);
});

test('a level-up reward can only move to an existing level', async () => {
  await assert.rejects(updateTrigger('3', { value: 99 }, 'LEVEL_UP'), /INVALID_LEVEL/);
  await updateTrigger('3', { value: 10 }, 'LEVEL_UP');
  assert.equal(row(3n).value, 10);
  assert.equal(row(3n).description, 'Level 10');
});

test('the same value is a no-op', async () => {
  const reward = await updateTrigger('2', { value: 7 }, 'STREAK');
  assert.equal(reward.value, 7);
});

test('birthday has no value to change', async () => {
  await assert.rejects(updateTrigger('4', { value: 3 }, 'BIRTHDAY'), (err) => /Only streak and level/.test(err.reason ?? err.message));
});
