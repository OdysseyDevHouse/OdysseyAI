-- Loyalty becomes one programme for the whole group.
--
-- ── WHAT 199 LEFT HALF-DONE ──────────────────────────────────────────────
--
-- 199 moved the loyalty BALANCES to the group primary — points, wallet,
-- stamps, vouchers — and left the programme CONFIGURATION in each branch:
--
--   loyalty_tiers       the tier ladder
--   loyalty_cards       punch-card definitions
--   loyalty_card_items  which products or departments a card counts
--
-- That was the honest answer at the time, because loyalty_card_items has
-- foreign keys to `products` and `departments` and could not follow the
-- customer without dragging the product file with it.
--
-- The result was a strange shape: one shared points balance, but a tier ladder
-- and a punch card per store. Gold could mean R50,000 at one branch and
-- R30,000 at another, measured against one shared spend figure. Nobody would
-- describe that as a loyalty programme.
--
-- ── THE KEY THAT MAKES THIS POSSIBLE ─────────────────────────────────────
--
-- Product IDS are per-database and mean nothing across stores. Product CODES
-- are how this system already identifies "the same product" everywhere — see
-- lib/site/shareSettings.ts — and department NAMES play the same role that
-- price-structure names do in productFanout.
--
-- So the configuration stops naming local rows and names the portable thing
-- instead. A card says "COFFEE-01", and each branch resolves that to whatever
-- its own products table calls it at the moment a sale is rung up.
--
-- ── WHAT THIS MEANS IN THE SHOP ──────────────────────────────────────────
--
-- A card scoped to a product code earns stamps ONLY at branches that carry
-- that code. That is not a limitation to work around — a branch that does not
-- stock the item genuinely cannot award a stamp for buying it — but it is a
-- real behaviour and the setup screen should eventually say which stores carry
-- each code. Recorded rather than hidden.
--
-- ── NO DATA MIGRATION ────────────────────────────────────────────────────
--
-- No site is live, so the columns are added and the id columns dropped rather
-- than back-filled. A deployed site would have needed a translation pass.

/* ── Cards name a product CODE, not a local id ────────────────────────── */

ALTER TABLE loyalty_cards
  ADD COLUMN IF NOT EXISTS reward_product_code VARCHAR(32) NULL AFTER reward_product_id;

-- The FK went to `products`, which stays in the branch while the card moves to
-- the owner. Nothing to repoint it at.
ALTER TABLE loyalty_cards DROP FOREIGN KEY IF EXISTS fk_loyalty_card_product;
ALTER TABLE loyalty_cards DROP COLUMN IF EXISTS reward_product_id;

/* ── Scope rows name a code or a department name ──────────────────────── */

ALTER TABLE loyalty_card_items
  ADD COLUMN IF NOT EXISTS product_code VARCHAR(32) NULL AFTER card_id,
  ADD COLUMN IF NOT EXISTS department_name VARCHAR(120) NULL AFTER product_code;

ALTER TABLE loyalty_card_items DROP FOREIGN KEY IF EXISTS fk_card_item_product;
ALTER TABLE loyalty_card_items DROP FOREIGN KEY IF EXISTS fk_card_item_department;

-- The old unique keys and CHECK were written against the id columns.
ALTER TABLE loyalty_card_items DROP INDEX IF EXISTS uq_card_product;
ALTER TABLE loyalty_card_items DROP INDEX IF EXISTS uq_card_department;
ALTER TABLE loyalty_card_items DROP CONSTRAINT IF EXISTS ck_card_item_target;

ALTER TABLE loyalty_card_items DROP COLUMN IF EXISTS product_id;
ALTER TABLE loyalty_card_items DROP COLUMN IF EXISTS department_id;

ALTER TABLE loyalty_card_items
  ADD UNIQUE KEY IF NOT EXISTS uq_card_product (card_id, product_code),
  ADD UNIQUE KEY IF NOT EXISTS uq_card_department (card_id, department_name);

-- Exactly one of the two is set, as before. A scope row naming both, or
-- neither, would silently match nothing.
ALTER TABLE loyalty_card_items
  ADD CONSTRAINT ck_card_item_target CHECK (
    (product_code IS NOT NULL AND department_name IS NULL) OR
    (product_code IS NULL AND department_name IS NOT NULL)
  );

/* ── Vouchers name a product code too ─────────────────────────────────── */

-- A voucher outlives the card that issued it and is redeemed at any branch, so
-- it carries the reward itself rather than looking it back up.
ALTER TABLE loyalty_vouchers
  ADD COLUMN IF NOT EXISTS reward_product_code VARCHAR(32) NULL AFTER reward_product_id;

ALTER TABLE loyalty_vouchers DROP FOREIGN KEY IF EXISTS fk_voucher_product;
ALTER TABLE loyalty_vouchers DROP COLUMN IF EXISTS reward_product_id;
