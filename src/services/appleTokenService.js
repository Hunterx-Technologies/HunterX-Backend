// src/services/appleTokenService.js — Sign in with Apple token lifecycle.
//
// App Store Guideline 5.1.1(v): an app offering Sign in with Apple must
// revoke the user's Apple tokens when they delete their account. Apple only
// revokes a token we hold, so at sign-in the app sends its one-time
// authorizationCode, we exchange it here for a refresh token and keep it on
// the APPLE auth_providers row; account deletion revokes it.
//
// Needs the Sign in with Apple key (developer.apple.com → Keys):
//   APPLE_CLIENT_ID   — the app's bundle ID (also the id-token audience)
//   APPLE_TEAM_ID     — 10-character Team ID
//   APPLE_KEY_ID      — the key's ID
//   APPLE_PRIVATE_KEY — the .p8 contents (literal "\n" sequences allowed)
// Without them sign-in still works; the exchange and revocation are skipped
// and logged.
//
// Everything here is best effort: an Apple outage must never block a
// sign-in or an account deletion.

import appleSignin from 'apple-signin-auth';
import { info, logError } from '../utils/logger.js';

function appleConfig() {
  const clientID      = process.env.APPLE_CLIENT_ID;
  const teamID        = process.env.APPLE_TEAM_ID;
  const keyIdentifier = process.env.APPLE_KEY_ID;
  const privateKey    = process.env.APPLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!clientID || !teamID || !keyIdentifier || !privateKey) return null;
  return { clientID, teamID, keyIdentifier, privateKey };
}

export function isAppleRevocationConfigured() {
  return appleConfig() !== null;
}

function clientSecret(config) {
  return appleSignin.getClientSecret({
    clientID:      config.clientID,
    teamID:        config.teamID,
    keyIdentifier: config.keyIdentifier,
    privateKey:    config.privateKey,
  });
}

/**
 * Exchanges the app's one-time authorization code for Apple's refresh token.
 * Returns the token, or null when unconfigured or Apple refuses the code.
 */
export async function exchangeAppleAuthorizationCode(authorizationCode) {
  if (!authorizationCode || typeof authorizationCode !== 'string') return null;
  const config = appleConfig();
  if (!config) {
    info('Apple token exchange skipped: APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY not set');
    return null;
  }
  try {
    const res = await appleSignin.getAuthorizationToken(authorizationCode, {
      clientID:     config.clientID,
      clientSecret: clientSecret(config),
    });
    if (!res?.refresh_token) {
      logError(`Apple token exchange returned no refresh token: ${res?.error ?? 'unknown error'}`);
      return null;
    }
    return res.refresh_token;
  } catch (err) {
    logError(`Apple token exchange failed: ${err?.message ?? err}`);
    return null;
  }
}

/** Revokes one Apple refresh token. Resolves true on success, never throws. */
export async function revokeAppleRefreshToken(refreshToken) {
  if (!refreshToken) return false;
  const config = appleConfig();
  if (!config) {
    logError('Apple token revocation skipped: Apple key env vars not set');
    return false;
  }
  try {
    const res = await appleSignin.revokeAuthorizationToken(refreshToken, {
      clientID:      config.clientID,
      clientSecret:  clientSecret(config),
      tokenTypeHint: 'refresh_token',
    });
    // Apple answers 200 with an empty body on success.
    if (res && res.error) {
      logError(`Apple token revocation refused: ${res.error}`);
      return false;
    }
    return true;
  } catch (err) {
    logError(`Apple token revocation failed: ${err?.message ?? err}`);
    return false;
  }
}
