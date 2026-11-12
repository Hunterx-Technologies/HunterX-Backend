// scripts/send-deletion-test-pushes.js — Device test for the account
// deletion pushes: sends the real scheduled / reminder / last-day / cancelled copy to a
// user's phone right now. Nothing about the account changes — no deletion is
// scheduled or cancelled; it only writes test notifications (inbox + push).
//
//   npm run push:test:deletion -- <userId|email> [scheduled|reminder|last_day|cancelled|all]
//   npm run push:test:deletion -- shakthikumar.dev@gmail.com
//   npm run push:test:deletion -- 13 reminder
//
// Same path as npm run push:test (pushTestService.js): ignores settings,
// quiet hours and the daily cap, dispatches immediately. Disabled in
// production unless PUSH_TEST_ENABLED=true.
import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import { sendTestPush, isPushTestEnabled } from '../src/services/pushTestService.js';
import {
  DELETION_PUSH, DELETION_GRACE_DAYS, DELETION_REMINDER_DAYS, formatDeletionDate,
} from '../src/services/accountDeletionService.js';

const DAY_MS = 86_400_000;
const KINDS  = ['scheduled', 'reminder', 'last_day', 'cancelled'];

async function main() {
  const [who, kind = 'all'] = process.argv.slice(2);
  if (!who || ![...KINDS, 'all'].includes(kind)) {
    console.error('Usage: npm run push:test:deletion -- <userId|email> [scheduled|reminder|last_day|cancelled|all]');
    process.exit(1);
  }
  if (!isPushTestEnabled()) {
    console.error('Push tests are disabled in production (set PUSH_TEST_ENABLED=true to allow).');
    process.exit(1);
  }

  const user = /^\d+$/.test(who)
    ? await prisma.users.findUnique({ where: { id: BigInt(who) }, select: { id: true, name: true, delete_at: true } })
    : await prisma.users.findFirst({ where: { email: { equals: who, mode: 'insensitive' } }, select: { id: true, name: true, delete_at: true } });
  if (!user) {
    console.error(`User ${who} not found.`);
    process.exit(1);
  }

  // A real date if they're scheduled, else what one would look like today.
  const deleteAt = user.delete_at ?? new Date(Date.now() + DELETION_GRACE_DAYS * DAY_MS);
  const copy = {
    scheduled: DELETION_PUSH.scheduled(formatDeletionDate(deleteAt)),
    reminder:  DELETION_PUSH.reminder(DELETION_REMINDER_DAYS, formatDeletionDate(Date.now() + DELETION_REMINDER_DAYS * DAY_MS)),
    last_day:  DELETION_PUSH.lastDay(),
    cancelled: DELETION_PUSH.cancelled(),
  };

  console.log(`User: ${user.name} (id=${user.id})${user.delete_at ? ' — pending deletion' : ''}`);
  for (const k of kind === 'all' ? KINDS : [kind]) {
    const result = await sendTestPush(user.id, { ...copy[k], url: '/(tabs)/profile' });
    console.log(`\n[${k}] ${copy[k].title}\n  ${copy[k].body}`);
    if (result.devices === 0) console.log('  → No device registered. Sign in on the phone and allow notifications first.');
    else if (result.push_status === 'SENT') console.log('  → Accepted by Expo — check the phone. Tapping it should open Profile.');
    else console.log(`  → Not delivered: ${result.push_error}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
