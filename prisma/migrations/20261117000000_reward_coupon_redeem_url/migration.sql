-- Optional partner website for a reward coupon: the app's "Redeem now"
-- copies the code, marks the card used and opens this link.
ALTER TABLE "reward_coupons" ADD COLUMN "redeem_url" VARCHAR(500);
