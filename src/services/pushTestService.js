// src/services/pushTestService.js — "Send me a test push" for device testing.
//
// Writes a notification for the caller and runs the dispatcher right away,
// so the push lands within seconds instead of on the next cron tick.
// Deliberately skips settings gating, quiet hours and the daily cap — the
// point is to verify the device pipeline at any hour. Disabled in
// production unless PUSH_TEST_ENABLED=true.

import prisma from '../config/prisma.js';
import { NOTIFICATION_TYPES, getNotificationTypeConfig } from '../config/notificationTypes.js';
import { runPushDispatch } from './pushDispatchService.js';

export function isPushTestEnabled() {
  return process.env.NODE_ENV !== 'production' || process.env.PUSH_TEST_ENABLED === 'true';
}

export async function sendTestPush(userId, { type = 'BROADCAST', title, body, url } = {}) {
  if (!NOTIFICATION_TYPES[type]) throw new Error('INVALID_TYPE');
  if (url !== undefined && (typeof url !== 'string' || !url.startsWith('/') || url.length > 100)) {
    throw new Error('INVALID_URL');
  }

  const bUserId = typeof userId === 'bigint' ? userId : BigInt(userId);
  const target  = url ?? getNotificationTypeConfig(type).url;
  const devices = await prisma.user_push_tokens.count({ where: { user_id: bUserId } });

  const notification = await prisma.notifications.create({
    data: {
      user_id:       bUserId,
      type,
      title:         (typeof title === 'string' && title.trim() ? title.trim() : '🔔 Test from the System').slice(0, 65),
      body:          (typeof body === 'string' && body.trim() ? body.trim() : `Push notifications work. Tap to open ${target}.`).slice(0, 240),
      data:          { event: 'TEST', url: target },
      deliver_after: new Date(),
      push_status:   'PENDING',
    },
  });

  await runPushDispatch();

  const after = await prisma.notifications.findUnique({
    where:  { id: notification.id },
    select: { push_status: true, push_error: true },
  });

  return {
    notification_id: String(notification.id),
    type,
    url:             target,
    devices,
    push_status:     after?.push_status ?? null,
    push_error:      after?.push_error ?? null,
  };
}
