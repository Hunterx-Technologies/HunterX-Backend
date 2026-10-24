// src/services/xpService.js — Level-up detection off user_progression.total_xp
//
// XP itself is awarded flat (task.xp_reward / task.xp_partial, no streak
// or fitness-level multiplier) by taskService.js#setTaskCompletion. This
// service owns everything that happens AFTER total_xp changes: working
// out which level that new total now qualifies for, walking every level
// crossed in one award (so a big XP jump can't skip a rank-up or dragon
// evolution that happened partway through), and firing a LEVEL_UP
// notification for each level/rank/evolution crossed.
//
// Fully independent of streakService.js — nothing here reads or writes
// any streak field, and streakService.js never imports this file.

import { createNotification } from './notificationService.js';
import { grantTriggerCard } from './rewardService.js';

import prisma from '../config/prisma.js';

// Called from inside the same transaction that just incremented
// user_progression.total_xp — `tx` is a Prisma transaction client,
// `userId` is already a BigInt. `xpEarned` is the award that did it.
// Every level-up is recorded in level_up_events, so the app shows its
// screen once whatever paid the XP (a quest, an approved proof, a
// referral) — straight from a completion response, or on next open.
export async function checkLevelUp(tx, userId, { xpEarned = 0 } = {}) {
  const progression = await tx.user_progression.findUnique({ where: { user_id: userId } });
  if (!progression) return { leveledUp: false, rewards: [], levelUp: null };

  const levels = await tx.levels.findMany({ orderBy: { level_number: 'asc' } });
  const eligible = levels.filter(l => l.xp_required <= progression.total_xp);
  if (eligible.length === 0) return { leveledUp: false, rewards: [], levelUp: null };

  const newLevel = eligible[eligible.length - 1].level_number;
  const oldLevel = progression.current_level;
  if (newLevel <= oldLevel) return { leveledUp: false, rewards: [], levelUp: null };

  await tx.user_progression.update({
    where: { user_id: userId },
    data:  { current_level: newLevel },
  });

  const levelByNumber = new Map(levels.map(l => [l.level_number, l]));
  // Scratch cards for levels an admin set one up for (see rewardService.js)
  // — one per such level crossed, even in a multi-level jump.
  const rewards = [];

  // Walk every level crossed, not just the final one — a multi-level
  // jump in one award must still trigger every rank-up / dragon
  // evolution boundary in between, not just the one at the top.
  for (let lvl = oldLevel + 1; lvl <= newLevel; lvl++) {
    const levelRow = levelByNumber.get(lvl);
    if (!levelRow) continue; // gap in seeded levels — nothing to announce

    await createNotification(
      tx, userId, 'LEVEL_UP',
      `Level ${lvl} reached!`,
      `You've hit Level ${lvl}${levelRow.title ? ` — ${levelRow.title}` : ''}.`,
      { event: 'LEVEL_UP', level: lvl }
    );

    await checkRankUp(tx, userId, levelRow, levelByNumber.get(lvl - 1) ?? null);
    await checkDragonEvolution(tx, userId, lvl);

    const card = await grantTriggerCard(tx, userId, 'LEVEL_UP', lvl);
    if (card) rewards.push(card);
  }

  const event = await tx.level_up_events.create({
    data: { user_id: userId, from_level: oldLevel, to_level: newLevel, xp_earned: xpEarned },
  });
  const levelUp = await buildLevelUp(tx, levelByNumber, {
    fromLevel: oldLevel, toLevel: newLevel, totalXp: progression.total_xp, xpEarned, eventIds: [String(event.id)],
  });
  return { leveledUp: true, oldLevel, newLevel, rewards, levelUp };
}

const formatXp = (n) => n.toLocaleString('en-IN');

// The level-up screen's content (the app shows it as-is, no text of its
// own): the final level reached, even when one award crosses several.
// Rank up = the rank changed between the old and new level, so a jump
// that crosses a rank boundary still shows the new dragon stage.
// event_ids: the level_up_events it covers, for POST .../level-up/seen.
async function buildLevelUp(tx, levelByNumber, { fromLevel, toLevel, totalXp, xpEarned, eventIds }) {
  const row  = levelByNumber.get(toLevel);
  const from = levelByNumber.get(fromLevel);
  const next = levelByNumber.get(toLevel + 1) ?? null;
  const isRankUp = !!row.is_rank_up || (!!from && !!row.rank_name && from.rank_name !== row.rank_name);

  const stage = isRankUp
    ? await tx.dragon_stages.findFirst({
        where:  { level_range_start: { lte: toLevel }, level_range_end: { gte: toLevel } },
        select: { stage_number: true, name: true, unlock_message: true, thumbnail_url: true },
      })
    : null;

  const xpToNext = next ? Math.max(0, next.xp_required - totalXp) : null;
  return {
    from_level:       fromLevel,
    to_level:         toLevel,
    rank_name:        row.rank_name,
    title:            row.title,
    level_up_label:   row.level_up_label,
    level_up_title:   row.level_up_title,
    level_up_message: row.level_up_message,
    is_rank_up:       isRankUp,
    xp_earned:        xpEarned,
    xp_earned_text:   `+${formatXp(xpEarned)} XP`,
    xp_to_next:       xpToNext,
    next_level_title: next?.title ?? null,
    next_level_text:  next ? `${formatXp(xpToNext)} XP to ${next.title}` : 'Max level reached',
    button_label:     'Continue',
    // Only for a rank up, and only once a stage with art is seeded.
    dragon_stage: stage
      ? { stage_number: stage.stage_number, name: stage.name, message: stage.unlock_message, image_url: stage.thumbnail_url }
      : null,
    event_ids:        eventIds,
  };
}

// ── Level-ups the app hasn't shown (GET /api/users/me/level-up) ──
// Several unseen ones (e.g. a proof approved, then a referral) become one
// screen: from the first one's old level to the highest level reached,
// with their XP added up. Null when there's nothing to show.
export async function getPendingLevelUp(userId) {
  const bUserId = BigInt(userId);
  const events = await prisma.level_up_events.findMany({
    where:   { user_id: bUserId, seen_at: null },
    orderBy: { id: 'asc' },
    take:    50,
  });
  if (events.length === 0) return { level_up: null };

  const [levels, progression] = await Promise.all([
    prisma.levels.findMany({ orderBy: { level_number: 'asc' } }),
    prisma.user_progression.findUnique({ where: { user_id: bUserId }, select: { total_xp: true } }),
  ]);
  const levelByNumber = new Map(levels.map((l) => [l.level_number, l]));
  const toLevel = Math.max(...events.map((e) => e.to_level));
  if (!levelByNumber.has(toLevel)) return { level_up: null };

  const levelUp = await buildLevelUp(prisma, levelByNumber, {
    fromLevel: events[0].from_level,
    toLevel,
    totalXp:   progression?.total_xp ?? 0,
    xpEarned:  events.reduce((sum, e) => sum + e.xp_earned, 0),
    eventIds:  events.map((e) => String(e.id)),
  });
  return { level_up: levelUp };
}

export async function markLevelUpsSeen(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || !ids.every((id) => /^\d+$/.test(String(id)))) {
    throw new Error('INVALID_IDS');
  }
  const { count } = await prisma.level_up_events.updateMany({
    where: { user_id: BigInt(userId), id: { in: ids.map((id) => BigInt(id)) }, seen_at: null },
    data:  { seen_at: new Date() },
  });
  return { marked: count };
}

// Rank boundary = wherever levels.rank_name changes between two
// consecutive levels (every 10 levels per prisma/seed.js's RANK_NAMES
// bucketing) — read off the row instead of hard-coded "every 10" so this
// stays correct if that bucketing ever changes.
async function checkRankUp(tx, userId, levelRow, previousLevelRow) {
  if (!levelRow.rank_name) return;
  if (previousLevelRow && previousLevelRow.rank_name === levelRow.rank_name) return;

  await createNotification(
    tx, userId, 'LEVEL_UP',
    `Rank up: ${levelRow.rank_name}!`,
    `You've ranked up to ${levelRow.rank_name}.`,
    { event: 'RANK_UP', level: levelRow.level_number, rank_name: levelRow.rank_name }
  );
}

// Dragon stage boundary = the dragon_stages row whose level_range covers
// this level differs from the stage the user is currently on.
async function checkDragonEvolution(tx, userId, level) {
  const stage = await tx.dragon_stages.findFirst({
    where: { level_range_start: { lte: level }, level_range_end: { gte: level } },
  });
  if (!stage) return; // no seeded stage covers this level yet (placeholder content)

  const user = await tx.users.findUnique({ where: { id: userId }, select: { dragon_stage: true } });
  if (!user || user.dragon_stage === stage.stage_number) return;

  await tx.users.update({ where: { id: userId }, data: { dragon_stage: stage.stage_number } });

  await tx.user_dragon_evolutions.upsert({
    where:  { user_id_stage_number: { user_id: userId, stage_number: stage.stage_number } },
    create: { user_id: userId, stage_number: stage.stage_number, level_at_evolution: level },
    update: {},
  });

  await createNotification(
    tx, userId, 'LEVEL_UP',
    `Dragon evolution: ${stage.name}!`,
    `Your dragon has evolved into ${stage.name}.`,
    { event: 'DRAGON_EVOLUTION', level, stage_number: stage.stage_number, stage_name: stage.name }
  );
}
