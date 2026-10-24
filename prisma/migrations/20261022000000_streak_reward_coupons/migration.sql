-- Randomized coupon rewards for streak-milestone scratch cards.
-- See rewardService.js for how these are picked and revealed.

CREATE TYPE "reward_discount_type" AS ENUM ('PERCENT', 'FLAT');

-- Streak cards for milestones with no legacy STREAK_<n> trigger (21 is
-- covered, 200/365 aren't).
ALTER TYPE "reward_trigger" ADD VALUE 'STREAK_MILESTONE';

-- The coupons an admin configures under one streak milestone.
CREATE TABLE "reward_coupons" (
    "id" BIGSERIAL NOT NULL,
    "milestone_id" BIGINT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "description" VARCHAR(500),
    "coupon_code" VARCHAR(50) NOT NULL,
    "discount_type" "reward_discount_type" NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(8),
    "weight" INTEGER NOT NULL DEFAULT 1,
    "total_quantity" INTEGER,
    "awarded_count" INTEGER NOT NULL DEFAULT 0,
    "valid_from" TIMESTAMP(6),
    "valid_until" TIMESTAMP(6),
    "valid_days_after_award" INTEGER,
    "product_name" VARCHAR(120),
    "product_category" VARCHAR(120),
    "product_image_url" VARCHAR(500),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_coupons_pkey" PRIMARY KEY ("id"),
    -- Stock can never be over-awarded, even by a buggy caller.
    CONSTRAINT "reward_coupons_stock_chk" CHECK ("total_quantity" IS NULL OR "awarded_count" <= "total_quantity"),
    CONSTRAINT "reward_coupons_weight_chk" CHECK ("weight" >= 1),
    CONSTRAINT "reward_coupons_value_chk" CHECK ("discount_value" > 0 AND ("discount_type" <> 'PERCENT' OR "discount_value" <= 100))
);

CREATE INDEX "idx_reward_coupons_milestone" ON "reward_coupons"("milestone_id", "is_active");

ALTER TABLE "reward_coupons" ADD CONSTRAINT "reward_coupons_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "streak_milestones"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- A user's card now carries its own prize snapshot instead of always
-- pointing at a reward_pool code.
ALTER TABLE "user_rewards" ADD COLUMN     "coupon_code" VARCHAR(50),
ADD COLUMN     "coupon_id" BIGINT,
ADD COLUMN     "currency" VARCHAR(8),
ADD COLUMN     "discount_type" "reward_discount_type",
ADD COLUMN     "discount_value" DECIMAL(10,2),
ADD COLUMN     "milestone_id" BIGINT,
ADD COLUMN     "rarity" VARCHAR(16) NOT NULL DEFAULT 'common',
ADD COLUMN     "reward_text" VARCHAR(100),
ADD COLUMN     "scratched_at" TIMESTAMP(6),
ADD COLUMN     "seen_at" TIMESTAMP(6),
ALTER COLUMN "pool_id" DROP NOT NULL;

CREATE INDEX "idx_rewards_coupon" ON "user_rewards"("coupon_id");

-- One card per user per milestone, whatever retries or races happen.
CREATE UNIQUE INDEX "uq_user_rewards_user_milestone" ON "user_rewards"("user_id", "milestone_id") WHERE (milestone_id IS NOT NULL);

ALTER TABLE "user_rewards" ADD CONSTRAINT "user_rewards_milestone_id_fkey" FOREIGN KEY ("milestone_id") REFERENCES "streak_milestones"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "user_rewards" ADD CONSTRAINT "user_rewards_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "reward_coupons"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Legacy pool rewards were announced with their prize in the push, so
-- they read as already seen and scratched, with the pool code copied over.
UPDATE "user_rewards" ur
SET "coupon_code"  = rp."coupon_code",
    "reward_text"  = LEFT(rp."discount_value", 100),
    "expires_at"   = COALESCE(ur."expires_at", rp."expires_at"),
    "seen_at"      = COALESCE(ur."assigned_at", CURRENT_TIMESTAMP),
    "scratched_at" = COALESCE(ur."assigned_at", CURRENT_TIMESTAMP)
FROM "reward_pool" rp
WHERE rp."id" = ur."pool_id";
