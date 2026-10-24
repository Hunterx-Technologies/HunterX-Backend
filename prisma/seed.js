// prisma/seed.js — Reference data seed for a fresh environment
// (staging, production, a new dev's local setup).
//
// Wired into `npx prisma db seed` via the "prisma.seed" entry in
// package.json, and run automatically on every Railway deploy
// (see railway.json's buildCommand). Every upsert here is keyed on a
// stable natural key, so re-running this on every deploy is a safe
// no-op after the first run — nothing is ever duplicated.
//
// Usage: npx prisma db seed   (or: node prisma/seed.js)
//
// ⚠ PLACEHOLDER CONTENT — dragon_stages / badges / levels /
// streak_milestones below are scaffolded with obviously-fake placeholder
// rows so the seed *mechanism* works end-to-end (and so a fresh DB has
// at least a dragon_stages row for stage_number=1, which users.dragon_stage
// defaults to and has an FK constraint against — registration fails
// without it). Replace PLACEHOLDER_* with the real game-design content
// before running this against staging/production.

import 'dotenv/config';
import prisma from '../src/config/prisma.js';

// ─────────────────────────────────────────────────────────────
// Routine daily tasks — same 3 tasks, every user, every day.
// Matches the content previously seeded by scripts/seed-daily-tasks.js
// (now deleted), with is_default_daily added so the automatic
// task-assignment engine (src/services/taskAssignmentService.js) picks
// these up.
// ─────────────────────────────────────────────────────────────

const DAILY_TASKS = [
  {
    title:            'Sleep 8 Hours',
    description:      'Get 8 hours of quality sleep',
    tag:               'REST',
    task_type:         'DAILY_FIXED',
    xp_reward:         10,
    xp_partial:        5,
    allows_partial:    false,
    target_value:      8,
    target_unit:       'hours',
    level_target:      'ALL',
    is_recurring:      true,
    is_default_daily:  true,
    is_active:         true,
    image_url:         'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861237/hunterx/app-assets/sleep.jpg',
    image_url_male:    'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861237/hunterx/app-assets/sleep.jpg',
    image_url_female:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1788817326/hunterx/app-assets/sleep_female.jpg',
  },
  {
    title:            'Drink Water',
    // One-time: this task used to be titled "Drink 3L Water" with a fixed
    // 3L target. Matching on the old title too (see seedDailyTasks below)
    // means this updates that existing row in place instead of seeding a
    // duplicate hydration task for every already-onboarded user.
    renamedFrom:      'Drink 3L Water',
    description:      'Stay hydrated — hit your personalized daily water target',
    tag:               'HYDRATE',
    task_type:         'DAILY_FIXED',
    xp_reward:         10,
    xp_partial:        5,
    allows_partial:    true,
    target_value:      null, // dynamic — read from users.daily_water_goal per user (35ml/kg bodyweight, see helpers.js#calculateWaterGoal)
    target_unit:       'L',
    level_target:      'ALL',
    is_recurring:      true,
    is_default_daily:  true,
    is_active:         true,
    image_url:         'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861238/hunterx/app-assets/threelitterwater.jpg',
    image_url_male:    'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861238/hunterx/app-assets/threelitterwater.jpg',
    image_url_female:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1788817327/hunterx/app-assets/threelitterwater_female.jpg',
  },
  {
    title:            'Protein Goal',
    description:      'Hit your daily protein target',
    tag:               'NUTRITION',
    task_type:         'DAILY_FIXED',
    xp_reward:         10,
    xp_partial:        5,
    allows_partial:    true,
    target_value:      null, // dynamic — read from users.daily_protein_goal per user
    target_unit:       'g',
    level_target:      'ALL',
    is_recurring:      true,
    is_default_daily:  true,
    is_active:         true,
    image_url:         'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861229/hunterx/app-assets/nutrition.jpg',
    image_url_male:    'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861229/hunterx/app-assets/nutrition.jpg',
    image_url_female:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1788817325/hunterx/app-assets/nutrition_female.jpg',
  },
  {
    title:            'Daily Steps',
    description:      'Hit your personalized daily step count target',
    tag:               'STEPS',
    task_type:         'DAILY_FIXED',
    xp_reward:         10,
    xp_partial:        5,
    allows_partial:    true,
    target_value:      null, // dynamic — read from users.daily_steps_goal per user (BMI + age, see helpers.js#calculateStepsGoal)
    target_unit:       'steps',
    level_target:      'ALL',
    is_recurring:      true,
    is_default_daily:  true,
    is_active:         true,
    image_url:         'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1789321894/hunterx/app-assets/steps.jpg',
    image_url_male:    'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1789321894/hunterx/app-assets/steps.jpg',
    image_url_female:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1789321895/hunterx/app-assets/steps_female.jpg',
  },
];

// tasks.title has no DB-level unique constraint (it's also used by
// arbitrary future admin-created tasks), so this can't be a literal
// Prisma .upsert(). Same idempotent find-then-create/update pattern the
// old script used, upgraded to also update fields on re-run instead of
// just skipping.
async function seedDailyTasks() {
  for (const { renamedFrom, ...task } of DAILY_TASKS) {
    const existing = await prisma.tasks.findFirst({
      where: renamedFrom
        ? { title: { in: [task.title, renamedFrom] } }
        : { title: task.title },
    });

    if (existing) {
      await prisma.tasks.update({ where: { id: existing.id }, data: task });
      console.log(`UPDATED "${task.title}" (id=${existing.id})`);
    } else {
      const created = await prisma.tasks.create({ data: task });
      console.log(`ADDED   "${created.title}" (id=${created.id})`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// ⚠ PLACEHOLDER — replace with real dragon-stage lore/colors/animations
// before seeding staging/production. stage_number=1 MUST exist before
// any user can be created (users.dragon_stage defaults to 1 and has an
// FK constraint against dragon_stages.stage_number).
// ─────────────────────────────────────────────────────────────

const DRAGON_STAGES = [
  {
    stage_number:       1,
    name:               'PLACEHOLDER_Hatchling',
    rank_name:          'PLACEHOLDER_E-Rank',
    lore:               'PLACEHOLDER lore text for stage 1.',
    unlock_message:     'PLACEHOLDER unlock message for stage 1.',
    level_range_start:  1,
    level_range_end:    9,
    primary_color:      '#8A8A8A',
    glow_color:         '#B0B0B0',
  },
];

async function seedDragonStages() {
  for (const stage of DRAGON_STAGES) {
    await prisma.dragon_stages.upsert({
      where:  { stage_number: stage.stage_number },
      create: stage,
      update: stage,
    });
    console.log(`UPSERTED dragon_stages stage_number=${stage.stage_number}`);
  }
}

// ─────────────────────────────────────────────────────────────
// ⚠ PLACEHOLDER — replace with real badge names/images.
// ─────────────────────────────────────────────────────────────

const BADGES = [
  {
    name:        'Ember Vow',
    description: 'Reached a 7-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
  {
    name:        'Iron Resolve',
    description: 'Reached a 14-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
  {
    name:        'Shadow Oath',
    description: 'Reached a 30-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
  {
    name:        'Phantom Discipline',
    description: 'Reached a 60-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
  {
    name:        'Sovereign Will',
    description: 'Reached a 90-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
  {
    name:        'Void Ascendant',
    description: 'Reached a 200-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
  {
    name:        'Eternal Hunter',
    description: 'Reached a 365-day daily streak',
    image_url:   null,
    badge_type:  'STREAK',
  },
];

async function seedBadges() {
  for (const badge of BADGES) {
    await prisma.badges.upsert({
      where:  { name: badge.name },
      create: badge,
      update: badge,
    });
    console.log(`UPSERTED badges name="${badge.name}"`);
  }
}

// ─────────────────────────────────────────────────────────────
// Per-level XP curve — flat 30 XP/day (3 routine tasks x 10 XP each, no
// streak or fitness-level multiplier — see taskService.js). Anchors:
//   Level 1:   0 XP
//   Level 10:  10,950 XP  (~1 year of consistent daily tasks)
//   Level 40:  21,900 XP  (~2 years)
//   Level 100: 32,850 XP  (~3 years)
// Three segments interpolate between anchors with an easing exponent —
// steeper early (fast first levels), flatter late (the long endgame
// grind) — rather than a single curve across all 100 levels.
// ─────────────────────────────────────────────────────────────

const LEVELS = [
  { level_number: 1, xp_required: 0, title: 'Dormant I', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant I.' },
  { level_number: 2, xp_required: 36, title: 'Dormant II', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant II.' },
  { level_number: 3, xp_required: 219, title: 'Dormant III', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant III.' },
  { level_number: 4, xp_required: 629, title: 'Dormant IV', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant IV.' },
  { level_number: 5, xp_required: 1330, title: 'Dormant V', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant V.' },
  { level_number: 6, xp_required: 2375, title: 'Dormant VI', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant VI.' },
  { level_number: 7, xp_required: 3816, title: 'Dormant VII', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant VII.' },
  { level_number: 8, xp_required: 5697, title: 'Dormant VIII', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant VIII.' },
  { level_number: 9, xp_required: 8062, title: 'Dormant IX', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant IX.' },
  { level_number: 10, xp_required: 10950, title: 'Dormant X', rank_name: 'DORMANT', unlock_message: 'You have reached Dormant X.' },
  { level_number: 11, xp_required: 10997, title: 'Hollow I', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow I.' },
  { level_number: 12, xp_required: 11094, title: 'Hollow II', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow II.' },
  { level_number: 13, xp_required: 11225, title: 'Hollow III', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow III.' },
  { level_number: 14, xp_required: 11386, title: 'Hollow IV', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow IV.' },
  { level_number: 15, xp_required: 11573, title: 'Hollow V', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow V.' },
  { level_number: 16, xp_required: 11784, title: 'Hollow VI', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow VI.' },
  { level_number: 17, xp_required: 12017, title: 'Hollow VII', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow VII.' },
  { level_number: 18, xp_required: 12271, title: 'Hollow VIII', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow VIII.' },
  { level_number: 19, xp_required: 12545, title: 'Hollow IX', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow IX.' },
  { level_number: 20, xp_required: 12838, title: 'Hollow X', rank_name: 'HOLLOW', unlock_message: 'You have reached Hollow X.' },
  { level_number: 21, xp_required: 13149, title: 'Phantom I', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom I.' },
  { level_number: 22, xp_required: 13478, title: 'Phantom II', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom II.' },
  { level_number: 23, xp_required: 13823, title: 'Phantom III', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom III.' },
  { level_number: 24, xp_required: 14185, title: 'Phantom IV', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom IV.' },
  { level_number: 25, xp_required: 14562, title: 'Phantom V', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom V.' },
  { level_number: 26, xp_required: 14955, title: 'Phantom VI', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom VI.' },
  { level_number: 27, xp_required: 15363, title: 'Phantom VII', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom VII.' },
  { level_number: 28, xp_required: 15786, title: 'Phantom VIII', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom VIII.' },
  { level_number: 29, xp_required: 16223, title: 'Phantom IX', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom IX.' },
  { level_number: 30, xp_required: 16674, title: 'Phantom X', rank_name: 'PHANTOM', unlock_message: 'You have reached Phantom X.' },
  { level_number: 31, xp_required: 17138, title: 'Predator I', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator I.' },
  { level_number: 32, xp_required: 17616, title: 'Predator II', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator II.' },
  { level_number: 33, xp_required: 18108, title: 'Predator III', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator III.' },
  { level_number: 34, xp_required: 18612, title: 'Predator IV', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator IV.' },
  { level_number: 35, xp_required: 19129, title: 'Predator V', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator V.' },
  { level_number: 36, xp_required: 19659, title: 'Predator VI', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator VI.' },
  { level_number: 37, xp_required: 20201, title: 'Predator VII', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator VII.' },
  { level_number: 38, xp_required: 20756, title: 'Predator VIII', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator VIII.' },
  { level_number: 39, xp_required: 21322, title: 'Predator IX', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator IX.' },
  { level_number: 40, xp_required: 21900, title: 'Predator X', rank_name: 'PREDATOR', unlock_message: 'You have reached Predator X.' },
  { level_number: 41, xp_required: 21924, title: 'Vanguard I', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard I.' },
  { level_number: 42, xp_required: 21967, title: 'Vanguard II', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard II.' },
  { level_number: 43, xp_required: 22022, title: 'Vanguard III', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard III.' },
  { level_number: 44, xp_required: 22088, title: 'Vanguard IV', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard IV.' },
  { level_number: 45, xp_required: 22163, title: 'Vanguard V', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard V.' },
  { level_number: 46, xp_required: 22246, title: 'Vanguard VI', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard VI.' },
  { level_number: 47, xp_required: 22336, title: 'Vanguard VII', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard VII.' },
  { level_number: 48, xp_required: 22433, title: 'Vanguard VIII', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard VIII.' },
  { level_number: 49, xp_required: 22536, title: 'Vanguard IX', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard IX.' },
  { level_number: 50, xp_required: 22645, title: 'Vanguard X', rank_name: 'VANGUARD', unlock_message: 'You have reached Vanguard X.' },
  { level_number: 51, xp_required: 22760, title: 'Shadow I', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow I.' },
  { level_number: 52, xp_required: 22879, title: 'Shadow II', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow II.' },
  { level_number: 53, xp_required: 23004, title: 'Shadow III', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow III.' },
  { level_number: 54, xp_required: 23134, title: 'Shadow IV', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow IV.' },
  { level_number: 55, xp_required: 23269, title: 'Shadow V', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow V.' },
  { level_number: 56, xp_required: 23408, title: 'Shadow VI', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow VI.' },
  { level_number: 57, xp_required: 23551, title: 'Shadow VII', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow VII.' },
  { level_number: 58, xp_required: 23699, title: 'Shadow VIII', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow VIII.' },
  { level_number: 59, xp_required: 23851, title: 'Shadow IX', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow IX.' },
  { level_number: 60, xp_required: 24007, title: 'Shadow X', rank_name: 'SHADOW', unlock_message: 'You have reached Shadow X.' },
  { level_number: 61, xp_required: 24167, title: 'Sovereign I', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign I.' },
  { level_number: 62, xp_required: 24331, title: 'Sovereign II', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign II.' },
  { level_number: 63, xp_required: 24499, title: 'Sovereign III', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign III.' },
  { level_number: 64, xp_required: 24670, title: 'Sovereign IV', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign IV.' },
  { level_number: 65, xp_required: 24845, title: 'Sovereign V', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign V.' },
  { level_number: 66, xp_required: 25024, title: 'Sovereign VI', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign VI.' },
  { level_number: 67, xp_required: 25205, title: 'Sovereign VII', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign VII.' },
  { level_number: 68, xp_required: 25391, title: 'Sovereign VIII', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign VIII.' },
  { level_number: 69, xp_required: 25579, title: 'Sovereign IX', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign IX.' },
  { level_number: 70, xp_required: 25771, title: 'Sovereign X', rank_name: 'SOVEREIGN', unlock_message: 'You have reached Sovereign X.' },
  { level_number: 71, xp_required: 25967, title: 'Monarch I', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch I.' },
  { level_number: 72, xp_required: 26165, title: 'Monarch II', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch II.' },
  { level_number: 73, xp_required: 26366, title: 'Monarch III', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch III.' },
  { level_number: 74, xp_required: 26571, title: 'Monarch IV', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch IV.' },
  { level_number: 75, xp_required: 26779, title: 'Monarch V', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch V.' },
  { level_number: 76, xp_required: 26989, title: 'Monarch VI', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch VI.' },
  { level_number: 77, xp_required: 27203, title: 'Monarch VII', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch VII.' },
  { level_number: 78, xp_required: 27419, title: 'Monarch VIII', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch VIII.' },
  { level_number: 79, xp_required: 27638, title: 'Monarch IX', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch IX.' },
  { level_number: 80, xp_required: 27860, title: 'Monarch X', rank_name: 'MONARCH', unlock_message: 'You have reached Monarch X.' },
  { level_number: 81, xp_required: 28085, title: 'Void Ruler I', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler I.' },
  { level_number: 82, xp_required: 28313, title: 'Void Ruler II', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler II.' },
  { level_number: 83, xp_required: 28543, title: 'Void Ruler III', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler III.' },
  { level_number: 84, xp_required: 28776, title: 'Void Ruler IV', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler IV.' },
  { level_number: 85, xp_required: 29012, title: 'Void Ruler V', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler V.' },
  { level_number: 86, xp_required: 29251, title: 'Void Ruler VI', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler VI.' },
  { level_number: 87, xp_required: 29492, title: 'Void Ruler VII', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler VII.' },
  { level_number: 88, xp_required: 29735, title: 'Void Ruler VIII', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler VIII.' },
  { level_number: 89, xp_required: 29981, title: 'Void Ruler IX', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler IX.' },
  { level_number: 90, xp_required: 30230, title: 'Void Ruler X', rank_name: 'VOID RULER', unlock_message: 'You have reached Void Ruler X.' },
  { level_number: 91, xp_required: 30481, title: 'Apex Core I', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core I.' },
  { level_number: 92, xp_required: 30735, title: 'Apex Core II', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core II.' },
  { level_number: 93, xp_required: 30991, title: 'Apex Core III', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core III.' },
  { level_number: 94, xp_required: 31249, title: 'Apex Core IV', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core IV.' },
  { level_number: 95, xp_required: 31510, title: 'Apex Core V', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core V.' },
  { level_number: 96, xp_required: 31773, title: 'Apex Core VI', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core VI.' },
  { level_number: 97, xp_required: 32039, title: 'Apex Core VII', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core VII.' },
  { level_number: 98, xp_required: 32307, title: 'Apex Core VIII', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core VIII.' },
  { level_number: 99, xp_required: 32577, title: 'Apex Core IX', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core IX.' },
  { level_number: 100, xp_required: 32850, title: 'Apex Core X', rank_name: 'APEX CORE', unlock_message: 'You have reached Apex Core X.' },
];

// Level-up screen text per level (shown as-is by the app), merged into
// LEVELS below. Same values as migration 20261022060000_level_up_texts;
// kept here too so a fresh database (where that migration runs before
// any level exists) still gets them.
const LEVEL_UP_TEXTS = {
  1: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 1', level_up_message: 'Your journey starts here, Hunter.' },
  2: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 2 Achieved', level_up_message: 'Great start. Every Hunter begins here.' },
  3: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 3 Unlocked', level_up_message: 'Your power is stirring. Keep going, Hunter.' },
  4: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 4', level_up_message: 'Small steps, real strength. Stay consistent.' },
  5: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 5 Achieved', level_up_message: 'Halfway through Dormant. Your habit is taking shape.' },
  6: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 6 Unlocked', level_up_message: 'The spark is turning into a flame. Keep it lit.' },
  7: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 7', level_up_message: 'Discipline is becoming second nature.' },
  8: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 8 Achieved', level_up_message: 'You\'re stronger than when you started. Keep climbing.' },
  9: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 9 Unlocked', level_up_message: 'Almost there. Dormant won\'t hold you much longer.' },
  10: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 10', level_up_message: 'One more level and Hollow awaits.' },
  11: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Hollow', level_up_message: 'You\'ve awakened. A new power stirs within you.' },
  12: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 12 Unlocked', level_up_message: 'A new core is forming inside you. Keep feeding it.' },
  13: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 13', level_up_message: 'No more standing still. Every quest fills the void.' },
  14: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 14 Achieved', level_up_message: 'You\'re building real strength. Keep going.' },
  15: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 15 Unlocked', level_up_message: 'Halfway through Hollow. Your habits are holding firm.' },
  16: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 16', level_up_message: 'Others quit here. You didn\'t.' },
  17: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 17 Achieved', level_up_message: 'Your consistency is becoming your weapon.' },
  18: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 18 Unlocked', level_up_message: 'The hollow is filling with power.' },
  19: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 19', level_up_message: 'The next rank is close. Finish what you started.' },
  20: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 20 Achieved', level_up_message: 'One more level and Phantom awaits.' },
  21: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Phantom', level_up_message: 'You move unseen now. Few can follow your pace.' },
  22: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 22', level_up_message: 'Quiet effort, loud results.' },
  23: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 23 Achieved', level_up_message: 'Your progress leaves a trail others can\'t ignore.' },
  24: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 24 Unlocked', level_up_message: 'Fast, focused, relentless. That\'s a Phantom.' },
  25: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 25', level_up_message: 'Halfway through Phantom. You\'re building something lasting.' },
  26: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 26 Achieved', level_up_message: 'Discipline works even when no one\'s watching.' },
  27: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 27 Unlocked', level_up_message: 'You\'re pulling ahead of the pack.' },
  28: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 28', level_up_message: 'Every day you show up, you get harder to catch.' },
  29: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 29 Achieved', level_up_message: 'The next rank is within reach. Keep your pace.' },
  30: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 30 Unlocked', level_up_message: 'One more level and Predator awaits.' },
  31: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Predator', level_up_message: 'The hunt begins. Nothing escapes you now.' },
  32: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 32 Achieved', level_up_message: 'You\'ve found your rhythm. Keep stalking your goals.' },
  33: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 33 Unlocked', level_up_message: 'Your habits are sharper than ever.' },
  34: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 34', level_up_message: 'Goals don\'t escape a Predator.' },
  35: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 35 Achieved', level_up_message: 'Halfway through Predator. You\'re built different.' },
  36: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 36 Unlocked', level_up_message: 'Hunger beats talent when talent doesn\'t show up.' },
  37: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 37', level_up_message: 'Few Hunters make it this far. Keep climbing.' },
  38: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 38 Achieved', level_up_message: 'Your streak is your strongest instinct.' },
  39: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 39 Unlocked', level_up_message: 'The summit of this rank is in sight.' },
  40: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 40', level_up_message: 'One more level and Vanguard awaits.' },
  41: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Vanguard', level_up_message: 'You lead from the front. Others follow your example.' },
  42: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 42 Unlocked', level_up_message: 'People are starting to follow your lead.' },
  43: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 43', level_up_message: 'Leading isn\'t loud. It\'s consistent.' },
  44: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 44 Achieved', level_up_message: 'The front line suits you. Keep advancing.' },
  45: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 45 Unlocked', level_up_message: 'Halfway through Vanguard. Your pace inspires others.' },
  46: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 46', level_up_message: 'You\'ve outlasted most who started with you.' },
  47: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 47 Achieved', level_up_message: 'Every level opens harder ground. You\'re ready.' },
  48: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 48 Unlocked', level_up_message: 'Strength like yours is built, not given.' },
  49: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 49', level_up_message: 'Hold the line. Shadow is almost in reach.' },
  50: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 50 Achieved', level_up_message: 'One more level and Shadow awaits.' },
  51: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Shadow', level_up_message: 'Your power runs deep. Strength grows in the dark.' },
  52: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 52', level_up_message: 'Strength grows quietly in the dark.' },
  53: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 53 Achieved', level_up_message: 'Your discipline has become your second self.' },
  54: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 54 Unlocked', level_up_message: 'You train when others rest. It shows.' },
  55: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 55', level_up_message: 'Halfway through Shadow. Few have walked this path.' },
  56: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 56 Achieved', level_up_message: 'Your habits cast a long shadow.' },
  57: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 57 Unlocked', level_up_message: 'Nothing breaks your rhythm now.' },
  58: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 58', level_up_message: 'Power this steady can\'t be faked.' },
  59: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 59 Achieved', level_up_message: 'The crown of this rank is near.' },
  60: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 60 Unlocked', level_up_message: 'One more level and Sovereign awaits.' },
  61: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Sovereign', level_up_message: 'You rule your routine. Your day answers to you.' },
  62: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 62 Achieved', level_up_message: 'Command your day, command your future.' },
  63: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 63 Unlocked', level_up_message: 'Your word to yourself is law. Keep it.' },
  64: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 64', level_up_message: 'Your realm of habits grows stronger.' },
  65: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 65 Achieved', level_up_message: 'Halfway through Sovereign. You\'ve earned your place.' },
  66: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 66 Unlocked', level_up_message: 'Authority comes from showing up every day.' },
  67: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 67', level_up_message: 'You don\'t chase motivation. You are the standard.' },
  68: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 68 Achieved', level_up_message: 'Your streak is a kingdom built daily.' },
  69: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 69 Unlocked', level_up_message: 'A higher throne is almost within reach.' },
  70: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 70', level_up_message: 'One more level and Monarch awaits.' },
  71: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Monarch', level_up_message: 'Few ever reach this height. You wear it well.' },
  72: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 72 Unlocked', level_up_message: 'Power worn lightly is power well earned.' },
  73: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 73', level_up_message: 'Your reign is built on daily effort.' },
  74: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 74 Achieved', level_up_message: 'Legends are made of days like these.' },
  75: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 75 Unlocked', level_up_message: 'Halfway through Monarch. History is watching.' },
  76: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 76', level_up_message: 'You\'ve become what you set out to be.' },
  77: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 77 Achieved', level_up_message: 'Others quit. Monarchs stay.' },
  78: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 78 Unlocked', level_up_message: 'Greatness is just consistency, repeated.' },
  79: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 79', level_up_message: 'The void calls. You are ready.' },
  80: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 80 Achieved', level_up_message: 'One more level and Void Ruler awaits.' },
  81: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Void Ruler', level_up_message: 'You command the void. Nothing shakes your focus.' },
  82: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 82', level_up_message: 'Where others see nothing, you build strength.' },
  83: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 83 Achieved', level_up_message: 'Your focus bends the day to your will.' },
  84: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 84 Unlocked', level_up_message: 'Very few have ever come this far.' },
  85: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 85', level_up_message: 'Halfway through Void Ruler. The peak is in sight.' },
  86: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 86 Achieved', level_up_message: 'Your discipline has no limit left to find.' },
  87: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 87 Unlocked', level_up_message: 'You are proof that consistency wins.' },
  88: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 88', level_up_message: 'Calm, relentless, unbreakable. That\'s you.' },
  89: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 89 Achieved', level_up_message: 'One breath from the final rank.' },
  90: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 90 Unlocked', level_up_message: 'One more level and Apex Core awaits.' },
  91: { is_rank_up: true, level_up_label: 'RANK UP', level_up_title: 'New Rank: Apex Core', level_up_message: 'The final rank is yours. You stand at the peak.' },
  92: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 92 Achieved', level_up_message: 'You stand where almost no one stands.' },
  93: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 93 Unlocked', level_up_message: 'Peak form is a habit, not a moment.' },
  94: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 94', level_up_message: 'Your power is now your identity.' },
  95: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 95 Achieved', level_up_message: 'Halfway through Apex Core. The summit is near.' },
  96: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 96 Unlocked', level_up_message: 'Every level here is a legend in the making.' },
  97: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 97', level_up_message: 'Three levels from the summit. Don\'t slow down.' },
  98: { is_rank_up: false, level_up_label: 'YOU LEVELED UP', level_up_title: 'Level 98 Achieved', level_up_message: 'Two levels left. Finish what you started.' },
  99: { is_rank_up: false, level_up_label: 'POWER UP', level_up_title: 'Level 99 Unlocked', level_up_message: 'One level left. Make it count.' },
  100: { is_rank_up: false, level_up_label: 'NEW LEVEL', level_up_title: 'You\'re Now Level 100', level_up_message: 'Level 100. You are the Apex. A true legend.' },
};

async function seedLevels() {
  for (const base of LEVELS) {
    const level = { ...base, ...LEVEL_UP_TEXTS[base.level_number] };
    await prisma.levels.upsert({
      where:  { level_number: level.level_number },
      create: level,
      update: level,
    });
  }
  console.log(`UPSERTED levels level_number=1-${LEVELS.length}`);
}

// ─────────────────────────────────────────────────────────────
// ⚠ PLACEHOLDER — reward copy (description). xp_bonus is deliberately 0
// on every row and left unread by rewardService — streak milestones are
// a physical/cosmetic reward track only, fully decoupled from XP (XP
// only ever comes from task completion; see LEVELS above). reward_type
// maps each milestone onto the two grant mechanisms rewardService.js
// knows how to fulfill: COUPON claims a reward_pool code via
// user_rewards, BADGE awards a user_badges row (matched by name against
// BADGES above — see grantBadge in rewardService.js).
// ─────────────────────────────────────────────────────────────

const STREAK_MILESTONES = [
  { streak_days: 7,   reward_type: 'BADGE', xp_bonus: 0, description: 'Ember Vow' },
  { streak_days: 14,  reward_type: 'BADGE', xp_bonus: 0, description: 'Iron Resolve' },
  { streak_days: 30,  reward_type: 'BADGE', xp_bonus: 0, description: 'Shadow Oath' },
  { streak_days: 60,  reward_type: 'BADGE', xp_bonus: 0, description: 'Phantom Discipline' },
  { streak_days: 90,  reward_type: 'BADGE', xp_bonus: 0, description: 'Sovereign Will' },
  { streak_days: 200, reward_type: 'BADGE', xp_bonus: 0, description: 'Void Ascendant' },
  { streak_days: 365, reward_type: 'BADGE', xp_bonus: 0, description: 'Eternal Hunter' },
];

async function seedStreakMilestones() {
  for (const milestone of STREAK_MILESTONES) {
    await prisma.streak_milestones.upsert({
      where:  { streak_days: milestone.streak_days },
      create: milestone,
      update: milestone,
    });
    console.log(`UPSERTED streak_milestones streak_days=${milestone.streak_days}`);
  }
}

// ─────────────────────────────────────────────────────────────
// Finalized Avatars Dataset (10 Avatars)
// ─────────────────────────────────────────────────────────────

const AVATARS = [
  {
    name:       'Ren, the Frost Blade',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1788468328/hunterx/app-assets/arise_avatar_11.jpg',
    gender:     'female',
    is_default: false,
  },
  {
    name:       'Draven, the Ember Knight',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861199/hunterx/app-assets/arise_avatar_8.png',
    gender:     'male',
    is_default: false,
  },
  {
    name:       "Vesa, the Viper's Gaze",
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861198/hunterx/app-assets/arise_avatar_7.png',
    gender:     'female',
    is_default: false,
  },
  {
    name:       'Rook, the Grinning Wolf',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861196/hunterx/app-assets/arise_avatar_6.png',
    gender:     'male',
    is_default: false,
  },
  {
    name:       'Silas, the Hollow Wanderer',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861195/hunterx/app-assets/arise_avatar_5.png',
    gender:     'male',
    is_default: false,
  },
  {
    name:       'Talon, the Scarred Sentinel',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861193/hunterx/app-assets/arise_avatar_4.png',
    gender:     'female',
    is_default: true,
  },
  {
    name:       'Isolde, the Silver Wraith',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861192/hunterx/app-assets/arise_avatar_3.png',
    gender:     'female',
    is_default: false,
  },
  {
    name:       'Corvin, the Quiet Analyst',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861187/hunterx/app-assets/arise_avatar_1.png',
    gender:     'male',
    is_default: false,
  },
  {
    name:       'Zane, the Void Stare',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861190/hunterx/app-assets/arise_avatar_2.png',
    gender:     'male',
    is_default: true,
  },
  {
    name:       'Kael, the Crimson Eye',
    image_url:  'https://res.cloudinary.com/sc8zzixt/image/upload/f_auto,q_auto/v1787861200/hunterx/app-assets/arise_avatar_9.png',
    gender:     'male',
    is_default: false,
  },
];

async function seedAvatars() {
  for (const avatar of AVATARS) {
    await prisma.avatars.upsert({
      where:  { name: avatar.name },
      create: avatar,
      update: avatar,
    });
    console.log(`UPSERTED avatar name="${avatar.name}"`);
  }
}

async function main() {
  await seedDragonStages();  // before tasks/users — FK dependency
  await seedDailyTasks();
  await seedBadges();
  await seedLevels();
  await seedStreakMilestones();
  await seedAvatars();
}


main()
  .catch(err => {
    console.error('prisma/seed.js failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
