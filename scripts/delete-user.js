// scripts/delete-user.js
// Permanently deletes a user and all related records, by email.
// Usage: node scripts/delete-user.js <email>
// Same code path as the app's DELETE /api/users/me (accountDeletionService).

import 'dotenv/config';
import prisma from '../src/config/prisma.js';
import redis, { waitForRedis } from '../src/config/redis.js';
import { deleteUserAccount } from '../src/services/accountDeletionService.js';

const email = process.argv[2];

async function main() {
  if (!email) {
    console.error('Usage: node scripts/delete-user.js <email>');
    process.exitCode = 1;
    return;
  }

  await waitForRedis();

  const user = await prisma.users.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, hunter_id: true, name: true, email: true, role: true },
  });

  if (!user) {
    const { count } = await prisma.email_otps.deleteMany({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    console.log(`No user found with email "${email}". Deleted ${count} OTP record(s).`);
    return;
  }

  console.log(`Deleting user ID=${user.id}, HunterID=${user.hunter_id}, Name=${user.name}, Role=${user.role}...`);
  await deleteUserAccount(user.id, { allowAdmin: true });
  console.log(`Successfully deleted user ${user.email} (ID: ${user.id}) and all associated records.`);
}

main()
  .catch((err) => {
    console.error('Failed to delete user:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis?.disconnect();
  });
