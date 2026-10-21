// One-off: promote an existing user to ADMIN without touching their password.
// Usage: node scripts/_promote-to-admin.js <email>
import 'dotenv/config';
import prisma from '../src/config/prisma.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/_promote-to-admin.js <email>');
  process.exit(1);
}

async function main() {
  const user = await prisma.users.findUnique({ where: { email } });
  if (!user) {
    console.error(`No user found with email ${email}`);
    process.exit(1);
  }

  console.log(`Found user id=${user.id} role=${user.role} has_password=${!!user.password_hash}`);

  if (user.role === 'ADMIN') {
    console.log('Already ADMIN — nothing to do.');
    return;
  }

  const updated = await prisma.users.update({
    where: { id: user.id },
    data: { role: 'ADMIN' },
  });

  console.log(`Promoted to ADMIN — id: ${updated.id}, hunter_id: ${updated.hunter_id}, email: ${updated.email}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
