-- ─────────────────────────────────────────────────────────────────────────
-- Stock transfers: moving goods between locations inside one site.
--
-- 025_stock_locations.sql created the piles and gave every movement a place.
-- It left one gap: the ONLY way stock could enter a non-main location was a
-- GRV, and nothing could move it afterwards. Stock received into a back
-- warehouse was invisible to the till and stuck there.
--
-- This is what unsticks it.
--
-- ── WHY A DOCUMENT AND NOT TWO ADJUSTMENTS ───────────────────────────────
--
-- A transfer could be expressed as an adjustment out of one pile and another
-- into a second. That would satisfy every invariant and lose the thing that
-- matters: nobody could later ask "what left the warehouse on Tuesday, who
-- sent it, and did it arrive". Two unrelated adjustments record the arithmetic
-- and throw away the event.
--
-- So a transfer is a document, numbered like every other, and the two
-- movements it writes both carry its id.
--
-- ── THE PAIRED MOVEMENT RULE ─────────────────────────────────────────────
--
-- Every transfer line writes EXACTLY TWO movements:
--
--   transfer_out   -qty   against the FROM location
--   transfer_in    +qty   against the TO location
--
-- They are equal and opposite, so:
--
--   • products.stock_on_hand does not change — invariant (A) holds trivially,
--     because the site still owns exactly what it owned
--   • each pile changes by its own half — invariant (B)
--   • the piles still sum to the total — invariant (C)
--
-- A transfer that wrote only one side would break (C) instantly, which is
-- precisely why both are written inside one transaction by one function.
--
-- ── IN TRANSIT IS NOT MODELLED, DELIBERATELY ─────────────────────────────
--
-- A van between two branches holds stock that has left one pile and not
-- arrived at the other. Modelling that needs a third holding location and a
-- two-step confirm, and it turns every transfer into a workflow with a state
-- machine.
--
-- This posts both halves at once: stock moves the moment the transfer is
-- posted. That is correct for the case this is built for — rooms in one
-- building, where the walk takes a minute. A site that genuinely needs goods
-- in transit should model the van AS a location and do two transfers, which
-- this already supports and which keeps every figure true at every moment.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. The transfer itself ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Issued from document_sequences like every other document, so a transfer
  -- can be quoted, filed and found by number.
  document_number VARCHAR(32) NULL,
  document_date  DATE         NOT NULL,

  from_location_id INT UNSIGNED NOT NULL,
  to_location_id   INT UNSIGNED NOT NULL,

  --   draft   being built, nothing has moved
  --   posted  both halves written, stock has moved
  --   void    reversed, with a third and fourth movement putting it back
  --
  -- No in-transit state. See the header.
  status         ENUM('draft','posted','void') NOT NULL DEFAULT 'draft',

  reference      VARCHAR(60)  NULL,   -- their delivery note, a van registration
  note           VARCHAR(400) NULL,

  posted_at      DATETIME     NULL,
  void_reason    VARCHAR(190) NULL,
  voided_at      DATETIME     NULL,

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_transfer_number (document_number),
  KEY ix_transfer_date (document_date, id),
  KEY ix_transfer_status (status, document_date),
  KEY ix_transfer_from (from_location_id, document_date),
  KEY ix_transfer_to (to_location_id, document_date),
  -- RESTRICT both ways: a location named by a transfer cannot be deleted, for
  -- the same reason one named by a movement cannot.
  CONSTRAINT fk_transfer_from FOREIGN KEY (from_location_id) REFERENCES stock_locations (id) ON DELETE RESTRICT,
  CONSTRAINT fk_transfer_to   FOREIGN KEY (to_location_id)   REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. What is on it ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  transfer_id    INT UNSIGNED NOT NULL,
  line_number    SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  product_id     INT UNSIGNED NOT NULL,
  -- Copied at capture, like every other document line: the product may be
  -- renamed later and this has to keep saying what was actually moved.
  product_code   VARCHAR(40)  NULL,
  description    VARCHAR(190) NOT NULL,

  qty            DECIMAL(12,3) NOT NULL,

  -- Cost at the moment of transfer, carried onto both movements so stock
  -- valuation per location is answerable. A transfer does NOT change
  -- average_cost — the goods are the same goods, in a different room. Only a
  -- GRV moves cost, and that rule is not weakened here.
  unit_cost_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_tline_transfer (transfer_id, line_number),
  KEY ix_tline_product (product_id),
  CONSTRAINT fk_tline_transfer FOREIGN KEY (transfer_id) REFERENCES stock_transfers (id) ON DELETE CASCADE,
  -- RESTRICT, matching stock_movements: a product that has been transferred
  -- has history, and deleteProduct already archives on reference.
  CONSTRAINT fk_tline_product  FOREIGN KEY (product_id)  REFERENCES products (id)        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Numbering ─────────────────────────────────────────────────────────
-- INSERT IGNORE so a site that already has the row keeps its own prefix and
-- next number rather than being reset to 1 on a re-run.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('stock_transfer', 'TRF', 1, 6, 'none');
