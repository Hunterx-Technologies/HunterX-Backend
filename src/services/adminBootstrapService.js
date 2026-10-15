// src/services/adminBootstrapService.js — Ensures a default admin account
// exists on every boot, so a fresh deploy always has somewhere to log into
// the admin panel without a manual one-off script run.
//
// Idempotent and safe to call on every startup: only acts when no user
// with DEFAULT_ADMIN_EMAIL exists yet. Never touches an existing user —
// if the email is already taken (by this admin or anyone else), it's a
// no-op, even if that user isn't ADMIN. Promote/rotate manually via
// scripts/create-admin.js if that's ever needed.

import bcrypt from 'bcryptjs';
import prisma from '../config/prisma.js';
import { generateHunterId, generateReferralCode } from '../utils/helpers.js';
import { info } from '../utils/logger.js';

const DEFAULT_ADMIN_EMAIL    = 'support.hunterx@gmail.com';
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const DEFAULT_ADMIN_NAME     = 'Admin';

export async function ensureDefaultAdmin() {
  const existing = await prisma.users.findUnique({ where: { email: DEFAULT_ADMIN_EMAIL } });
  if (existing) {
    info(`Default admin (${DEFAULT_ADMIN_EMAIL}) already exists — skipping`);
    return;
  }

  const salt         = await bcrypt.genSalt(12);
  const passwordHash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, salt);

  const user = await prisma.users.create({
    data: {
      hunter_id:       await generateHunterId(),
      name:            DEFAULT_ADMIN_NAME,
      email:           DEFAULT_ADMIN_EMAIL,
      password_hash:   passwordHash,
      referral_code:   generateReferralCode(),
      role:            'ADMIN',
      onboarding_done: true,
    },
  });

  await prisma.auth_providers.create({
    data: { user_id: user.id, provider: 'EMAIL', provider_id: DEFAULT_ADMIN_EMAIL },
  });

  await prisma.user_progression.create({ data: { user_id: user.id } });

  info(`Created default admin (id: ${user.id}, email: ${DEFAULT_ADMIN_EMAIL})`);
}
