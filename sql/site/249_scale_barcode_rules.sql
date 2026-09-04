-- More than one scale barcode shape per shop.
--
-- ── WHY A TABLE, WHEN THREE SETTINGS ROWS WORKED ──────────────────────────
--
-- `barcode_variable_prefix`, `barcode_plu_length` and `barcode_value_divisor`
-- describe exactly ONE barcode shape, which is one more assumption than a shop
-- floor supports. A grocer runs several scales, buys a second-hand one, or takes
-- deliveries pre-labelled by a supplier whose machine prints a different prefix
-- and a different PLU length. The legacy system this replaces let a shop add as
-- many rows as it had shapes, and it was right to.
--
-- With one setting the shop has to choose which of its scales works. The items
-- from the other one scan as an unknown barcode — no price, no product, and
-- nothing on screen saying why.
--
-- ── THE COLUMNS ARE THE LEGACY SCREEN'S, DELIBERATELY ─────────────────────
--
-- prefix / stock code / check digit / value length / decimals. Named to match
-- what the people using this already know, rather than renamed to match what
-- the parser happens to call them:
--
--   · `plu_length` is the legacy STOCK CODE column. It is the number of digits
--     that identify the product, and it is matched against the product's own
--     code, barcode or alias — the "PLU link".
--   · `has_check_digit` says the last digit is a check digit and so is not part
--     of the value. It does NOT verify it: a scale that prints a non-standard
--     check digit would then stop scanning altogether, and the till refusing a
--     real product at a queue is worse than accepting a mis-keyed one that will
--     fail to find a product anyway.
--   · `value_length` validates the barcode's total length rather than slicing
--     the value out of it. The value is still everything between the PLU and
--     the check digit — see parseVariableBarcode, which has read them that way
--     since before this table existed and reads existing labels correctly.
--   · `decimals` replaces the divisor: 2 means the embedded figure is in cents,
--     3 that it is in grams. Stored as the legacy screen shows it, because a
--     shopkeeper reading their own scale's manual is told a decimal count, not
--     a divisor, and 10^decimals is arithmetic this code can do itself.
--
-- ── NO UNIQUE ON prefix ───────────────────────────────────────────────────
--
-- Two rules may legitimately share a prefix and differ in PLU length, which is
-- exactly the case a shop with two scales hits. Matching is by longest prefix
-- then by `position`, so an ambiguous pair still resolves the same way every
-- time rather than depending on insertion order.

CREATE TABLE IF NOT EXISTS scale_barcode_rules (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The leading digits that mark a scale label. One or two on every scale seen
  -- so far, but sized for a machine that disagrees.
  prefix          VARCHAR(4)   NOT NULL,
  -- The legacy STOCK CODE column: how many digits identify the product.
  plu_length      TINYINT UNSIGNED NOT NULL DEFAULT 5,
  -- Is the last digit a check digit, and therefore not part of the value.
  has_check_digit TINYINT(1)   NOT NULL DEFAULT 1,
  -- The barcode's total length. 0 means "do not check", which is what a rule
  -- migrated from the old single setting gets: that setting never recorded one,
  -- and inventing 13 here would refuse a 12-digit label that scans today.
  value_length    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  -- 2 = the embedded figure is in cents, 3 = grams.
  decimals        TINYINT UNSIGNED NOT NULL DEFAULT 2,
  -- Tie-break when two rules share a prefix of the same length.
  position        INT          NOT NULL DEFAULT 0,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_prefix (prefix)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── CARRY THE SHOP'S EXISTING SHAPE ACROSS ────────────────────────────────
--
-- A shop trading today has one working scale shape in `settings`, and this
-- table starting empty would stop every weighed item scanning the moment it
-- deployed. So the existing setting becomes the first rule.
--
-- Guarded three ways, because a migration that runs twice or runs on a fresh
-- site must not produce a duplicate or a nonsense row: only when the table is
-- empty, only when a prefix is actually set, and the divisor is mapped to a
-- decimal count rather than assumed.
INSERT INTO scale_barcode_rules (prefix, plu_length, has_check_digit, value_length, decimals, position)
SELECT
  p.setting_value,
  COALESCE(NULLIF(l.setting_value, ''), '5'),
  1,
  0,
  CASE COALESCE(NULLIF(d.setting_value, ''), '100')
    WHEN '1'    THEN 0
    WHEN '10'   THEN 1
    WHEN '100'  THEN 2
    WHEN '1000' THEN 3
    ELSE 2
  END,
  0
FROM settings p
LEFT JOIN settings l ON l.setting_key = 'barcode_plu_length'
LEFT JOIN settings d ON d.setting_key = 'barcode_value_divisor'
WHERE p.setting_key = 'barcode_variable_prefix'
  AND p.setting_value IS NOT NULL
  AND p.setting_value <> ''
  AND NOT EXISTS (SELECT 1 FROM scale_barcode_rules);
