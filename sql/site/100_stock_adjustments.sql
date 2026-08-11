-- ─────────────────────────────────────────────────────────────────────────
-- Stock adjustments: writing stock on or off, on purpose, with a reason.
--
-- ── THE GAP THIS FILLS ───────────────────────────────────────────────────
--
-- movement_type 'adjustment' has existed since 015, and until now exactly four
-- things wrote one:
--
--   stock take post      the count disagreed with the books
--   stock take cancel    that count was reversed
--   GRV void             a receipt was undone
--   supplier return      goods went back
--
-- Every one of them is a SIDE EFFECT of some other document. Nothing could say
-- "three of these were dropped, write them off". The only way to write stock off
-- deliberately was to raise a stock take, count the whole location, and let the
-- variance do it — which is a days work to record a broken bottle, and it
-- corrupts the count history of every other product on the sheet.
--
-- ── WHY A DOCUMENT AND NOT A LOOSE MOVEMENT ──────────────────────────────
--
-- The same argument 026 makes about transfers. A bare movement records the
-- arithmetic and throws away the event: nobody can later ask "what did we write
-- off in March, who authorised it, and why". So an adjustment is numbered like
-- every other document, carries a reason, and can be cancelled by reversal
-- rather than deleted.
--
-- ── THE INVARIANTS ARE UNTOUCHED ─────────────────────────────────────────
--
-- Unlike a transfer, an adjustment is deliberately ONE-SIDED. It writes a
-- single movement per line against a single location:
--
--   (A) Sigma qty_change            = products.stock_on_hand   -- the total moves
--   (B) Sigma per product, location = product_location_stock    -- the pile moves
--   (C) Sigma piles                 = products.stock_on_hand    -- both by the same
--
-- That is the whole point: the business genuinely owns more or less than it did.
-- recordMovement() moves both figures together, so all three hold with no work
-- here beyond going through it.
--
-- ── COST IS RECORDED, NOT RECALCULATED ───────────────────────────────────
--
-- average_cost is untouched, matching transfers and unlike a GRV. Writing off
-- damaged stock does not change what the remaining units cost — no money was
-- spent and no new goods arrived. The cost is copied onto the line and the
-- movement so the value written off is answerable, and that value is what the
-- GL journal posts.
--
-- ── WHY A REASON IS A TABLE AND NOT AN ENUM ──────────────────────────────
--
-- Reasons are the whole reporting value of this document: "how much did we lose
-- to breakage last quarter" is the question it exists to answer. An ENUM would
-- freeze the list at whatever eight words seemed right today, and widening one
-- is a three-step migration. A table lets a site add SPILLAGE or STAFF-MEAL
-- without a code change, and lets a reason be retired without rewriting history.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Reasons ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustment_reasons (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Short handle a person types and a report groups by: DAMAGE, SHRINK.
  code        VARCHAR(24)  NOT NULL,
  name        VARCHAR(120) NOT NULL,

  -- Which way this reason can move stock, so the screen can refuse a write-ON
  -- reasoned as breakage. `both` is for genuinely two-way reasons like a
  -- correction of a capture error.
  direction   ENUM('in','out','both') NOT NULL DEFAULT 'both',

  -- Retired rather than deleted, for the same reason a location is: history
  -- naming it has to keep reading correctly.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  sort_order  INT          NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_adj_reason_code (code),
  KEY ix_adj_reason_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Seed the reasons every shop needs ─────────────────────────────────
-- INSERT IGNORE rather than NOT EXISTS on the whole table: a site that has
-- already added reasons of its own must still receive any new standard one, and
-- the unique code on `code` makes each row arrive at most once.
INSERT IGNORE INTO stock_adjustment_reasons (code, name, direction, sort_order) VALUES
  ('DAMAGE',   'Damaged',              'out',  10),
  ('SHRINK',   'Shrinkage or theft',   'out',  20),
  ('EXPIRED',  'Expired or spoiled',   'out',  30),
  ('CONSUMED', 'Used in the business', 'out',  40),
  ('SAMPLE',   'Sample or giveaway',   'out',  50),
  ('FOUND',    'Found on the floor',   'in',   60),
  ('CORRECT',  'Capture correction',   'both', 70);

-- ── 3. The adjustment itself ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Issued from document_sequences at POST, like a stock take and unlike an
  -- order: a draft that is abandoned must not burn a number.
  document_number VARCHAR(32)  NULL,
  document_date   DATE         NOT NULL,

  -- One adjustment adjusts ONE location. The same argument stock takes make:
  -- a variance always belongs to a specific pile, and a document spanning rooms
  -- turns "where did it go" back into a question nobody can answer.
  location_id     INT UNSIGNED NOT NULL,

  --   draft      being captured, nothing has moved
  --   posted     movements written, stock has moved
  --   cancelled  reversed, with an opposite movement per line
  status          ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',

  -- The document default. A line may override it, which is what makes one
  -- document able to record a mixed clear-out rather than forcing five.
  reason_id       INT UNSIGNED NULL,

  reference       VARCHAR(60)  NULL,   -- an incident number, a bin card
  note            VARCHAR(400) NULL,

  -- Cached at post so the list can show what a document was worth without
  -- summing its lines, and so the GL mirror has one figure to post. Signed:
  -- negative is stock written off.
  variance_qty    DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  variance_value  DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  posted_at       DATETIME     NULL,
  cancel_reason   VARCHAR(190) NULL,
  cancelled_at    DATETIME     NULL,

  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_adjustment_number (document_number),
  KEY ix_adjustment_date (document_date, id),
  KEY ix_adjustment_status (status, document_date),
  KEY ix_adjustment_location (location_id, status),
  -- RESTRICT, matching stock_transfers and stock_takes: a location named by an
  -- adjustment cannot be deleted out from under its history.
  CONSTRAINT fk_adjustment_location FOREIGN KEY (location_id) REFERENCES stock_locations (id) ON DELETE RESTRICT,
  -- SET NULL, unlike the location: a reason is a label, and retiring one must
  -- not be blocked by documents that used it. The name is copied onto the line
  -- so the document still reads correctly if this ever fires.
  CONSTRAINT fk_adjustment_reason FOREIGN KEY (reason_id) REFERENCES stock_adjustment_reasons (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. What is on it ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustment_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  adjustment_id   INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  product_id      INT UNSIGNED NOT NULL,
  -- Copied at capture, like every other document line: the product may be
  -- renamed later and this has to keep saying what was actually adjusted.
  product_code    VARCHAR(40)  NULL,
  description     VARCHAR(190) NOT NULL,

  -- What the pile held when the line was captured. Shown on the document so a
  -- reader can see what was being corrected, and used by the screen to turn a
  -- "set the count to 7" entry into a delta.
  --
  -- It is a SNAPSHOT, not a condition of posting. The delta below is what posts,
  -- because an adjustment is a statement about a QUANTITY THAT MOVED, not about
  -- a total. Two people writing off two units each must remove four.
  qty_before      DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- Signed. Negative writes stock off. This is the authoritative figure and the
  -- one handed to recordMovement().
  qty_change      DECIMAL(12,3) NOT NULL,

  -- What the units were worth, for the value written off and the GL journal.
  -- Defaulted from average_cost at capture and editable, because the cost of a
  -- damaged case is sometimes known better than the average.
  unit_cost_excl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Overrides the document reason. NULL means follow the document.
  reason_id       INT UNSIGNED NULL,

  -- For a serial-tracked product, WHICH units moved. Same shape as
  -- stock_take_lines.serial_ids, and read by the same helpers. The quantity
  -- alone would leave every serial claiming a status the pile disagrees with.
  serial_ids      JSON          NULL,

  note            VARCHAR(190)  NULL,

  -- The movement this line wrote, so a line and its ledger entry can be walked
  -- in both directions. Matches stock_take_lines.movement_id.
  movement_id     BIGINT UNSIGNED NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_aline_adjustment (adjustment_id, line_number),
  KEY ix_aline_product (product_id),
  -- One line per product per document. A second line for the same code is
  -- almost always a double capture, and summing them silently is how a
  -- write-off doubles.
  UNIQUE KEY uq_aline_product (adjustment_id, product_id),
  CONSTRAINT fk_aline_adjustment FOREIGN KEY (adjustment_id) REFERENCES stock_adjustments (id) ON DELETE CASCADE,
  -- RESTRICT, matching stock_movements: a product that has been adjusted has
  -- history, and deleteProduct already archives on reference.
  CONSTRAINT fk_aline_product    FOREIGN KEY (product_id)    REFERENCES products (id) ON DELETE RESTRICT,
  CONSTRAINT fk_aline_reason     FOREIGN KEY (reason_id)     REFERENCES stock_adjustment_reasons (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 5. Numbering ─────────────────────────────────────────────────────────
-- INSERT IGNORE so a site that already has the row keeps its own prefix and
-- next number rather than being reset to 1 on a re-run.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('stock_adjustment', 'ADJ', 1, 6, 'none');

-- ── 6. The GL mapping is already there ───────────────────────────────────
-- 045 seeded account 5100 Stock adjustments and 081 mapped the key
-- 'stock_adjustment' to it for stock takes. This document posts the SAME
-- journal against the SAME account, so there is nothing new to map — which is
-- the correct answer rather than a shortcut: a write-off found by counting and
-- a write-off recorded deliberately are the same expense.
--
-- Repeated here defensively for a site that somehow reached 100 without 081.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'stock_adjustment', NULL, a.id
  FROM gl_accounts a
 WHERE a.account_code = '5100'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m
                    WHERE m.mapping_key = 'stock_adjustment' AND m.ref_id IS NULL)
 LIMIT 1;
