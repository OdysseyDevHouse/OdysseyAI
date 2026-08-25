-- ─────────────────────────────────────────────────────────────────────────
-- BLOCK TESTS — what a carcass actually cost, cut by cut.
--
-- A butcher buys a hindquarter at one rand-per-kilo and sells fillet, rump,
-- mince and stewing beef at four different ones. The block test is the
-- arithmetic that turns the first number into the other four, and it is the
-- only way to know whether rump at R180/kg is making money or losing it.
--
-- ── WHY THIS IS NOT A MANUFACTURING ORDER ────────────────────────────────
--
-- Manufacturing is many inputs → ONE output: `manufacturing_orders` carries a
-- single product_id and qty. A block test is the exact inverse — one carcass
-- in, twenty cuts out, each at a different value — and that inversion is the
-- whole feature. Bending a production order into it is what every vendor in
-- the market does, and it is why none of them report per-cut margin properly.
--
-- ── THE COSTING METHOD, AND WHY THE OBVIOUS ONE IS WRONG ─────────────────
--
-- Splitting the carcass cost by SALES VALUE is the textbook answer and it is
-- wrong here. It hands every cut an identical gross margin — a computed 75kg
-- hindquarter returns 15.59% on fillet, mince and stewing beef alike — which
-- erases the exact per-cut comparison a butcher runs a block test to get.
--
-- SA practice (RPO, published via AgriOrbit) stores an independent FACTOR per
-- cut instead:
--
--     factor = cut's R/kg (ex-VAT, ex-margin) ÷ carcass R/kg
--
-- Beef runs fillet 2.380 down to short rib 0.973. The published worked example
-- verifies against this reading and only this one:
--
--     98.31 × 1.283 × 1.44 × 1.15 = R208.87   (published R208.80)
--
-- Margin there is a MARKUP, not a GP divisor. Read as a divisor the same
-- inputs give R259.02, and every cut in the shop is mispriced.
--
-- ── THREE THINGS THE SCHEMA HAS TO SURVIVE ───────────────────────────────
--
-- 1. Factors set independently DO NOT SELF-BALANCE. A real test table
--    recovered only R3,992 of a R6,150 side, because bone and drip carry no
--    factor at all. Silently losing R2,158 of stock value is not an option, so
--    a document either NORMALISES (scales the factors so the allocation sums
--    to the parent exactly) or posts the shortfall to a variance account.
--    Both are offered because it is an accounting-policy choice, not a
--    technical one: some shops want yield loss visible in the P&L, others
--    want it buried in the cut costs where it lands on margin.
--
-- 2. A cut must never take NEGATIVE cost. Constant-gross-margin allocation
--    demonstrably produces it (−R268.84 on bones), and a negative inventory
--    value is meaningless. A negative factor is refused at validation rather
--    than clamped at posting — clamping would silently change what somebody
--    typed.
--
-- 3. Weight-proportional allocation is deliberately NOT offered. It is the
--    wrong answer that looks reasonable, and a butcher who picks it once will
--    not notice: it prices fillet and bone-in shin identically.

CREATE TABLE IF NOT EXISTS block_tests (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- NULL until posted: the number is allocated at posting, like every other
  -- document here, so a discarded draft burns none.
  document_number     VARCHAR(40)  NULL,
  document_date       DATE         NOT NULL,
  /*
   * 'cancelled' is REQUIRED, not stylistic. `verifySequence` hard-codes
   * status = 'cancelled' to tell a voided number from a live one, and a table
   * registered in OWN_TABLE_TYPES without that value cannot be checked at all.
   * Omitting the registration has bitten this codebase twice — stock takes,
   * then job cards — and reports every number ever issued as MISSING.
   */
  status              ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',
  location_id         INT UNSIGNED NULL,

  -- What was broken down. Class and fat codes are NULLABLE because
  -- classification is only conditionally compulsory in SA — above 40 head a
  -- month at a registered abattoir — so a small shop legitimately has neither.
  species             VARCHAR(20)  NOT NULL DEFAULT 'beef',
  class_code          VARCHAR(10)  NULL,
  fat_code            VARCHAR(10)  NULL,
  -- The supplier's carcass or consignment number. The SA roller mark carries
  -- age class, fat class and abattoir code but NO carcass number, so this can
  -- only come off the paperwork.
  carcass_no          VARCHAR(40)  NULL,

  input_product_id    INT UNSIGNED NULL,
  input_product_code  VARCHAR(40)  NOT NULL DEFAULT '',
  input_description   VARCHAR(190) NOT NULL DEFAULT '',
  input_qty           DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  input_unit_cost_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The lot the carcass came in on, when the input is batch-tracked. A carcass
  -- IS a lot, which is what makes cut-level traceability possible at all.
  input_batch_id      INT UNSIGNED NULL,

  apportionment       ENUM('factor','manual') NOT NULL DEFAULT 'factor',
  -- 1 scales the factors so Σ(allocated) = input cost exactly; 0 posts the
  -- unrecovered residual to variance_account_id. See the header.
  normalise           TINYINT(1)   NOT NULL DEFAULT 1,
  variance_account_id INT UNSIGNED NULL,

  -- Denormalised at posting so a list screen and a report need no recompute,
  -- and so the figures cannot drift if a factor is edited on a later document.
  input_cost          DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  output_cost         DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  variance_cost       DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  -- Saleable weight out ÷ weight in. The number the butcher actually watches.
  yield_pct           DECIMAL(7,3)  NOT NULL DEFAULT 0.000,

  reference           VARCHAR(60)  NULL,
  note                VARCHAR(500) NULL,
  user_id             INT UNSIGNED NULL,
  user_name           VARCHAR(120) NOT NULL DEFAULT '',
  posted_at           DATETIME     NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_block_test_number (document_number),
  KEY ix_block_test_date (document_date),
  KEY ix_block_test_species (species, document_date),
  KEY ix_block_test_input (input_product_id),
  CONSTRAINT fk_block_test_location FOREIGN KEY (location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per cut coming off the carcass.
CREATE TABLE IF NOT EXISTS block_test_lines (
  id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
  block_test_id       INT UNSIGNED NOT NULL,
  line_number         INT UNSIGNED NOT NULL DEFAULT 1,
  product_id          INT UNSIGNED NULL,
  product_code        VARCHAR(40)  NOT NULL DEFAULT '',
  description         VARCHAR(190) NOT NULL DEFAULT '',
  -- Weight out for this cut.
  qty                 DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- The SA factor. Zero is legitimate — see exclude_from_apportionment — but
  -- NEGATIVE is refused at validation: it would hand this cut a negative cost
  -- and inflate every other line to compensate.
  cost_factor         DECIMAL(10,4) NOT NULL DEFAULT 1.0000,
  exclude_from_apportionment TINYINT(1) NOT NULL DEFAULT 0,

  /*
   * Bone, drip and trim thrown away.
   *
   * A flag rather than a product, because bone in the bin is not stock and
   * must not become a stock row. It still has to CONSUME INPUT WEIGHT or the
   * yield percentage lies — which is the one figure the whole document exists
   * to produce.
   */
  is_loss             TINYINT(1)   NOT NULL DEFAULT 0,

  -- Computed at posting from the apportionment above.
  allocated_cost_excl DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  unit_cost_excl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The lot this cut became, when the shop tracks lots through the breakdown.
  batch_id            INT UNSIGNED NULL,
  note                VARCHAR(190) NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_block_line_test (block_test_id, line_number),
  KEY ix_block_line_product (product_id),
  CONSTRAINT fk_block_line_test FOREIGN KEY (block_test_id)
    REFERENCES block_tests (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Cut templates ────────────────────────────────────────────────────────
--
-- Without these a butcher keys twenty lines per carcass, every carcass, and
-- the feature does not get used. A template is a species' standard cut list
-- with each cut's expected yield and default factor.
CREATE TABLE IF NOT EXISTS block_test_templates (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(80)  NOT NULL,
  species     VARCHAR(20)  NOT NULL DEFAULT 'beef',
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  note        VARCHAR(190) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_block_template_name (name),
  KEY ix_block_template_species (species, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS block_test_template_lines (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_id  INT UNSIGNED NOT NULL,
  line_number  INT UNSIGNED NOT NULL DEFAULT 1,
  product_id   INT UNSIGNED NULL,
  description  VARCHAR(190) NOT NULL DEFAULT '',
  -- What this cut USUALLY comes to, as a percentage of the input weight. Only
  -- ever a starting point: the scale decides the real number.
  expected_yield_pct DECIMAL(7,3) NOT NULL DEFAULT 0.000,
  cost_factor  DECIMAL(10,4) NOT NULL DEFAULT 1.0000,
  is_loss      TINYINT(1)   NOT NULL DEFAULT 0,
  exclude_from_apportionment TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY ix_block_tpl_line (template_id, line_number),
  CONSTRAINT fk_block_tpl_line FOREIGN KEY (template_id)
    REFERENCES block_test_templates (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The document type, so numbering works. Registered in OWN_TABLE_TYPES too —
-- the SQL half alone is not enough. See sequences.ts.
INSERT INTO document_sequences (terminal_id, doc_type, prefix, padding, next_number)
SELECT 0, 'block_test', 'BT', 6, 1
 WHERE NOT EXISTS (
   SELECT 1 FROM document_sequences WHERE terminal_id = 0 AND doc_type = 'block_test'
 );
