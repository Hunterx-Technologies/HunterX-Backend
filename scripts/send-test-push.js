// scripts/send-test-push.js — Send a test push to a user's registered devices.
//
//   npm run push:test -- <userId|email> [TYPE] [/route]
//   npm run push:test -- shakthikumar.dev@gmail.com
//   npm run push:test -- 13 REWARD_READY /rewards
//
// Same path as POST /api/notifications/test (pushTestService.js): ignores
// settings, quiet hours and the daily cap, and dispatches immediately.
import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import { sendTestPush } from '../src/services/pushTestService.js';

async function main() {
  const [who, type = 'BROADCAST', url] = process.argv.slice(2);
  if (!who) {
    console.error('Usage: npm run push:test -- <userId|email> [TYPE] [/route]');
    process.exit(1);
  }

  const user = /^\d+$/.test(who)
    ? await prisma.users.findUnique({ where: { id: BigInt(who) }, select: { id: true, name: true } })
    : await prisma.users.findUnique({ where: { email: who }, select: { id: true, name: true } });
  if (!user) {
    console.error(`User ${who} not found.`);
    process.exit(1);
  }

  const result = await sendTestPush(user.id, { type, url });
  console.log(`User: ${user.name} (id=${user.id})`);
  console.log(result);
  if (result.devices === 0) {
    console.log('→ No device registered. Open the app on the phone, sign in and allow notifications first.');
  } else if (result.push_status === 'SENT') {
    console.log('→ Accepted by Expo. It should appear on the phone within seconds.');
  } else {
    console.log(`→ Not delivered: ${result.push_error}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
