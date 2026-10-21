// src/services/adminBootstrapService.js — Ensures a default admin account
// exists on boot, so a fresh deploy always has somewhere to log into the
// admin panel without a manual one-off script run.
//
// Credentials come ONLY from the environment (DEFAULT_ADMIN_EMAIL +
// DEFAULT_ADMIN_PASSWORD, set per environment in Railway) — never from
// code, since anything committed here is a working admin login for anyone
// who has seen the repo. Without both set, or with a password that fails
// the signup strength rules, bootstrap is skipped.
//
// Idempotent and safe to call on every startup: only acts when no user
// with DEFAULT_ADMIN_EMAIL exists yet. Never touches an existing user —
// if the email is already taken (by this admin or anyone else), it's a
// no-op, even if that user isn't ADMIN. Promote/rotate manually via
// scripts/create-admin.js if that's ever needed.

import bcrypt from 'bcryptjs';
import prisma from '../config/prisma.js';
import { generateHunterId, generateReferralCode, isStrongPassword, isValidEmail, normalizeEmail } from '../utils/helpers.js';
import { info, logError } from '../utils/logger.js';

const DEFAULT_ADMIN_NAME = 'Admin';

// The password this service used to hardcode. Any admin still using it is
// an open door — flagged loudly on every boot until it's rotated.
const LEAKED_PASSWORDS = ['admin123'];

async function warnOnLeakedAdminPasswords() {
  const admins = await prisma.users.findMany({
    where:  { role: 'ADMIN', password_hash: { not: null } },
    select: { id: true, email: true, password_hash: true },
  });
  for (const admin of admins) {
    for (const leaked of LEAKED_PASSWORDS) {
      if (await bcrypt.compare(leaked, admin.password_hash)) {
        logError(
          `SECURITY: admin ${admin.email} (id ${admin.id}) still uses a known default password. ` +
          `Rotate it now: node scripts/create-admin.js ${admin.email} '<strong password>'`
        );
      }
    }
  }
}

export async function ensureDefaultAdmin() {
  await warnOnLeakedAdminPasswords().catch((err) =>
    logError(`Admin password audit failed: ${err.message}`)
  );

  const email    = normalizeEmail(process.env.DEFAULT_ADMIN_EMAIL);
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!email || !password) {
    info('DEFAULT_ADMIN_EMAIL / DEFAULT_ADMIN_PASSWORD not set — skipping default admin bootstrap');
    return;
  }
  if (!isValidEmail(email)) {
    logError('DEFAULT_ADMIN_EMAIL is not a valid email — skipping default admin bootstrap');
    return;
  }
  if (!isStrongPassword(password).valid || password.length < 12) {
    logError('DEFAULT_ADMIN_PASSWORD is too weak (12+ chars, upper, number, special) — skipping default admin bootstrap');
    return;
  }

  const existing = await prisma.users.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
  if (existing) {
    info(`Default admin (${email}) already exists — skipping`);
    return;
  }

  const salt         = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(password, salt);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.users.create({
      data: {
        hunter_id:       await generateHunterId(tx),
        name:            DEFAULT_ADMIN_NAME,
        email,
        password_hash:   passwordHash,
        referral_code:   generateReferralCode(),
        role:            'ADMIN',
        onboarding_done: true,
      },
    });
    await tx.auth_providers.create({
      data: { user_id: created.id, provider: 'EMAIL', provider_id: email },
    });
    await tx.user_progression.create({ data: { user_id: created.id } });
    return created;
  });

  info(`Created default admin (id: ${user.id}, email: ${email})`);
}
