-- ── Stock takes ──────────────────────────────────────────────────────────
--
-- Counting what is on the shelf, and writing the difference.
--
-- ── WHY A DOCUMENT AND NOT A FIELD ───────────────────────────────────────
--
-- The naive version of this feature is an editable stock_on_hand box on the
-- product screen. products.ts refuses that deliberately: average_cost and
-- stock_on_hand are not settable there. The reason is that a corrected figure
-- with no document behind it answers none of the questions anybody asks
-- afterwards -- who counted it, when, against what, and what the difference was
-- worth. Shrinkage is a number a business acts on, and it only exists if the
-- count is a document.
--
-- ── THE SNAPSHOT IS NOT THE TRUTH AT POST TIME ───────────────────────────
--
-- A sheet records what the system BELIEVED when the sheet was made
-- (snapshot_qty). Someone then walks the shelves, for an hour or for a weekend,
-- while the till keeps selling. So at post time there are two differences:
--
--   counted - snapshot   what the counter would say the difference is
--   counted - current    what must be written to make the pile match reality
--
-- The movement written is the SECOND. Posting the first would leave the pile
-- disagreeing with the count sheet the instant anything sold mid-count, which
-- is the one outcome a stock take exists to prevent.
--
-- Both are kept: snapshot_qty is what the counter worked against and belongs on
-- the variance report, posted_qty_before is what the pile actually held at the
-- moment of posting. When they differ the screen says so plainly rather than
-- silently reconciling.
--
-- ── FREEZING FREEZES THE SHEET, NOT THE TILL ─────────────────────────────
--
-- Freeze here means the snapshot is fixed and no lines may be added or removed.
-- It does NOT stop the till selling the counted products. A shop that cannot
-- trade during a count is a shop that does not run counts, and the two-figure
-- design above is exactly what makes trading-while-counting safe.
--
-- There is NO hard freeze, and 092 removed the columns that were going to carry
-- one. This application permits overselling everywhere on purpose -- canSellNow
-- always returns ok, salesPosting never refuses on quantity -- and an offline
-- till sells from its own catalogue in browser storage without asking the
-- server. A server-side block would refuse an online sale and be invisible to an
-- offline one, which is a control that cannot do what its name promises.
--
-- The two-figure design above is what makes counting a trading shop safe, and it
-- needs no freeze at all.
--
-- ── ONE SHEET, ONE LOCATION ──────────────────────────────────────────────
--
-- A sheet spanning rooms cannot express "counted in the stockroom, not yet in
-- the shop", and its variances would be unattributable to a pile. Counting a
-- whole business is n sheets.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. The sheet ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_takes (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Allocated at POST, not at create. A draft that gets deleted must not burn
  -- a number, and a sheet can sit in draft for a week before anyone posts it.
  document_number VARCHAR(32)  NULL,
  document_date   DATE         NOT NULL,

  location_id     INT UNSIGNED NOT NULL,

  --   draft     being built, lines still being added
  --   counting  frozen, snapshot fixed, people are counting
  --   posted    variances written as adjustment movements
  --   cancelled abandoned, or reversed after posting
  --
  -- Vocabulary note: cancelled, never void. 026 shipped void/void_reason and
  -- had to be renamed by 029; this file starts where that one ended up.
  status          ENUM('draft','counting','posted','cancelled') NOT NULL DEFAULT 'draft',

  -- What the sheet was built from, so it can be rebuilt and so the coverage
  -- report can say what has and has not been counted.
  -- department and brand are the two groupings products actually carry (001);
  -- there is no category column, and a scope for one would be a filter that
  -- silently matches nothing. See 085, which corrects this enum on any site
  -- that applied an earlier copy of this file carrying `category`.
  scope           ENUM('full','department','brand','supplier','manual') NOT NULL DEFAULT 'manual',
  scope_ref_id    INT UNSIGNED NULL,

  reference       VARCHAR(60)  NULL,
  note            VARCHAR(400) NULL,

  -- Set when the sheet is frozen. From here snapshot_qty is immutable and no
  -- product may join or leave the sheet.
  frozen_at       DATETIME     NULL,

  -- is_blocking and blocking_until were here. 092 drops them, and the reasoning
  -- is worth reading before anyone adds them back: this application permits
  -- overselling everywhere on purpose, and an offline till sells from its own
  -- catalogue without consulting the server at all.

  posted_at       DATETIME     NULL,
  cancelled_at    DATETIME     NULL,
  cancel_reason   VARCHAR(190) NULL,

  -- Written at post, so the list screen does not aggregate every line to show
  -- a row. Both are the NET figure across the sheet.
  variance_qty    DECIMAL(14,3) NOT NULL DEFAULT 0.000,
  variance_value  DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_take_number (document_number),
  KEY ix_take_date (document_date, id),
  KEY ix_take_status (status, document_date),
  KEY ix_take_location (location_id, status),
  -- RESTRICT, matching stock_transfers: a location named by a count cannot be
  -- deleted, for the same reason one named by a movement cannot.
  CONSTRAINT fk_take_location FOREIGN KEY (location_id) REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. What is on it ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_take_lines (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  stock_take_id     INT UNSIGNED NOT NULL,
  line_number       INT UNSIGNED NOT NULL DEFAULT 1,

  product_id        INT UNSIGNED NOT NULL,
  -- Copied at capture, like every other document line: the product may be
  -- renamed later and this has to keep saying what was actually counted.
  product_code      VARCHAR(40)  NULL,
  description       VARCHAR(190) NOT NULL,

  --   count    counted_qty is the new absolute level
  --   topup    entered_qty is added to whatever is there
  --   recount  a second pass over a line that varied on an earlier sheet
  --
  -- Stored rather than derived because "counted 14" and "added 6" are different
  -- claims about reality even when both land on 14.
  line_mode         ENUM('count','topup','recount') NOT NULL DEFAULT 'count',

  -- What the system believed when the sheet was made or last frozen.
  snapshot_qty      DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- NULL means NOT YET COUNTED, which is a different fact from counted-as-zero.
  -- That distinction is the whole reason this column is nullable, and the grid
  -- must never let an empty field and a typed 0 look alike.
  counted_qty       DECIMAL(12,3) NULL,
  -- What the user typed on a topup line. counted_qty is derived from it.
  entered_qty       DECIMAL(12,3) NULL,

  -- The pile at the instant of posting, read FOR UPDATE. The movement written
  -- is counted_qty - posted_qty_before. See the header.
  posted_qty_before DECIMAL(12,3) NULL,
  variance_qty      DECIMAL(12,3) NULL,

  -- Snapshotted at post from average_cost, falling back to last_cost. A count
  -- states quantity and never restates cost -- GRV posting stays the only
  -- writer of average_cost, exactly as purchaseReversal refuses to unwind it.
  unit_cost_excl    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Which units, for a serial-tracked product. Counting a quantity alone would
  -- break invariant S1 in 027 -- the serial rows would still claim in_stock.
  serial_ids        JSON         NULL,

  counted_at        DATETIME     NULL,
  counted_by        VARCHAR(120) NULL,
  note              VARCHAR(190) NULL,

  -- The movement this line produced. NULL where the line balanced: a
  -- zero-variance line writes no movement, because a movement of 0 is noise in
  -- the one table people read to answer what happened to a product.
  movement_id       BIGINT UNSIGNED NULL,

  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- A product cannot appear twice on one sheet. This is the commonest source of
  -- a double-posted variance, and it is cheaper to refuse it in the schema.
  UNIQUE KEY uq_take_line_product (stock_take_id, product_id),
  KEY ix_takeline_sheet (stock_take_id, line_number),
  KEY ix_takeline_product (product_id),
  CONSTRAINT fk_takeline_sheet   FOREIGN KEY (stock_take_id) REFERENCES stock_takes (id) ON DELETE CASCADE,
  -- RESTRICT, matching stock_movements: a product that has been counted has
  -- history, and deleteProduct already archives on reference.
  CONSTRAINT fk_takeline_product FOREIGN KEY (product_id)    REFERENCES products (id)    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Numbering ─────────────────────────────────────────────────────────
-- INSERT IGNORE so a site that already has the row keeps its own prefix and
-- next number rather than being reset to 1 on a re-run.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('stock_take', 'STK', 1, 6, 'none');

-- ── 4. Where a variance lands in the ledger ──────────────────────────────
--
-- Account 5100 Stock adjustments was seeded by 045 and has been sitting there
-- unmapped ever since, because until now nothing wrote an adjustment except a
-- document void -- and a void reverses the journal the document already wrote.
-- A standalone count has no such partner, so it needs its own key:
--
--   write-off   DEBIT 5100 stock adjustments / CREDIT stock control
--   write-on    DEBIT stock control / CREDIT 5100 stock adjustments
--
-- Guarded with NOT EXISTS rather than INSERT IGNORE, and that is not a style
-- choice: uq_mapping is (mapping_key, ref_id), and MySQL treats NULLs as
-- DISTINCT in a unique index -- so the default row for a key collides with
-- nothing and IGNORE would never fire. Re-running this file by hand would stack
-- up duplicate rows, and resolveAccount takes LIMIT 1 of whichever it finds.
--
-- The guard also means a site that has already pointed this key at an account
-- of its own keeps that choice.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'stock_adjustment', NULL, a.id
  FROM gl_accounts a
 WHERE a.account_code = '5100'
   AND NOT EXISTS (
     SELECT 1 FROM gl_mappings m
      WHERE m.mapping_key = 'stock_adjustment' AND m.ref_id IS NULL
   );
