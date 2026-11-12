// Admin proof review while the hunter's account waits to be deleted:
// approving (which pays XP) is refused and the proof stays IN_REVIEW.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

delete process.env.REDIS_URL;

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });
mock.module(new URL('../src/services/leaderboardService.js', import.meta.url).href, {
  namedExports: { removeLeaderboardMember: async () => {}, syncLeaderboardMember: async () => {} },
});

const proofs = await import('../src/services/taskProofService.js');

const TASK = { id: 5n, title: 'Protein quest', task_type: 'DAILY_ADMIN', xp_reward: 50, proof_count: 1 };

beforeEach(() => {
  for (const m of Object.values(fake.models)) m.rows.length = 0;
  fake.models.users.rows.push({ id: 1n, role: 'USER', delete_at: new Date(Date.now() + 10 * 86_400_000) });
  fake.models.user_progression.rows.push({ id: 1n, user_id: 1n, total_xp: 100, current_level: 1 });
  fake.models.task_completions.rows.push({ id: 9n, user_id: 1n, task_id: 5n, status: 'IN_REVIEW', xp_earned: 0, tasks: TASK });
});

test('approving a pending-deletion hunter\'s proof is refused and pays nothing', async () => {
  await assert.rejects(proofs.reviewProof(99n, '9', { decision: 'APPROVE' }), /USER_PENDING_DELETION/);
  assert.equal(fake.models.task_completions.rows[0].status, 'IN_REVIEW', 'left for after restore');
  assert.equal(fake.models.user_progression.rows[0].total_xp, 100, 'no XP');
  assert.equal(fake.models.xp_transactions.rows.length, 0);
  assert.equal(fake.models.notifications.rows.length, 0);
});

test('rejecting still goes through (it pays nothing)', async () => {
  fake.models.task_completions.rows[0].users = { name: 'H', hunter_id: 'HX1', avatar_id: null, delete_at: fake.models.users.rows[0].delete_at };
  const item = await proofs.reviewProof(99n, '9', { decision: 'REJECT', note: 'Blurry photo' });
  assert.equal(item.status, 'REJECTED');
  assert.equal(fake.models.user_progression.rows[0].total_xp, 100);
  assert.ok(item.user_deletion_days_left >= 9);
});
