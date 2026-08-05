-- ─────────────────────────────────────────────────────────────────────────
-- Stock locations: more than one place to keep stock, inside ONE site.
--
-- A wholesaler with three stock rooms holds one product in three piles. Until
-- now `products.stock_on_hand` was a single number, so those piles were
-- indistinguishable — the system could say "we own 500" but never "480 are in
-- the warehouse and 20 are on the shop floor".
--
-- ── THIS IS NOT 002_stores.sql AGAIN ─────────────────────────────────────
--
-- 003 reverted `stores` because a STORE is a separate site with its own
-- master database, matched to its siblings by product `code` in the control
-- database. That reasoning is untouched and still correct.
--
-- A LOCATION is the opposite shape: stock rooms within a single site, sharing
-- one database, one product row, one set of documents and one VAT number. No
-- cross-database matching, no sharing rules, no control-database rows. The
-- two ideas compose — a site with four locations can still be linked to
-- another site with its own four.
--
-- The naming is deliberate and worth keeping: `location`, never `store`. The
-- moment these are called stores again, someone will try to link them.
--
-- ── THE INVARIANTS ───────────────────────────────────────────────────────
--
-- stockMovements.ts promised one thing:
--
--   (A)  Σ stock_movements.qty_change            = products.stock_on_hand
--
-- That promise is kept, unchanged. Two more are added beneath it:
--
--   (B)  Σ qty_change per (product, location)    = product_location_stock.stock_on_hand
--   (C)  Σ product_location_stock.stock_on_hand  = products.stock_on_hand
--
-- (A) is (B) and (C) together, which is exactly why it survives. Every one of
-- them is checkable by reconcileStock(), the same way (A) always was.
--
-- ── WHY products.stock_on_hand SURVIVES ──────────────────────────────────
--
-- It becomes the SITE TOTAL: what the business owns, everywhere. That is a
-- real and separately useful figure — stock valuation, the product list, the
-- reorder report and "do we have any at all" all want it, and none of them
-- want to sum a join first. Keeping it also means every existing read path
-- keeps working while the location paths are built on top.
--
-- It is derived, not authoritative. (C) is what says so, and reconcileStock()
-- is what proves it.
--
-- ── SELLING ──────────────────────────────────────────────────────────────
--
-- The till sells from the MAIN location only. Stock in a back warehouse is
-- owned but not sellable at the counter until it is transferred, so the till
-- reads the pile in the main location rather than the site total. Deciding
-- otherwise would have the counter promise goods that are in another
-- building.
--
-- DDL auto-commits, so every step here is re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. The locations themselves ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_locations (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Short handle a person types and a document prints: WH, SHOP, VAN2.
  code        VARCHAR(24)  NOT NULL,
  name        VARCHAR(120) NOT NULL,

  -- EXACTLY ONE row has this set. MariaDB cannot express "unique among rows
  -- where is_main = 1" — a partial index is Postgres — so the rule is held by
  -- setMainLocation() in stockLocations.ts, which clears every other row and
  -- sets one inside a single transaction. The index below makes that cheap
  -- and makes a violation visible at a glance.
  --
  -- The main location is where sales come from and where anything that does
  -- not name a location lands. It cannot be deleted or deactivated.
  is_main     TINYINT(1)   NOT NULL DEFAULT 0,

  -- Deactivating hides a location from new work while its stock and history
  -- stay intact and countable. Deleting is refused once any movement names
  -- it, for the same reason products archive instead of deleting.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  -- Where it is, for a picking slip. Free text: a stock room is not an
  -- address and forcing one on a van would be nonsense.
  address     VARCHAR(190) NULL,
  note        VARCHAR(190) NULL,

  sort_order  INT          NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_location_code (code),
  KEY ix_location_main (is_main),
  KEY ix_location_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Seed MAIN ─────────────────────────────────────────────────────────
-- Every site gets one immediately, because every figure below has to belong
-- somewhere and there is no such thing as stock in no location. A site that
-- never opens the locations screen keeps behaving exactly as it does today,
-- with one location holding everything.
INSERT INTO stock_locations (code, name, is_main, is_active, sort_order)
SELECT 'MAIN', 'Main', 1, 1, 0
 WHERE NOT EXISTS (SELECT 1 FROM stock_locations);

-- ── 3. Stock per product, per location ───────────────────────────────────
CREATE TABLE IF NOT EXISTS product_location_stock (
  product_id    INT UNSIGNED NOT NULL,
  location_id   INT UNSIGNED NOT NULL,

  -- The pile. Authoritative, per invariant (B): products.stock_on_hand is the
  -- sum of these, not the other way round.
  stock_on_hand DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- Levels live HERE and not on products, because a level is only meaningful
  -- against the stock it governs. A warehouse holding 500 and a shop floor
  -- holding 5 need different reorder points; one site-wide number could only
  -- ever be wrong for one of them. InventoryPanel.tsx has carried a comment
  -- making this argument since before there were locations to act on it.
  min_stock     DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  max_stock     DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- One row per pile, and the shape the recordMovement() upsert needs.
  --
  -- NOTE: no apostrophes in comments anywhere in this file. The runner sends
  -- it as one multipleStatements batch, and MariaDB reads a lone ' inside a
  -- `--` comment as opening a string literal, swallowing the SQL that
  -- follows. 024_laybys.sql fails to apply for exactly this reason.
  PRIMARY KEY (product_id, location_id),
  -- "What is in this location" — the picking and stock-take direction.
  KEY ix_pls_location (location_id),
  -- CASCADE, unlike stock_movements: this is a current position, not history.
  -- A product that is genuinely deletable (no movements, so deleteProduct()
  -- allows it) should not be blocked by a row saying it holds zero.
  CONSTRAINT fk_pls_product  FOREIGN KEY (product_id)  REFERENCES products (id)        ON DELETE CASCADE,
  -- RESTRICT: a location holding stock cannot be deleted out from under it.
  CONSTRAINT fk_pls_location FOREIGN KEY (location_id) REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. Backfill the piles from what products already holds ───────────────
-- Everything a site owns today is, by definition, in the only location it has
-- ever had. This is what makes invariant (C) true from the first second
-- rather than after someone runs a repair.
--
-- Levels come across in the same statement: they were site-wide, and the main
-- location is the site as far as history is concerned.
--
-- Re-runnable, and deliberately NOT via ON DUPLICATE KEY UPDATE: running this
-- twice must not reset a pile that has since moved — that would silently undo
-- every receipt made after the first run. The NOT EXISTS says the same thing
-- with no update branch at all, so there is nothing to get wrong later.
INSERT INTO product_location_stock (product_id, location_id, stock_on_hand, min_stock, max_stock)
SELECT p.id, l.id, p.stock_on_hand, p.min_stock, p.max_stock
  FROM products p
  JOIN (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1) l
 WHERE NOT EXISTS (
         SELECT 1 FROM product_location_stock pls
          WHERE pls.product_id = p.id AND pls.location_id = l.id);

-- ── 5. Movements record WHERE ────────────────────────────────────────────
-- Without this the per-location invariant (B) is uncheckable: a pile could
-- drift and nothing would be able to say which movement did it.
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS location_id INT UNSIGNED NULL AFTER product_id;

-- Existing history happened in the only location that existed. Stamping it
-- keeps (B) true across the whole table rather than only from today forward,
-- which is what lets reconcileStock() sum the entire history per pile.
UPDATE stock_movements
   SET location_id = (SELECT id FROM stock_locations WHERE is_main = 1 LIMIT 1)
 WHERE location_id IS NULL;

-- NULL stays permitted so the column can be added to a live table without a
-- default, but every path writes it — recordMovement() falls back to main
-- when a caller does not name one.
--
-- IF NOT EXISTS on every one of these: the runner records a migration only
-- once the whole file succeeds, and the header promises a file can be fixed
-- and re-run by hand. A bare ADD KEY would make the second attempt fail on
-- the index the first one already created, for no reason.
--
-- Note the foreign-key form: `ADD FOREIGN KEY IF NOT EXISTS <name> (cols)`.
-- MariaDB does NOT accept `ADD CONSTRAINT IF NOT EXISTS <name> FOREIGN KEY`
-- — the guard belongs to the FOREIGN KEY clause, not to CONSTRAINT.
ALTER TABLE stock_movements
  ADD KEY IF NOT EXISTS ix_move_location (location_id, created_at);

-- Per-pile history, and the index reconcileStock() groups by.
ALTER TABLE stock_movements
  ADD KEY IF NOT EXISTS ix_move_product_location (product_id, location_id);

ALTER TABLE stock_movements
  ADD FOREIGN KEY IF NOT EXISTS fk_move_location (location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT;

-- ── 6. A GRV line says where its goods went ──────────────────────────────
-- The only way stock enters a location other than main. Held on the LINE and
-- not the document, because the point is that ten stock codes on one GRV can
-- land in different rooms.
--
-- Stored as well as passed to the movement so the GRV can be reprinted
-- showing where each item was put — the movement row answers "what happened",
-- the document line answers "what did we agree to".
ALTER TABLE purchase_document_lines
  ADD COLUMN IF NOT EXISTS location_id INT UNSIGNED NULL AFTER product_id;

ALTER TABLE purchase_document_lines
  ADD FOREIGN KEY IF NOT EXISTS fk_pline_location (location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT;
