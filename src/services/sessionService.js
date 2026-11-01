// src/services/sessionService.js — Refresh-token sessions.
//
// Every refresh token carries a jti backed by a refresh_tokens row, and a
// family id shared by every token rotated from the same sign-in.
//   issueSession   — a sign-in: new family, first token.
//   rotateSession  — POST /auth/refresh: the presented token is revoked and
//                    replaced. Presenting an already-revoked token again
//                    (a stolen copy replayed after the owner refreshed)
//                    revokes the whole family, signing out both copies.
//   revokeSession  — POST /auth/logout: the token's family.
//   revokeAllSessions — password change / reset: every family.
//
// Tokens minted before this existed carry no jti. They are accepted once
// (still checked against users.token_version) and swapped for a tracked
// one, so nobody is signed out by the upgrade.

import crypto from 'crypto';
import prisma from '../config/prisma.js';
import { generateTokens, verifyRefreshToken } from '../utils/helpers.js';

// A token rotated this recently and presented again is treated as the
// client retrying a refresh whose response it lost (spotty network), not
// as theft: refused, but the family is left alone.
const REUSE_GRACE_MS = 30 * 1000;

function refreshTtlMs() {
  const raw = process.env.JWT_REFRESH_EXPIRES || '30d';
  const m = /^(\d+)\s*([smhd])$/.exec(raw);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return Number(m[1]) * unit;
}

const newId = () => crypto.randomBytes(24).toString('hex');

async function mint(user, familyId, client = prisma) {
  const jti = newId();
  await client.refresh_tokens.create({
    data: {
      jti,
      user_id:    user.id,
      family_id:  familyId,
      expires_at: new Date(Date.now() + refreshTtlMs()),
    },
  });
  const tokens = generateTokens(user.id.toString(), user.role, user.gender, user.token_version, { jti, familyId });
  return { ...tokens, jti };
}

/** New sign-in for `user` (needs id, role, gender, token_version). */
export async function issueSession(user) {
  const { accessToken, refreshToken } = await mint(user, newId());
  return { accessToken, refreshToken };
}

/**
 * Exchanges a refresh token for a new pair. Throws USER_NOT_FOUND,
 * ACCOUNT_BANNED, TOKEN_REVOKED, or the jsonwebtoken error for a bad /
 * expired token.
 */
export async function rotateSession(refreshToken) {
  const decoded = verifyRefreshToken(refreshToken);
  const userId = BigInt(decoded.userId);

  const user = await prisma.users.findUnique({ where: { id: userId } });
  if (!user) throw new Error('USER_NOT_FOUND');
  if (user.is_banned) throw new Error('ACCOUNT_BANNED');
  // Issued before the last password change / reset — revoked. Tokens
  // minted before token_version existed carry no `tv` and count as 0.
  if ((decoded.tv ?? 0) !== user.token_version) throw new Error('TOKEN_REVOKED');

  // Legacy token (no jti): accepted once, moved onto a tracked family.
  if (!decoded.jti) {
    const { accessToken, refreshToken: next } = await mint(user, newId());
    return { user, accessToken, refreshToken: next };
  }

  return prisma.$transaction(async (tx) => {
    // Row lock: two refreshes racing with the same token can't both win.
    const rows = await tx.$queryRaw`
      SELECT jti, user_id, family_id, revoked_at FROM refresh_tokens
      WHERE jti = ${decoded.jti} FOR UPDATE`;
    const row = rows[0];
    if (!row || row.user_id !== userId) throw new Error('TOKEN_REVOKED');

    if (row.revoked_at) {
      const sinceRevoked = Date.now() - new Date(row.revoked_at).getTime();
      if (sinceRevoked > REUSE_GRACE_MS) {
        await tx.refresh_tokens.updateMany({
          where: { family_id: row.family_id, revoked_at: null },
          data:  { revoked_at: new Date() },
        });
      }
      throw new Error('TOKEN_REVOKED');
    }

    const next = await mint(user, row.family_id, tx);
    await tx.refresh_tokens.update({
      where: { jti: row.jti },
      data:  { revoked_at: new Date(), replaced_by: next.jti },
    });
    return { user, accessToken: next.accessToken, refreshToken: next.refreshToken };
  });
}

/**
 * Logout: revokes the family of `refreshToken`. Holding the token is what
 * proves the right to end its session, so no access token is needed (it
 * has often expired by the time someone logs out). An invalid or expired
 * token is ignored — logout always succeeds.
 */
export async function revokeSession(refreshToken) {
  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch {
    return;
  }
  if (!decoded?.jti) return;
  const row = await prisma.refresh_tokens.findUnique({ where: { jti: decoded.jti } });
  if (!row || String(row.user_id) !== String(decoded.userId)) return;
  await prisma.refresh_tokens.updateMany({
    where: { family_id: row.family_id, revoked_at: null },
    data:  { revoked_at: new Date() },
  });
}

/** Signs out every device (password change / reset). `client` may be a transaction. */
export function revokeAllSessions(userId, client = prisma) {
  return client.refresh_tokens.updateMany({
    where: { user_id: BigInt(userId), revoked_at: null },
    data:  { revoked_at: new Date() },
  });
}

/** Housekeeping for the hourly cron: rows past their expiry are useless. */
export function deleteExpiredSessions() {
  return prisma.refresh_tokens.deleteMany({ where: { expires_at: { lt: new Date() } } });
}
