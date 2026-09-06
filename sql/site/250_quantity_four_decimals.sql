-- Quantities go from three decimal places to four.
--
-- ── WHY ───────────────────────────────────────────────────────────────────
--
-- A product can be marked "allow decimal fractions", and now says how MANY
-- decimals it allows: 2, 3 or 4. The first two the schema already stored. The
-- third it did not — every quantity column in the sales and stock path was
-- DECIMAL(_,3), so a till taking 1.2345 would have written 1.234 and the slip
-- would have disagreed with the stock movement it caused.
--
-- That disagreement is the thing to avoid, not the lost digit. 001_products.sql
-- opens by saying quantities are DECIMAL(12,3) "so weighed goods work", and the
-- stock ledger is built on a provable identity:
--
--     Σ stock_movements.qty_change = products.stock_on_hand
--
-- Both sides of that are quantity columns. Widen one and not the other and the
-- identity stops holding — not visibly, but by a thousandth at a time, on the
-- products a shop weighs most. So this widens the whole family together, in one
-- migration, rather than the columns a single feature happens to touch.
--
-- Percentages are deliberately NOT touched. DECIMAL(6,3) holds discount_pct,
-- vat_rate_pct, multiplier, commission_pct and their kin — a rate to three
-- places is not a quantity and gains nothing from a fourth. On a live site the
-- split is exact: 48 quantity columns at (12,3)/(14,3), 34 rates at (6,3), and
-- no column of either shape whose name suggests it belongs to the other group.
--
-- Widening a DECIMAL is not lossy: 1.234 becomes 1.2340, and every stored value
-- keeps its meaning. Nothing needs backfilling.
--
-- ── WHY IT ASKS THE SCHEMA RATHER THAN LISTING THE COLUMNS ────────────────
--
-- Written out by hand this is 31 ALTER TABLE statements naming 48 columns, and
-- every one is a chance to typo a default or drop a NULL. Worse, sites drift: a
-- table added by a later migration may be missing on a site that has not run it
-- yet, and one absent table aborts a flat script halfway — leaving the ledger
-- half-widened, which is the exact split-precision state this exists to prevent.
--
-- So every ALTER asks the schema first, rather than asserting what is there.
--
-- Written as one guarded ALTER per table rather than one generated statement:
-- PREPARE accepts exactly ONE statement, so 31 tables cannot be widened by a
-- single prepared string, and a stored procedure with a cursor — which would
-- read more plainly — cannot be shipped here either, because CREATE PROCEDURE
-- needs a DELIMITER change and DELIMITER is a mysql-client directive that this
-- repo's runner (scripts/site-migrate.mjs, a mysql2 connection) does not know.
--
-- Each block asks whether that table still HAS a scale-3 quantity column before
-- touching it. That is what makes this both drift-proof and re-runnable: a site
-- missing the table answers 0 and skips it, and a site that has already run this
-- answers 0 for every table and does nothing at all.
--
-- The list was generated FROM a live schema rather than transcribed out of
-- sql/site/*.sql, so it reflects what sites actually have — including columns
-- that arrived through later ALTERs. Each keeps its own precision, nullability
-- and default; only the scale moves. stock_takes.variance_qty and
-- stock_adjustments.variance_qty are (14,3) rather than (12,3) and stay 14 wide.
SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'batch_movements'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `batch_movements`
     MODIFY COLUMN `qty_change` DECIMAL(12,4) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contract_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `contract_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'instruction_options'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `instruction_options`
     MODIFY COLUMN `quantity` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_card_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `job_card_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `invoiced_qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `issued_qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_headline_parts'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `job_headline_parts`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_part_requests'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `job_part_requests`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'job_stock_reservations'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `job_stock_reservations`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kitchen_send_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `kitchen_send_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'layby_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `layby_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manufacturing_orders'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `manufacturing_orders`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manufacturing_order_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `manufacturing_order_lines`
     MODIFY COLUMN `qty_consumed` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_order_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `online_order_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'online_stock_holds'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `online_stock_holds`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pos_void_events'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `pos_void_events`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'products'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `products`
     MODIFY COLUMN `stock_on_hand` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `pack_size` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_batches'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `product_batches`
     MODIFY COLUMN `qty_received` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `qty_remaining` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_location_stock'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `product_location_stock`
     MODIFY COLUMN `stock_on_hand` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `min_stock` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `max_stock` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_recipes'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `product_recipes`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_refers'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `product_refers`
     MODIFY COLUMN `factor` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'product_suppliers'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `product_suppliers`
     MODIFY COLUMN `pack_size` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `purchase_document_lines`
     MODIFY COLUMN `qty_ordered` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `qty_received` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `qty_bonus` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_document_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `sales_document_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `qty_delivered` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_document_line_instructions'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `sales_document_line_instructions`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000,
     MODIFY COLUMN `stock_qty_per` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'special_items'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `special_items`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_adjustments'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `stock_adjustments`
     MODIFY COLUMN `variance_qty` DECIMAL(14,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_adjustment_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `stock_adjustment_lines`
     MODIFY COLUMN `qty_before` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `qty_change` DECIMAL(12,4) NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_movements'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `stock_movements`
     MODIFY COLUMN `qty_change` DECIMAL(12,4) NOT NULL,
     MODIFY COLUMN `qty_after` DECIMAL(12,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_takes'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `stock_takes`
     MODIFY COLUMN `variance_qty` DECIMAL(14,4) NOT NULL DEFAULT 0.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_take_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `stock_take_lines`
     MODIFY COLUMN `snapshot_qty` DECIMAL(12,4) NOT NULL DEFAULT 0.000,
     MODIFY COLUMN `counted_qty` DECIMAL(12,4) NULL DEFAULT NULL,
     MODIFY COLUMN `entered_qty` DECIMAL(12,4) NULL DEFAULT NULL,
     MODIFY COLUMN `posted_qty_before` DECIMAL(12,4) NULL DEFAULT NULL,
     MODIFY COLUMN `variance_qty` DECIMAL(12,4) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock_transfer_lines'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `stock_transfer_lines`
     MODIFY COLUMN `qty` DECIMAL(12,4) NOT NULL,
     MODIFY COLUMN `qty_received` DECIMAL(12,4) NULL DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'supplier_prices'
      AND DATA_TYPE = 'decimal' AND NUMERIC_SCALE = 3 AND NUMERIC_PRECISION > 6) > 0,
  'ALTER TABLE `supplier_prices`
     MODIFY COLUMN `pack_size` DECIMAL(12,4) NOT NULL DEFAULT 1.000',
  'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── The product's own setting ─────────────────────────────────────────────
--
-- How many decimals this product allows, when allow_fractions is on. Null-free
-- with a default of 3 so every existing fractional product keeps behaving
-- exactly as it did — 3 is what the till has always accepted, so a shop that
-- never opens this screen sees no change at all.
--
-- Meaningless while allow_fractions is 0, and deliberately NOT enforced to
-- match: a shop that switches fractions off and back on should find the number
-- of decimals it chose still there, rather than reset to a default because the
-- flag went round trip. The reader asks about the flag first.
--
-- A plain column rather than an ENUM: the value is a number used as a number —
-- rounding is done to this many places — and an ENUM would hand back the
-- string '2'.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS qty_decimals TINYINT UNSIGNED NOT NULL DEFAULT 3
    AFTER allow_fractions;
