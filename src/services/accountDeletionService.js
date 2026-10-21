// src/services/accountDeletionService.js — Permanent account deletion.
//
// Backs DELETE /api/users/me (App Store Guideline 5.1.1(v): an app that
// lets users create an account must let them delete it in-app) and
// scripts/delete-user.js. Most user-owned tables cascade from users; the
// relations declared onDelete: NoAction are cleared or unlinked by hand
// first, inside the same transaction, so the final DELETE can't fail on a
// foreign key. The leaderboard's Redis copy is dropped after commit.

import prisma from '../config/prisma.js';
import { removeLeaderboardMember } from './leaderboardService.js';
import { info } from '../utils/logger.js';

export async function deleteUserAccount(userId, { allowAdmin = false } = {}) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);

  const user = await prisma.users.findUnique({
    where:  { id: bUserId },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.role === 'ADMIN' && !allowAdmin) throw new Error('CANNOT_DELETE_ADMIN');

  await prisma.$transaction(async (tx) => {
    // NoAction relations pointing at this user.
    await tx.users.updateMany({ where: { referred_by: bUserId }, data: { referred_by: null } });
    await tx.tasks.updateMany({ where: { created_by: bUserId }, data: { created_by: null } });
    await tx.discovery_matches.updateMany({ where: { unmatched_by: bUserId }, data: { unmatched_by: null } });
    await tx.messages.deleteMany({ where: { sender_id: bUserId } });
    await tx.referrals.deleteMany({ where: { OR: [{ referrer_id: bUserId }, { referred_id: bUserId }] } });

    if (user.email) {
      await tx.email_otps.deleteMany({ where: { email: { equals: user.email, mode: 'insensitive' } } });
    }

    // Everything else (progression, completions, schedule, XP history,
    // notifications, push tokens, settings, feedback, ratings, purchases,
    // health data, ...) cascades from the users row.
    await tx.users.delete({ where: { id: bUserId } });
  });

  await removeLeaderboardMember(bUserId);
  info(`Deleted account ${bUserId}`);
}
