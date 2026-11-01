// src/services/accountOtpService.js — One-time codes bound to an existing
// account (account_otps): confirming an email change, and deleting or
// keeping an account from the website. Signup codes, which exist before
// any account does, stay in email_otps (authService.js#sendOtp).
//
// 6 digits, 10 minutes, 5 wrong guesses and the code is dead. Only the
// SHA-256 is stored. A new code for the same account + purpose replaces
// the old one.

import crypto from 'crypto';
import prisma from '../config/prisma.js';
import { generateOtp, sha256 } from '../utils/helpers.js';

export const OTP_PURPOSES = {
  EMAIL_CHANGE:    'EMAIL_CHANGE',
  DELETE_ACCOUNT:  'DELETE_ACCOUNT',
  CANCEL_DELETION: 'CANCEL_DELETION',
};

const OTP_TTL_MS   = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

/** Stores a fresh code for (userId, purpose) sent to `email`; returns the code. */
export async function createAccountOtp(userId, purpose, email) {
  const code = generateOtp();
  await prisma.$transaction([
    prisma.account_otps.deleteMany({ where: { user_id: BigInt(userId), purpose } }),
    prisma.account_otps.create({
      data: {
        user_id:    BigInt(userId),
        purpose,
        email,
        otp_hash:   sha256(code),
        expires_at: new Date(Date.now() + OTP_TTL_MS),
      },
    }),
  ]);
  return code;
}

/**
 * Checks `code` for (userId, purpose) and, when given, that it was sent to
 * `email`. Consumes it on success and returns the row. Throws OTP_INVALID,
 * OTP_EXPIRED or OTP_TOO_MANY_ATTEMPTS.
 */
export async function consumeAccountOtp(userId, purpose, code, { email } = {}) {
  const row = await prisma.account_otps.findFirst({
    where:   { user_id: BigInt(userId), purpose },
    orderBy: { created_at: 'desc' },
  });
  if (!row || (email && row.email !== email)) throw new Error('OTP_INVALID');
  if (row.expires_at <= new Date()) throw new Error('OTP_EXPIRED');
  if (row.attempts >= MAX_ATTEMPTS) throw new Error('OTP_TOO_MANY_ATTEMPTS');

  const given = Buffer.from(sha256(String(code ?? '').trim()));
  const stored = Buffer.from(row.otp_hash);
  if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
    await prisma.account_otps.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } });
    throw new Error(row.attempts + 1 >= MAX_ATTEMPTS ? 'OTP_TOO_MANY_ATTEMPTS' : 'OTP_INVALID');
  }

  await prisma.account_otps.delete({ where: { id: row.id } });
  return row;
}
