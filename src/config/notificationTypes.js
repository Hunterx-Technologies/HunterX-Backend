// src/config/notificationTypes.js — Per-type push behaviour, single source
// of truth for settings gating, Android channel, deep link and guardrails.
//
//   setting    — user_settings column that must be true (plus notify_all);
//                null = transactional, always sent
//   channel    — Android notification channel id (created by the mobile app)
//   url        — expo-router path the app opens on tap (overridable per
//                notification via data.url)
//   capped     — counts toward / is blocked by the daily push cap
//   quietHours — delivery is deferred past local quiet hours

export const QUIET_HOURS_START = 22; // 22:00 local
export const QUIET_HOURS_END   = 7;  // 07:00 local
export const DAILY_PUSH_CAP    = 3;  // capped types, rolling 24h

export const NOTIFICATION_TYPES = {
  DAILY_MOTIVATION:   { setting: 'notify_daily_motivation',    channel: 'reminders', url: '/(tabs)',         capped: true,  quietHours: true },
  TASK_REMINDER:      { setting: 'notify_task_reminders',      channel: 'reminders', url: '/(tabs)',         capped: true,  quietHours: true },
  NEW_QUEST:          { setting: 'notify_task_reminders',      channel: 'reminders', url: '/(tabs)',         capped: false, quietHours: true },
  STREAK_AT_RISK:     { setting: 'notify_streak_preservation', channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  STREAK_MILESTONE:   { setting: 'notify_streak_milestones',   channel: 'streaks',   url: '/(tabs)/profile', capped: false, quietHours: true },
  STREAK_FREEZE_USED: { setting: 'notify_streak_freeze',       channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  STREAK_BROKEN:      { setting: 'notify_streak_freeze',       channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  MONTHLY_FREEZE:     { setting: 'notify_streak_freeze',       channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  LEVEL_UP:           { setting: 'notify_level_up',            channel: 'rewards',   url: '/(tabs)',         capped: false, quietHours: true },
  REWARD_READY:       { setting: 'notify_reward_ready',        channel: 'rewards',   url: '/rewards',        capped: false, quietHours: true },
  BROADCAST:          { setting: 'notify_announcements',       channel: 'system',    url: '/(tabs)',         capped: false, quietHours: true },
  FRIEND_JOINED:      { setting: 'notify_social',              channel: 'social',    url: '/(tabs)/leaderboard', capped: false, quietHours: true },
  LEADERBOARD_UPDATE: { setting: 'notify_leaderboard',         channel: 'social',    url: '/(tabs)/leaderboard', capped: true,  quietHours: true },
  FEEDBACK_UPDATE:    { setting: null,                         channel: 'system',    url: '/feedback',       capped: false, quietHours: true },
  HEALTH_SYNC:        { setting: 'notify_task_reminders',      channel: 'system',    url: '/(tabs)/metrics', capped: true,  quietHours: true },
  WIN_BACK:           { setting: 'notify_daily_motivation',    channel: 'reminders', url: '/(tabs)',         capped: true,  quietHours: true },
};

const FALLBACK = { setting: null, channel: 'system', url: '/(tabs)', capped: false, quietHours: true };

export function getNotificationTypeConfig(type) {
  return NOTIFICATION_TYPES[type] ?? FALLBACK;
}

export const CAPPED_TYPES = Object.keys(NOTIFICATION_TYPES).filter((t) => NOTIFICATION_TYPES[t].capped);
