// src/services/adminRewardService.js — Admin config for scratch-card rewards
//
// Each reward_triggers row (a streak of N days, reaching level N, or the
// birthday trigger) can hold several reward_coupons. When it fires for a
// user, rewardService.js#pickCoupon draws one by weight from
// the coupons that are active, inside their valid_from/valid_until window
// and still in stock. Weights are relative (default 1 everywhere = uniform);
// the list below shows each one's live % chance.
//
// A coupon that has ever been awarded is never hard-deleted — users'
// cards reference it — it's deactivated instead.
//
// Product images are uploaded files only (never pasted links): compressed
// to WebP, at most COUPON_IMAGE_MAX_PX on the longest side, and stored in
// our own Cloudinary folder (imageUploadService.js), one fixed file per
// coupon that a new upload overwrites. The app falls back to
// a default image when a coupon has none or it fails to load.

import prisma from '../config/prisma.js';
import { uploadCompressedImage, deleteImages, ownPublicIdFromUrl } from './imageUploadService.js';

const COUPON_IMAGE_FOLDER = 'hunterx/rewards';
// The app's largest use is the reward details hero, ~400pt wide on 3x screens.
const COUPON_IMAGE_MAX_PX = 1200;

const CODE_RE        = /^[A-Za-z0-9_-]{3,50}$/;
const MAX_WEIGHT     = 100;
const MAX_FLAT_VALUE = 1_000_000;
const MAX_DAYS       = 3650;
const TRIGGER_KINDS  = ['STREAK', 'LEVEL_UP', 'BIRTHDAY', 'TASK'];
const KIND_ORDER     = { STREAK: 0, LEVEL_UP: 1, BIRTHDAY: 2, TASK: 3 };

function invalid(reason) {
  const err = new Error('INVALID_COUPON');
  err.reason = reason;
  return err;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (text.length > max) throw invalid(`${field} must be ${max} characters or fewer`);
  return text;
}

function optionalInt(value, field, min, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${field} must be a whole number from ${min} to ${max}`);
  return n;
}

function optionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw invalid(`${field} must be an ISO date`);
  return d;
}

// Validates the full coupon (create body, or the existing row merged with
// a PATCH body) and returns the columns to write.
function parseCoupon(input, existing = null) {
  const title = optionalText(input.title, 'title', 120);
  if (!title) throw invalid('title is required');

  const code = optionalText(input.coupon_code, 'coupon_code', 50);
  if (!code || !CODE_RE.test(code)) throw invalid('coupon_code must be 3–50 letters, numbers, - or _');

  const discountType = input.discount_type;
  if (discountType !== 'PERCENT' && discountType !== 'FLAT') throw invalid('discount_type must be PERCENT or FLAT');

  const value = Number(input.discount_value);
  if (!Number.isFinite(value) || value <= 0) throw invalid('discount_value must be greater than 0');
  if (discountType === 'PERCENT' && value > 100) throw invalid('A PERCENT discount_value must be 100 or less');
  if (discountType === 'FLAT' && value > MAX_FLAT_VALUE) throw invalid(`A FLAT discount_value must be ${MAX_FLAT_VALUE} or less`);
  if (Math.round(value * 100) !== value * 100) throw invalid('discount_value can have at most 2 decimal places');

  const currency = discountType === 'FLAT' ? optionalText(input.currency, 'currency', 8) : null;
  if (discountType === 'FLAT' && !currency) throw invalid('currency is required for a FLAT discount (e.g. ₹)');

  const weight = optionalInt(input.weight, 'weight', 1, MAX_WEIGHT) ?? 1;

  const totalQuantity = optionalInt(input.total_quantity, 'total_quantity', 1, 10_000_000);
  if (existing && totalQuantity !== null && totalQuantity < existing.awarded_count) {
    throw invalid(`total_quantity can't go below the ${existing.awarded_count} already awarded`);
  }

  const validFrom  = optionalDate(input.valid_from, 'valid_from');
  const validUntil = optionalDate(input.valid_until, 'valid_until');
  if (validFrom && validUntil && validUntil <= validFrom) throw invalid('valid_until must be after valid_from');


  if (input.is_active !== undefined && typeof input.is_active !== 'boolean') throw invalid('is_active must be true or false');

  return {
    title,
    description:            optionalText(input.description, 'description', 500),
    coupon_code:            code.toUpperCase(),
    discount_type:          discountType,
    discount_value:         value,
    currency,
    weight,
    total_quantity:         totalQuantity,
    valid_from:             validFrom,
    valid_until:            validUntil,
    valid_days_after_award: optionalInt(input.valid_days_after_award, 'valid_days_after_award', 1, MAX_DAYS),
    product_name:           optionalText(input.product_name, 'product_name', 120),
    product_category:       optionalText(input.product_category, 'product_category', 120),
    is_active:              input.is_active ?? true,
  };
}

function isEligible(coupon, now) {
  return coupon.is_active
    && (!coupon.valid_from || coupon.valid_from <= now)
    && (!coupon.valid_until || coupon.valid_until > now)
    && (coupon.total_quantity === null || coupon.awarded_count < coupon.total_quantity);
}

function serializeCoupon(c, eligibleWeight, now) {
  const eligible = isEligible(c, now);
  return {
    id:                     String(c.id),
    trigger_id:             String(c.trigger_id),
    title:                  c.title,
    description:            c.description,
    coupon_code:            c.coupon_code,
    discount_type:          c.discount_type,
    discount_value:         Number(c.discount_value),
    currency:               c.currency,
    weight:                 c.weight,
    total_quantity:         c.total_quantity,
    awarded_count:          c.awarded_count,
    remaining:              c.total_quantity === null ? null : c.total_quantity - c.awarded_count,
    valid_from:             c.valid_from,
    valid_until:            c.valid_until,
    valid_days_after_award: c.valid_days_after_award,
    product_name:           c.product_name,
    product_category:       c.product_category,
    product_image_url:      c.product_image_url,
    is_active:              c.is_active,
    // false = can't be drawn right now (inactive, outside its window, or out of stock)
    eligible,
    probability_percent:    eligible && eligibleWeight > 0 ? Math.round((c.weight / eligibleWeight) * 1000) / 10 : 0,
    created_at:             c.created_at,
    updated_at:             c.updated_at,
  };
}

// linkedTasks: for special (TASK) rewards, the tasks it's linked to.
function serializeTrigger(t, coupons, granted, awaiting, now, linkedTasks = undefined) {
  const eligibleWeight = coupons.filter((c) => isEligible(c, now)).reduce((sum, c) => sum + c.weight, 0);
  return {
    id:                   String(t.id),
    kind:                 t.kind,
    value:                t.value,
    description:          t.description,
    is_active:            t.is_active,
    cards_granted:        granted,
    cards_awaiting_stock: awaiting,
    coupons:              coupons.map((c) => serializeCoupon(c, eligibleWeight, now)),
    ...(t.kind === 'TASK'
      ? { tasks: (linkedTasks ?? []).map((task) => ({ id: String(task.id), title: task.title, is_active: task.is_active })) }
      : {}),
  };
}

// The rewards of one kind (streaks or levels by number; at most one
// birthday), with their coupons and how many cards each has granted.
// cards_awaiting_stock counts cards granted while nothing was in stock —
// they pick a prize when scratched, once a coupon is restocked.
// Omitting kind lists every reward.
export async function listTriggers(kind = null) {
  if (kind !== null && !TRIGGER_KINDS.includes(kind)) throw new Error('INVALID_TRIGGER_KIND');
  const now = new Date();
  const ofKind = kind ? { reward_triggers: { kind } } : {};
  const [triggers, granted, awaiting] = await Promise.all([
    prisma.reward_triggers.findMany({
      where:   kind ? { kind } : {},
      include: {
        reward_coupons: { orderBy: { id: 'asc' } },
        tasks:          { select: { id: true, title: true, is_active: true }, orderBy: { id: 'desc' } },
      },
    }),
    prisma.user_rewards.groupBy({ by: ['trigger_id'], where: { trigger_id: { not: null }, ...ofKind }, _count: { _all: true } }),
    prisma.user_rewards.groupBy({
      by: ['trigger_id'],
      where: { trigger_id: { not: null }, coupon_code: null, status: 'ACTIVE', ...ofKind },
      _count: { _all: true },
    }),
  ]);
  const countFor = (rows, id) => rows.find((r) => r.trigger_id === id)?._count._all ?? 0;

  return triggers
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.value - b.value)
    .map((t) => serializeTrigger(t, t.reward_coupons, countFor(granted, t.id), countFor(awaiting, t.id), now, t.tasks));
}

// kind STREAK takes value = streak days, LEVEL_UP value = level number,
// BIRTHDAY none (there's at most one), TASK (special reward) a name in
// `description` — its value is just the next running number.
export async function createTrigger({ kind, value, description } = {}) {
  if (!TRIGGER_KINDS.includes(kind)) throw new Error('INVALID_TRIGGER_KIND');
  // There's only one birthday reward; it can be added back after a delete.
  if (kind === 'BIRTHDAY') {
    const existing = await prisma.reward_triggers.findUnique({ where: { kind_value: { kind, value: 0 } } });
    if (existing) throw new Error('TRIGGER_EXISTS');
    const trigger = await prisma.reward_triggers.create({ data: { kind, value: 0, description: 'Birthday' } });
    return serializeTrigger(trigger, [], 0, 0, new Date());
  }

  if (kind === 'TASK') {
    const name = optionalText(description, 'name', 120);
    if (!name) throw invalid('Give the special reward a name, e.g. "Nike drop"');
    // Retried once if two admins create one at the same moment (unique kind+value).
    for (let attempt = 0; ; attempt++) {
      const { _max } = await prisma.reward_triggers.aggregate({ where: { kind }, _max: { value: true } });
      try {
        const trigger = await prisma.reward_triggers.create({ data: { kind, value: (_max.value ?? 0) + 1, description: name } });
        return serializeTrigger(trigger, [], 0, 0, new Date(), []);
      } catch (err) {
        if (err.code !== 'P2002' || attempt > 0) throw err;
      }
    }
  }

  const n = Number(value);
  const max = kind === 'STREAK' ? MAX_DAYS : 1000;
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(kind === 'STREAK' ? 'INVALID_STREAK_DAYS' : 'INVALID_LEVEL');
  if (kind === 'LEVEL_UP') {
    const level = await prisma.levels.findUnique({ where: { level_number: n } });
    if (!level) throw new Error('INVALID_LEVEL');
  }

  const existing = await prisma.reward_triggers.findUnique({ where: { kind_value: { kind, value: n } } });
  if (existing) throw new Error('TRIGGER_EXISTS');

  const trigger = await prisma.reward_triggers.create({
    data: {
      kind,
      value:       n,
      description: optionalText(description, 'description', 500) ?? (kind === 'STREAK' ? `${n}-day streak` : `Level ${n}`),
    },
  });
  return serializeTrigger(trigger, [], 0, 0, new Date());
}

function parseId(id, notFound) {
  if (!/^\d+$/.test(String(id))) throw new Error(notFound);
  return BigInt(id);
}

// The trigger with this id, only if it's of `kind` (when given) — so the
// per-kind endpoints (/admin/rewards/streaks/:id, ...) can't act on
// another kind's reward.
async function findTrigger(client, triggerId, kind = null) {
  const bTriggerId = parseId(triggerId, 'TRIGGER_NOT_FOUND');
  const trigger = await client.reward_triggers.findUnique({ where: { id: bTriggerId } });
  if (!trigger || (kind && trigger.kind !== kind)) throw new Error('TRIGGER_NOT_FOUND');
  return trigger;
}

async function triggerCoupons(triggerId) {
  return prisma.reward_coupons.findMany({ where: { trigger_id: triggerId } });
}

async function serializeWithSiblings(coupon) {
  const now      = new Date();
  const siblings = await triggerCoupons(coupon.trigger_id);
  const weight   = siblings.filter((c) => isEligible(c, now)).reduce((sum, c) => sum + c.weight, 0);
  return serializeCoupon(coupon, weight, now);
}

// Each coupon has one fixed Cloudinary image, hunterx/rewards/coupon_<id>:
// changing the image overwrites that same file (CDN cache purged; the URL
// gets a new version so the app shows the new one) instead of creating
// another. A coupon whose image was stored under another id of ours keeps
// overwriting that one.
function couponImageId(coupon) {
  return ownPublicIdFromUrl(coupon.product_image_url, COUPON_IMAGE_FOLDER) ?? `${COUPON_IMAGE_FOLDER}/coupon_${coupon.id}`;
}

async function uploadCouponImage(coupon, buffer) {
  const { url } = await uploadCompressedImage(buffer, COUPON_IMAGE_FOLDER, {
    publicId:     couponImageId(coupon),
    maxDimension: COUPON_IMAGE_MAX_PX,
  });
  return prisma.reward_coupons.update({ where: { id: coupon.id }, data: { product_image_url: url } });
}

// image: the uploaded file's buffer, if any. The row is created first so
// the image can be stored under the coupon's id; if the upload fails the
// coupon isn't kept, so the admin can simply retry.
export async function createCoupon(triggerId, body = {}, image = null, kind = null) {
  const bTriggerId = (await findTrigger(prisma, triggerId, kind)).id;

  let coupon = await prisma.reward_coupons.create({
    data: { trigger_id: bTriggerId, ...parseCoupon(body), product_image_url: null },
  });
  if (image) {
    try {
      coupon = await uploadCouponImage(coupon, image);
    } catch (err) {
      await prisma.reward_coupons.delete({ where: { id: coupon.id } });
      throw err;
    }
  }
  return serializeWithSiblings(coupon);
}

// image: a new file's buffer, overwriting the coupon's current image in
// place. body.remove_product_image (true) deletes the image instead.
// Fields are saved first, so a rejected change never touches the image.
export async function updateCoupon(couponId, body = {}, image = null) {
  const bCouponId = parseId(couponId, 'COUPON_NOT_FOUND');
  const existing = await prisma.reward_coupons.findUnique({ where: { id: bCouponId } });
  if (!existing) throw new Error('COUPON_NOT_FOUND');

  const merged = {
    ...existing,
    discount_value: Number(existing.discount_value),
    ...body,
  };
  const data = parseCoupon(merged, existing);
  const removeImage = !image && body.remove_product_image === true && !!existing.product_image_url;
  if (removeImage) data.product_image_url = null;

  // Conditional on awarded_count so a draw landing between the read above
  // and this write can't leave total_quantity below what was awarded.
  const { count } = await prisma.reward_coupons.updateMany({
    where: {
      id: bCouponId,
      ...(data.total_quantity !== null ? { awarded_count: { lte: data.total_quantity } } : {}),
    },
    data,
  });
  if (count === 0) throw invalid('total_quantity is below the number already awarded');

  if (image) await uploadCouponImage(existing, image);
  if (removeImage) {
    const imageId = ownPublicIdFromUrl(existing.product_image_url, COUPON_IMAGE_FOLDER);
    if (imageId) await deleteImages([imageId]);
  }

  return serializeWithSiblings(await prisma.reward_coupons.findUnique({ where: { id: bCouponId } }));
}

// Switches a reward on or off. Off = it grants no new cards; cards users
// already hold, and its coupons' settings, are kept for when it's back on.
export async function setTriggerActive(triggerId, isActive, kind = null) {
  if (typeof isActive !== 'boolean') throw invalid('is_active must be true or false');
  const trigger = await findTrigger(prisma, triggerId, kind);
  await prisma.reward_triggers.update({ where: { id: trigger.id }, data: { is_active: isActive } });
  return (await listTriggers(trigger.kind)).find((t) => t.id === String(trigger.id));
}

// Permanently deletes a reward (streak, level or birthday) that has never
// given anyone a card, together with its coupons and their images. One
// that has can only be switched off, so users keep what they won. The row
// lock makes a card being granted at the same moment wait for the check.
export async function deleteTrigger(triggerId, kind = null) {
  const bTriggerId = parseId(triggerId, 'TRIGGER_NOT_FOUND');

  const imageUrls = await prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw`SELECT id FROM reward_triggers WHERE id = ${bTriggerId} FOR UPDATE`;
    if (!row) throw new Error('TRIGGER_NOT_FOUND');
    await findTrigger(tx, bTriggerId, kind);
    const granted = await tx.user_rewards.count({ where: { trigger_id: bTriggerId } });
    if (granted > 0) throw new Error('TRIGGER_IN_USE');

    const coupons = await tx.reward_coupons.findMany({ where: { trigger_id: bTriggerId }, select: { product_image_url: true } });
    await tx.reward_triggers.delete({ where: { id: bTriggerId } }); // coupons cascade
    return coupons.map((c) => c.product_image_url);
  });

  const imageIds = imageUrls.map((url) => ownPublicIdFromUrl(url, COUPON_IMAGE_FOLDER)).filter(Boolean);
  if (imageIds.length) await deleteImages(imageIds);
  return { deleted: true };
}

// Returns { deleted: true } or, for a coupon users already hold,
// { deleted: false, coupon } with it deactivated.
export async function deleteCoupon(couponId) {
  const bCouponId = parseId(couponId, 'COUPON_NOT_FOUND');
  const existing = await prisma.reward_coupons.findUnique({ where: { id: bCouponId } });
  if (!existing) throw new Error('COUPON_NOT_FOUND');

  const held = await prisma.user_rewards.count({ where: { coupon_id: bCouponId } });
  if (existing.awarded_count === 0 && held === 0) {
    await prisma.reward_coupons.delete({ where: { id: bCouponId } });
    const imageId = ownPublicIdFromUrl(existing.product_image_url, COUPON_IMAGE_FOLDER);
    if (imageId) await deleteImages([imageId]);
    return { deleted: true };
  }

  const coupon = await prisma.reward_coupons.update({ where: { id: bCouponId }, data: { is_active: false } });
  return { deleted: false, coupon: await serializeWithSiblings(coupon) };
}
