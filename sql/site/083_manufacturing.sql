-- ─────────────────────────────────────────────────────────────────────────
-- Manufacturing: turning a recipe into stock you can count.
--
-- 020 built the recipe half. It answers "when this sells, what leaves the
-- shelf?" by exploding the parent at the till: sell a burger and a patty, a
-- bun and a slice of cheese move, while the burger itself moves nothing
-- because there is no pile of burgers. stockDirectionFor() returns 0 for a
-- recipe for exactly that reason.
--
-- That is right for a burger. It is wrong for a loaf of bread, a bottled
-- sauce or a pre-packed hamper, which are made on Monday, counted on Tuesday
-- and sold on Wednesday. You cannot answer "how many finished loaves do I
-- have" in a model where the loaf never exists as stock.
--
-- ── THE TWO MODELS COEXIST, AND THE PRODUCT SAYS WHICH ───────────────────
--
--   is_manufactured = 0   sell a burger   -> -1 patty, -1 bun, -1 cheese
--   is_manufactured = 1   build 50 loaves -> -25kg flour, +50 loaves
--                         sell a loaf     -> -1 loaf
--
-- The flag defaults to 0, which is the load-bearing part of this migration:
-- every recipe product already in the field keeps behaving exactly as it does
-- today, and nothing changes until somebody ticks the box.
--
-- It is a flag rather than a ninth product_type because product_type decides
-- HOW A SALE MOVES STOCK and is consumed by stockDirectionFor(),
-- offlineBlockedProduct(), canSellNow(), the till tile renderer and the
-- product form tab map. A ninth type means touching all of them, and it would
-- let "is this made from a recipe" and "does this carry stock" contradict
-- each other. They cannot: a manufactured item is a recipe product that also
-- has a pile.
--
-- ── A BUILD IS A TRANSFER BETWEEN PRODUCTS ───────────────────────────────
--
-- Structurally this is 026 with products where 026 has locations: components
-- out, finished goods in, one transaction, every write through
-- recordMovement(). Unlike a transfer the site total DOES move, because value
-- is transformed rather than relocated. All three stock invariants still hold
-- for the same reason they hold everywhere else - nothing writes
-- products.stock_on_hand except recordMovement().
--
-- DDL auto-commits, so every statement here is re-runnable by hand.
-- ─────────────────────────────────────────────────────────────────────────

-- ── The flag ─────────────────────────────────────────────────────────────
-- Only meaningful on a product whose product_type is recipe. Left on other
-- types it is inert, which is preferable to a CHECK constraint that would
-- have to be dropped the first time another type wants to be built.
--
-- Changing it on a product that already has stock or movement history is
-- refused in saveProduct(), not here: the meaning of figures already recorded
-- would change under them, and a database constraint cannot explain that to
-- somebody in a form.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_manufactured TINYINT(1) NOT NULL DEFAULT 0 AFTER product_type;

-- ── Two new movement types ───────────────────────────────────────────────
-- Rather than reusing the adjustment type. The reason is the one table people
-- actually read to answer "what happened to this product": a baker looking at
-- flour needs to see that it went into production, not an adjustment that
-- reads identically to a stock-take correction or a voided GRV.
--
-- MODIFY with the full value list is naturally re-runnable - stating the
-- target shape rather than a delta.
ALTER TABLE stock_movements
  MODIFY movement_type ENUM('sale','sale_return','opening','receipt','adjustment',
                            'transfer_in','transfer_out',
                            'manufacture_in','manufacture_out') NOT NULL;

-- ── The order ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manufacturing_orders (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- NULL until posted. A draft that is deleted must not burn a number, and
  -- MySQL permits many NULLs in a unique index. Same rule as a GRV.
  document_number  VARCHAR(32)  NULL,
  document_date    DATE         NOT NULL,

  -- What is being made. RESTRICT because the history outlives the product,
  -- the same choice stock_movements makes.
  product_id       INT UNSIGNED NOT NULL,
  -- Snapshotted at capture, as every document line in this schema does: the
  -- product may be renamed or recoded later and the order must still read
  -- like what was actually built.
  product_code     VARCHAR(48)  NOT NULL DEFAULT '',
  description      VARCHAR(190) NOT NULL DEFAULT '',
  qty              DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  status           ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',

  -- Where the ingredients come from, and where the finished goods land. They
  -- may be the same room, and usually are - a kitchen. Separate columns
  -- because a central bakery supplying a shop front is the case that makes
  -- the module worth having.
  from_location_id INT UNSIGNED NOT NULL,
  to_location_id   INT UNSIGNED NOT NULL,

  -- Written at post, denormalised so the list screen needs no joins.
  component_cost   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  overhead_cost    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- (component_cost + overhead_cost) / qty. What one made unit cost, and what
  -- blends into the products.average_cost of the finished item.
  unit_cost_excl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  reference        VARCHAR(60)  NULL,
  note             VARCHAR(400) NULL,

  posted_at        DATETIME     NULL,
  cancelled_at     DATETIME     NULL,
  -- Cancelled, never void. 026 shipped void/void_reason and had to be
  -- renamed by 029; there is no reason to repeat that.
  cancel_reason    VARCHAR(200) NULL,

  -- Snapshotted, no FK - the name is copied at write time because there is no
  -- foreign key to protect the reference.
  user_id          INT UNSIGNED NULL,
  user_name        VARCHAR(120) NOT NULL DEFAULT '',

  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_mo_number (document_number),
  KEY ix_mo_date (document_date, id),
  KEY ix_mo_status (status, document_date),
  KEY ix_mo_product (product_id, document_date),
  CONSTRAINT fk_mo_product FOREIGN KEY (product_id)       REFERENCES products (id)        ON DELETE RESTRICT,
  CONSTRAINT fk_mo_from    FOREIGN KEY (from_location_id) REFERENCES stock_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_mo_to      FOREIGN KEY (to_location_id)   REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What it consumed ─────────────────────────────────────────────────────
-- SNAPSHOTTED AT POST, never read live from product_recipes afterwards.
--
-- This is the point of the table. A recipe edited in March must not silently
-- restate what a build in January consumed - the movements are already
-- written and the two would disagree with nothing to explain the difference.
-- The recipe is the plan; these lines are the record.
CREATE TABLE IF NOT EXISTS manufacturing_order_lines (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- CASCADE: a line has no meaning without its order, and a posted order is
  -- never deleted - it is cancelled.
  order_id       INT UNSIGNED NOT NULL,
  line_number    SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  product_id     INT UNSIGNED NOT NULL,
  product_code   VARCHAR(48)  NOT NULL DEFAULT '',
  description    VARCHAR(190) NOT NULL DEFAULT '',

  -- Per ONE of the parent, wastage already applied, as resolveComponents()
  -- returns it. 4 decimals because nesting multiplies fractions together.
  qty_per_unit   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- qty_per_unit x the order quantity. Stored rather than derived so the line
  -- can be read against its movement without re-doing the arithmetic.
  qty_consumed   DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  unit_cost_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_cost_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The stock_movements row this line produced. NULL on a draft.
  movement_id    BIGINT UNSIGNED NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- resolveComponents() already merges a component listed twice, so two rows
  -- for one component is always a bug rather than something to sum.
  UNIQUE KEY uq_mo_line (order_id, product_id),
  KEY ix_mo_line_product (product_id),
  CONSTRAINT fk_mo_line_order   FOREIGN KEY (order_id)   REFERENCES manufacturing_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_mo_line_product FOREIGN KEY (product_id) REFERENCES products (id)             ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Overhead ─────────────────────────────────────────────────────────────
-- Labour, packaging, electricity. Cost with no quantity: these lines roll
-- into the made unit cost and into the journal, and they move no stock.
--
-- Without them a manufactured item is valued at its ingredients alone, which
-- understates anything with meaningful labour in it - and the understatement
-- lands in gross profit on every unit sold, where it is very hard to see.
CREATE TABLE IF NOT EXISTS manufacturing_order_costs (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id      INT UNSIGNED NOT NULL,
  line_number   SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  description   VARCHAR(190) NOT NULL DEFAULT '',
  amount_excl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Where this cost is recovered FROM, when the site wants it split out.
  -- NULL falls back to the manufacturing_overhead mapping.
  account_id    INT UNSIGNED NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_mo_cost_order (order_id, line_number),
  CONSTRAINT fk_mo_cost_order   FOREIGN KEY (order_id)   REFERENCES manufacturing_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_mo_cost_account FOREIGN KEY (account_id) REFERENCES gl_accounts (id)          ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Numbering ────────────────────────────────────────────────────────────
-- INSERT IGNORE so a re-run cannot reset a live counter.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('manufacturing_order', 'MO', 1, 6, 'none');

-- ── The overhead account ─────────────────────────────────────────────────
-- 045 seeded account 5100 "Stock adjustments" (expense, cost_of_sales) and
-- gave it NO mapping_key, so resolveAccount() has never been able to reach
-- it. Giving it one puts an orphaned account back in service.
--
-- A site wanting a dedicated "Manufacturing overhead recovered" account
-- remaps this on the mappings screen - a settings change, not a code change.
--
-- NOT INSERT IGNORE: uq_mapping is (mapping_key, ref_id) and MySQL treats
-- NULLs as DISTINCT in a unique index, so IGNORE would not stop a second row
-- appearing on a re-run. NOT EXISTS is what actually makes this re-runnable.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'manufacturing_overhead', NULL, a.id
  FROM gl_accounts a
 WHERE a.account_code = '5100'
   AND NOT EXISTS (
     SELECT 1 FROM gl_mappings m
      WHERE m.mapping_key = 'manufacturing_overhead' AND m.ref_id IS NULL
   );
