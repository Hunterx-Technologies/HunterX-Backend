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
  DAILY_MOTIVATION:   { setting: 'notify_daily_motivation',    channel: 'reminders', url: '/(tabs)',         capped: true,  quietHours: false }, // sent 06:00 local, before quiet hours end
  TASK_REMINDER:      { setting: 'notify_task_reminders',      channel: 'reminders', url: '/(tabs)',         capped: true,  quietHours: true },
  NEW_QUEST:          { setting: 'notify_task_reminders',      channel: 'reminders', url: '/(tabs)',         capped: false, quietHours: true },
  STREAK_AT_RISK:     { setting: 'notify_streak_preservation', channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  STREAK_MILESTONE:   { setting: 'notify_streak_milestones',   channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true }, // home shows the badge popup
  STREAK_FREEZE_USED: { setting: 'notify_streak_freeze',       channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  STREAK_BROKEN:      { setting: 'notify_streak_freeze',       channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  LEVEL_UP:           { setting: 'notify_level_up',            channel: 'rewards',   url: '/(tabs)',         capped: false, quietHours: true },
  REWARD_READY:       { setting: 'notify_reward_ready',        channel: 'rewards',   url: '/rewards',        capped: false, quietHours: true },
  BROADCAST:          { setting: 'notify_announcements',       channel: 'system',    url: '/(tabs)',         capped: false, quietHours: true },
  FRIEND_JOINED:      { setting: 'notify_social',              channel: 'social',    url: '/(tabs)/leaderboard', capped: false, quietHours: true },
  // Friend requests between existing hunters (friendService.js). Not capped:
  // the sender is waiting on an answer, and requests are rate-limited.
  FRIEND_REQUEST:     { setting: 'notify_social',              channel: 'social',    url: '/invite-friends', capped: false, quietHours: true },
  FRIEND_ACCEPTED:    { setting: 'notify_social',              channel: 'social',    url: '/(tabs)/leaderboard?tab=friends', capped: false, quietHours: true },
  LEADERBOARD_UPDATE: { setting: 'notify_leaderboard',         channel: 'social',    url: '/(tabs)/leaderboard', capped: true,  quietHours: true },
  FEEDBACK_UPDATE:    { setting: null,                         channel: 'system',    url: '/feedback',       capped: false, quietHours: true },
  HEALTH_SYNC:        { setting: 'notify_task_reminders',      channel: 'system',    url: '/(tabs)/metrics', capped: true,  quietHours: true },
  WIN_BACK:           { setting: 'notify_daily_motivation',    channel: 'reminders', url: '/(tabs)',         capped: true,  quietHours: true },
  PURCHASE_CONFIRMED: { setting: null,                         channel: 'system',    url: '/(tabs)',         capped: false, quietHours: false },
  PAID_TASK_EXPIRING: { setting: 'notify_task_reminders',      channel: 'reminders', url: '/(tabs)',         capped: false, quietHours: true },
  QUEST_COMPLETED:    { setting: 'notify_level_up',            channel: 'rewards',   url: '/(tabs)',         capped: false, quietHours: true },
  DAY_COMPLETE:       { setting: 'notify_streak_milestones',   channel: 'streaks',   url: '/(tabs)',         capped: false, quietHours: true },
  ACCOUNT_UPDATE:     { setting: null,                         channel: 'system',    url: '/(tabs)',         capped: false, quietHours: false },
  // Proof review outcome (approved / new proof needed / rejected) — transactional.
  TASK_REVIEW:        { setting: null,                         channel: 'system',    url: '/(tabs)',         capped: false, quietHours: true },
  // Account deletion (accountDeletionService.js) — transactional. Scheduled /
  // cancelled is sent straight away (the hunter just acted); the 3-day
  // reminder comes from the hourly job, so it waits out quiet hours.
  ACCOUNT_DELETION:          { setting: null, channel: 'system', url: '/(tabs)/profile', capped: false, quietHours: false },
  ACCOUNT_DELETION_REMINDER: { setting: null, channel: 'system', url: '/(tabs)/profile', capped: false, quietHours: true },
};

// The only types still pushed while an account waits to be deleted —
// everything else (reminders, streaks, broadcasts…) is held back.
export const PENDING_DELETION_TYPES = new Set(['ACCOUNT_DELETION', 'ACCOUNT_DELETION_REMINDER']);

const FALLBACK = { setting: null, channel: 'system', url: '/(tabs)', capped: false, quietHours: true };

export function getNotificationTypeConfig(type) {
  return NOTIFICATION_TYPES[type] ?? FALLBACK;
}

export const CAPPED_TYPES = Object.keys(NOTIFICATION_TYPES).filter((t) => NOTIFICATION_TYPES[t].capped);
