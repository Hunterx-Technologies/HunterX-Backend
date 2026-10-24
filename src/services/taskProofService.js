// src/services/taskProofService.js — Admin review of task proof
//
// A proof task (tasks.proof_count > 0) is completed by uploading photos
// (taskService.js#submitTaskProof), which leaves its task_completions row
// IN_REVIEW with no XP. An admin then decides:
//   APPROVE  → COMPLETED: XP, level-ups and the task's special-reward card
//              are paid exactly as a direct completion would
//              (taskService.js#payCompletion).
//   RESUBMIT → the hunter is asked for new photos (with a reason) and can
//              submit again while the task's period is still open.
//   REJECT   → final for that period (with a reason); no XP.
// The hunter gets a TASK_REVIEW push either way. The streak was already
// counted when the proof was submitted, so no decision touches it.

import prisma from '../config/prisma.js';
import { payCompletion } from './taskService.js';
import { syncLeaderboardMember } from './leaderboardService.js';
import { createNotification } from './notificationService.js';

export const REVIEW_STATUSES = ['IN_REVIEW', 'RESUBMIT', 'REJECTED', 'COMPLETED'];
const DECISIONS = { APPROVE: 'COMPLETED', RESUBMIT: 'RESUBMIT', REJECT: 'REJECTED' };
const MAX_NOTE = 300;
const PAGE_SIZE = 50;

function serialize(c) {
  return {
    id:                 String(c.id),
    task_id:            String(c.task_id),
    task_title:         c.tasks.title,
    task_type:          c.tasks.task_type,
    xp_reward:          c.tasks.xp_reward,
    proof_count:        c.tasks.proof_count,
    user_id:            String(c.user_id),
    user_name:          c.users.name,
    hunter_id:          c.users.hunter_id,
    avatar_id:          c.users.avatar_id,
    schedule_date:      c.schedule_date,
    status:             c.status,
    proof_urls:         c.proof_urls,
    proof_submitted_at: c.proof_submitted_at,
    reviewed_at:        c.reviewed_at,
    review_note:        c.review_note,
    xp_earned:          c.xp_earned,
  };
}

const INCLUDE = {
  tasks: { select: { title: true, task_type: true, xp_reward: true, proof_count: true } },
  users: { select: { name: true, hunter_id: true, avatar_id: true } },
};

// status IN_REVIEW (the queue, oldest first) or a decided one — RESUBMIT,
// REJECTED, COMPLETED (approved proofs only) — newest decision first.
// Keyset-paged by id. Returns { items, next_cursor, counts }.
export async function listReviewQueue({ status = 'IN_REVIEW', cursor } = {}) {
  if (!REVIEW_STATUSES.includes(status)) throw new Error('INVALID_REVIEW_STATUS');
  if (cursor !== undefined && cursor !== '' && !/^\d+$/.test(String(cursor))) throw new Error('INVALID_CURSOR');

  const pending = status === 'IN_REVIEW';
  // Approved proofs only — not every COMPLETED task.
  const proofOnly = { proof_submitted_at: { not: null } };
  const where = {
    status,
    ...proofOnly,
    ...(cursor ? { id: pending ? { gt: BigInt(cursor) } : { lt: BigInt(cursor) } } : {}),
  };

  const [rows, ...counts] = await Promise.all([
    prisma.task_completions.findMany({
      where,
      include: INCLUDE,
      orderBy: pending ? { id: 'asc' } : [{ reviewed_at: 'desc' }, { id: 'desc' }],
      take:    PAGE_SIZE + 1,
    }),
    ...REVIEW_STATUSES.map((s) => prisma.task_completions.count({ where: { status: s, ...proofOnly } })),
  ]);

  const page = rows.slice(0, PAGE_SIZE);
  return {
    items:       page.map(serialize),
    next_cursor: rows.length > PAGE_SIZE ? String(page[page.length - 1].id) : null,
    counts:      Object.fromEntries(REVIEW_STATUSES.map((s, i) => [s.toLowerCase(), counts[i]])),
  };
}

// decision: APPROVE | RESUBMIT | REJECT. note: required for RESUBMIT and
// REJECT (shown to the hunter), optional for APPROVE. Only an IN_REVIEW
// submission can be decided; the user's progression lock makes a decision
// and a concurrent resubmission take turns.
export async function reviewProof(adminId, completionId, { decision, note } = {}) {
  if (!/^\d+$/.test(String(completionId))) throw new Error('REVIEW_NOT_FOUND');
  const status = DECISIONS[decision];
  if (!status) throw new Error('INVALID_DECISION');
  const reason = typeof note === 'string' ? note.trim() : '';
  if (reason.length > MAX_NOTE) throw new Error('NOTE_TOO_LONG');
  if (decision !== 'APPROVE' && !reason) throw new Error('NOTE_REQUIRED');

  const bId = BigInt(completionId);
  const found = await prisma.task_completions.findUnique({ where: { id: bId }, select: { user_id: true } });
  if (!found) throw new Error('REVIEW_NOT_FOUND');
  const bUserId = found.user_id;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM user_progression WHERE user_id = ${bUserId} FOR UPDATE`;
    const c = await tx.task_completions.findUnique({ where: { id: bId }, include: { tasks: true } });
    if (c.status !== 'IN_REVIEW') throw new Error('REVIEW_NOT_PENDING');
    const task = c.tasks;

    const saved = await tx.task_completions.update({
      where: { id: bId },
      data: {
        status,
        xp_earned:   status === 'COMPLETED' ? task.xp_reward : 0,
        reviewed_at: new Date(),
        reviewed_by: BigInt(adminId),
        review_note: reason || null,
      },
      include: INCLUDE,
    });

    if (status === 'COMPLETED') {
      await payCompletion(tx, bUserId, task, { status: 'COMPLETED', delta: task.xp_reward - c.xp_earned });
    }

    const [title, body] = {
      COMPLETED: [`✅ Proof approved: ${task.title}`, `+${task.xp_reward} XP earned. Well hunted, Hunter.`],
      RESUBMIT:  [`📸 New proof needed: ${task.title}`, `${reason} Upload new photos to finish this quest.`],
      REJECTED:  [`Proof not accepted: ${task.title}`, reason],
    }[status];
    await createNotification(
      tx, bUserId, 'TASK_REVIEW', title, body,
      { event: 'TASK_REVIEW', decision, task_id: String(task.id), completion_id: String(c.id) }
    );
    return saved;
  });

  // XP changed → leaderboard rank may move. Never fail the decision over it.
  if (status === 'COMPLETED') await syncLeaderboardMember(bUserId);
  return serialize(updated);
}
