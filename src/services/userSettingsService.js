// src/services/userSettingsService.js — User Settings management & notification gating

import prisma from "../config/prisma.js";
import { syncLeaderboardMember } from "./leaderboardService.js";
import { getNotificationTypeConfig } from "../config/notificationTypes.js";
import { isValidTimeZone, isValidTimeOfDay, DEFAULT_TIMEZONE } from "../utils/timezone.js";

function formatSettings(settings) {
  if (!settings) return null;
  return {
    id: String(settings.id),
    user_id: String(settings.user_id),
    units: settings.units || "metric",
    notify_all: settings.notify_all ?? true,
    notify_daily_motivation: settings.notify_daily_motivation ?? true,
    notify_task_reminders: settings.notify_task_reminders ?? true,
    notify_streak_preservation: settings.notify_streak_preservation ?? true,
    notify_streak_milestones: settings.notify_streak_milestones ?? true,
    notify_streak_freeze: settings.notify_streak_freeze ?? true,
    notify_level_up: settings.notify_level_up ?? true,
    notify_reward_ready: settings.notify_reward_ready ?? true,
    notify_announcements: settings.notify_announcements ?? true,
    notify_social: settings.notify_social ?? true,
    notify_leaderboard: settings.notify_leaderboard ?? true,
    leaderboard_visible: settings.leaderboard_visible ?? true,
    timezone: settings.timezone || DEFAULT_TIMEZONE,
    reminder_time: settings.reminder_time || "19:00",
    created_at: settings.created_at,
    updated_at: settings.updated_at,
  };
}

export async function getUserSettings(userId) {
  const bUserId = typeof userId === "bigint" ? userId : BigInt(userId);

  let settings = await prisma.user_settings.findUnique({
    where: { user_id: bUserId },
  });

  if (!settings) {
    settings = await prisma.user_settings.create({
      data: {
        user_id: bUserId,
        units: "metric",
        notify_all: true,
        notify_daily_motivation: true,
        notify_task_reminders: true,
        notify_streak_preservation: true,
        notify_streak_milestones: true,
        notify_streak_freeze: true,
        notify_level_up: true,
        notify_reward_ready: true,
        notify_announcements: true,
      },
    });
  }

  return formatSettings(settings);
}

export async function updateUserSettings(userId, payload) {
  const bUserId = typeof userId === "bigint" ? userId : BigInt(userId);

  const updateData = { updated_at: new Date() };

  if (payload.units !== undefined) {
    if (!["metric", "imperial"].includes(payload.units)) {
      throw new Error("INVALID_UNITS");
    }
    updateData.units = payload.units;
  }

  if (payload.timezone !== undefined) {
    if (!isValidTimeZone(payload.timezone)) {
      throw new Error("INVALID_TIMEZONE");
    }
    updateData.timezone = payload.timezone;
  }

  if (payload.reminder_time !== undefined) {
    if (!isValidTimeOfDay(payload.reminder_time)) {
      throw new Error("INVALID_REMINDER_TIME");
    }
    updateData.reminder_time = payload.reminder_time;
  }

  // Accept both the camelCase wire name (leaderboardVisible) and the
  // snake_case column name, same convention as the rest of this payload.
  if (payload.leaderboardVisible !== undefined) {
    updateData.leaderboard_visible = Boolean(payload.leaderboardVisible);
  } else if (payload.leaderboard_visible !== undefined) {
    updateData.leaderboard_visible = Boolean(payload.leaderboard_visible);
  }

  const boolFields = [
    "notify_all",
    "notify_daily_motivation",
    "notify_task_reminders",
    "notify_streak_preservation",
    "notify_streak_milestones",
    "notify_streak_freeze",
    "notify_level_up",
    "notify_reward_ready",
    "notify_announcements",
    "notify_social",
    "notify_leaderboard",
  ];

  for (const field of boolFields) {
    if (payload[field] !== undefined) {
      updateData[field] = Boolean(payload[field]);
    }
  }

  const settings = await prisma.user_settings.upsert({
    where: { user_id: bUserId },
    create: {
      user_id: bUserId,
      units: payload.units || "metric",
      notify_all: payload.notify_all !== undefined ? Boolean(payload.notify_all) : true,
      notify_daily_motivation: payload.notify_daily_motivation !== undefined ? Boolean(payload.notify_daily_motivation) : true,
      notify_task_reminders: payload.notify_task_reminders !== undefined ? Boolean(payload.notify_task_reminders) : true,
      notify_streak_preservation: payload.notify_streak_preservation !== undefined ? Boolean(payload.notify_streak_preservation) : true,
      notify_streak_milestones: payload.notify_streak_milestones !== undefined ? Boolean(payload.notify_streak_milestones) : true,
      notify_streak_freeze: payload.notify_streak_freeze !== undefined ? Boolean(payload.notify_streak_freeze) : true,
      notify_level_up: payload.notify_level_up !== undefined ? Boolean(payload.notify_level_up) : true,
      notify_reward_ready: payload.notify_reward_ready !== undefined ? Boolean(payload.notify_reward_ready) : true,
      notify_announcements: payload.notify_announcements !== undefined ? Boolean(payload.notify_announcements) : true,
      ...updateData,
    },
    update: updateData,
  });

  if (updateData.leaderboard_visible !== undefined) {
    await syncLeaderboardMember(bUserId);
  }

  return formatSettings(settings);
}

// Type → notify_* column lives in config/notificationTypes.js. Types with no
// setting are transactional and ignore notify_all.
export function isNotificationEnabled(settings, notificationType) {
  const { setting } = getNotificationTypeConfig(notificationType);
  if (!setting) return true;
  return Boolean(settings.notify_all) && settings[setting] !== false;
}

export async function shouldSendNotification(userId, notificationType) {
  try {
    const settings = await getUserSettings(userId);
    return isNotificationEnabled(settings, notificationType);
  } catch (err) {
    return true;
  }
}
