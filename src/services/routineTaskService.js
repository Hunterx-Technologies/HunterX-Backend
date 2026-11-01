// src/services/routineTaskService.js — Which routine tasks a hunter does.
//
// Routine tasks are the ones flagged tasks.is_routine: the seed-managed
// built-ins (sleep, water, protein, steps) plus every free recurring daily
// task an admin creates (adminTaskService.js). A hunter selects the ones
// they want during onboarding and can turn them on or off from Home later.
// Other tasks (one-time daily, paid, weekly, monthly) aren't optional and
// never appear here.
//
// user_routine_tasks.selected holds each hunter's on/off choice per
// routine task; a routine task is assigned unless it's false. No row (e.g.
// a routine task added after the hunter last chose) = on, so new routine
// tasks reach everyone and they can turn them off. A hunter keeps at
// least one on.

import prisma from '../config/prisma.js';
import { getISTDateOnly } from '../utils/helpers.js';
import { assignDailyTasks, routineTaskWhere, selectedRoutineIds } from './taskAssignmentService.js';

// Request body value -> unique BigInt ids, or null if it isn't a list of ids.
export function parseRoutineTaskIds(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50) return null;
  const ids = new Set();
  for (const value of raw) {
    const text = String(value).trim();
    if (!/^\d{1,19}$/.test(text)) return null;
    ids.add(BigInt(text));
  }
  return [...ids];
}

function resolveImage(task, gender) {
  return String(gender ?? '').toUpperCase() === 'FEMALE'
    ? (task.image_url_female ?? task.image_url_male ?? task.image_url)
    : (task.image_url_male ?? task.image_url);
}

function toApiRoutineTask(task, gender) {
  return {
    id:               String(task.id),
    title:            task.title,
    description:      task.description,
    tag:              task.tag,
    xp_reward:        task.xp_reward,
    // Both variants, so onboarding (no account yet) can match the gender
    // picked a few screens earlier.
    image_url:        resolveImage(task, gender),
    image_url_male:   task.image_url_male ?? task.image_url,
    image_url_female: task.image_url_female ?? task.image_url_male ?? task.image_url,
  };
}

// Routine tasks live today (see routineTaskWhere).
function findRoutineTasks() {
  return prisma.tasks.findMany({
    where:   routineTaskWhere(getISTDateOnly()),
    orderBy: { id: 'asc' },
    select:  {
      id: true, title: true, description: true, tag: true, xp_reward: true,
      image_url: true, image_url_male: true, image_url_female: true,
    },
  });
}

// GET /api/public/routine-tasks — the onboarding picker's options: routine
// tasks only (built-in + admin-marked routine).
export async function listRoutineTasks(gender = null) {
  const tasks = await findRoutineTasks();
  return tasks.map((t) => toApiRoutineTask(t, gender));
}

// GET /api/tasks/routine — every routine task, with the user's selected flag.
export async function getUserRoutineTasks(userId, gender = null) {
  const bUserId = BigInt(userId);
  const tasks   = await findRoutineTasks();
  const chosen  = new Set(await selectedRoutineIds(bUserId, tasks.map((t) => t.id)));
  return tasks.map((t) => ({ ...toApiRoutineTask(t, gender), selected: chosen.has(t.id) }));
}

// Saves a user's choice: every live routine task gets a row, selected =
// whether it's in taskIds. Unknown or inactive ids are dropped; throws
// NO_ROUTINE_TASKS if nothing valid is left. Rows for routine tasks not
// live today are left as they were. `syncToday` also updates today's list:
// newly selected tasks appear now, deselected ones disappear unless the
// hunter already acted on them today.
export async function setUserRoutineTasks(userId, taskIds, { syncToday = true } = {}) {
  const bUserId  = typeof userId === 'bigint' ? userId : BigInt(userId);
  const today    = getISTDateOnly();
  const activeIds = (await findRoutineTasks()).map((t) => t.id);
  const active   = new Set(activeIds);
  const chosen   = taskIds.filter((id) => active.has(id));
  if (chosen.length === 0) throw new Error('NO_ROUTINE_TASKS');

  const dropped = activeIds.filter((id) => !chosen.includes(id));

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    await tx.user_routine_tasks.createMany({
      data: activeIds.map((task_id) => ({ user_id: bUserId, task_id, selected: false })),
      skipDuplicates: true,
    });
    await tx.user_routine_tasks.updateMany({
      where: { user_id: bUserId, task_id: { in: chosen } },
      data:  { selected: true, updated_at: now },
    });
    if (dropped.length > 0) {
      await tx.user_routine_tasks.updateMany({
        where: { user_id: bUserId, task_id: { in: dropped } },
        data:  { selected: false, updated_at: now },
      });
    }

    if (!syncToday || dropped.length === 0) return;
    // Keep any dropped task already completed, partly done or skipped today
    // so today's progress and streak don't change; it's gone from tomorrow.
    const actedOn = await tx.task_completions.findMany({
      where:  { user_id: bUserId, schedule_date: today, task_id: { in: dropped } },
      select: { task_id: true },
    });
    const keep = new Set(actedOn.map((c) => c.task_id));
    const remove = dropped.filter((id) => !keep.has(id));
    if (remove.length > 0) {
      await tx.task_schedule.deleteMany({
        where: { user_id: bUserId, active_date: today, task_id: { in: remove } },
      });
    }
  });

  if (syncToday) await assignDailyTasks(bUserId, today);
  return chosen;
}

// Onboarding without a routine choice (e.g. an older app build): every
// live routine task on, so the hunter starts with a full routine.
export async function selectAllRoutineTasks(userId, options = {}) {
  const activeIds = (await findRoutineTasks()).map((t) => t.id);
  if (activeIds.length === 0) return [];
  return setUserRoutineTasks(userId, activeIds, options);
}
