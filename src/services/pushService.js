// src/services/pushService.js — Device token registry + Expo Push API transport.
//
// The mobile app is Expo, so devices register an Expo push token
// (ExponentPushToken[...]) and we send through Expo's push service, which
// fans out to APNs / FCM using the credentials uploaded to EAS. Optional
// EXPO_ACCESS_TOKEN enables Expo's "enhanced push security".

import prisma from '../config/prisma.js';
import { updateUserSettings } from './userSettingsService.js';
import { isValidTimeZone } from '../utils/timezone.js';
import { logError } from '../utils/logger.js';

const EXPO_SEND_URL     = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const SEND_CHUNK_SIZE    = 100;  // Expo limit per request
const RECEIPT_CHUNK_SIZE = 1000; // Expo limit per request
const REQUEST_TIMEOUT_MS = 15000;

const PLATFORMS = ['IOS', 'ANDROID'];

export function isExpoPushToken(token) {
  return typeof token === 'string'
    && token.length <= 500
    && /^Expo(nent)?PushToken\[.+\]$/.test(token);
}

// ── Device registry ────────────────────────────────────────

export async function registerDevice(userId, { token, platform, appVersion, timezone }) {
  if (!isExpoPushToken(token)) throw new Error('INVALID_PUSH_TOKEN');
  const normalizedPlatform = typeof platform === 'string' ? platform.toUpperCase() : null;
  if (!PLATFORMS.includes(normalizedPlatform)) throw new Error('INVALID_PLATFORM');

  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const now = new Date();
  const app_version = typeof appVersion === 'string' ? appVersion.slice(0, 30) : null;

  // Upsert on token: a device that logged out of A and into B is re-pointed to B.
  await prisma.user_push_tokens.upsert({
    where:  { token },
    create: { user_id: bUserId, token, platform: normalizedPlatform, app_version, created_at: now, last_seen_at: now },
    update: { user_id: bUserId, platform: normalizedPlatform, app_version, last_seen_at: now },
  });

  // Device timezone is the best signal we have — keep it current (travel, DST zone changes).
  if (isValidTimeZone(timezone)) {
    await updateUserSettings(bUserId, { timezone });
  }
}

export async function unregisterDevice(userId, token) {
  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  await prisma.user_push_tokens.deleteMany({ where: { user_id: bUserId, token } });
}

export async function removeTokens(tokens) {
  if (tokens.length === 0) return;
  await prisma.user_push_tokens.deleteMany({ where: { token: { in: tokens } } });
}

export async function getTokensForUsers(userIds) {
  if (userIds.length === 0) return [];
  return prisma.user_push_tokens.findMany({
    where:  { user_id: { in: userIds } },
    select: { user_id: true, token: true },
  });
}

// ── Expo transport ─────────────────────────────────────────

async function postToExpo(url, payload) {
  const headers = {
    'Accept':       'application/json',
    'Content-Type': 'application/json',
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }

  const res  = await fetch(url, {
    method: 'POST',
    headers,
    body:   JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const detail = JSON.stringify(json?.errors ?? json ?? null).slice(0, 300);
    throw new Error(`Expo push HTTP ${res.status}: ${detail}`);
  }
  return json;
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Sends Expo messages; returns one ticket per message, same order. A chunk
// whose request failed outright yields { status: 'error', retryable: true }
// tickets so the caller can requeue just those messages.
export async function sendPushMessages(messages) {
  const tickets = [];
  for (const batch of chunk(messages, SEND_CHUNK_SIZE)) {
    try {
      const { data } = await postToExpo(EXPO_SEND_URL, batch);
      tickets.push(...data);
    } catch (err) {
      logError(`Expo push send failed for ${batch.length} message(s): ${err.message}`);
      tickets.push(...batch.map(() => ({ status: 'error', message: err.message, retryable: true })));
    }
  }
  return tickets;
}

// Returns { [ticketId]: receipt } for the ids Expo knows about.
export async function getPushReceipts(ticketIds) {
  const receipts = {};
  for (const ids of chunk(ticketIds, RECEIPT_CHUNK_SIZE)) {
    const { data } = await postToExpo(EXPO_RECEIPTS_URL, { ids });
    Object.assign(receipts, data);
  }
  return receipts;
}
