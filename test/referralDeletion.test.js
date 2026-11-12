// Referrals while an account waits to be deleted: its code attributes no
// new signups, and as an invitee it is left out of the inviter's list/count.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createFakePrisma } from './support/fakePrisma.js';

const fake = createFakePrisma();
mock.module(new URL('../src/config/prisma.js', import.meta.url).href, { defaultExport: fake.client });

const referrals = await import('../src/services/referralService.js');

test('a pending-deletion hunter\'s code attributes nobody; a normal code still works', async () => {
  fake.models.users.rows.push(
    { id: 1n, name: 'Leaving', referral_code: 'LEAVE1', is_banned: false, delete_at: new Date(Date.now() + 86_400_000) },
    { id: 2n, name: 'Staying', referral_code: 'STAY22', is_banned: false, delete_at: null },
  );
  assert.equal(await referrals.findActiveReferrer('LEAVE1'), null);
  assert.equal((await referrals.findActiveReferrer('STAY22'))?.id, 2n);
});

test('invite count and list only include invitees not pending deletion', async () => {
  const seen = [];
  const spy = { referrals: { count: async (args) => { seen.push(args.where); return 0; } } };
  await referrals.countAcceptedInvites(1n, spy);
  assert.deepEqual(seen[0], { referrer_id: 1n, users_referrals_referred_idTousers: { delete_at: null } });
});
