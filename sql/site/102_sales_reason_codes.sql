-- ─────────────────────────────────────────────────────────────────────────
-- Void and return reasons: the two questions a shop actually asks its till.
--
-- ── THE GAP THIS FILLS ───────────────────────────────────────────────────
--
-- Both events already demand a reason and refuse to proceed without one. The
-- till has asked since the day it shipped:
--
--   VoidModal    reason.trim().length >= 3
--   RefundPad    a return needs a reason
--   voidDocument   Give a reason for the void
--   createCreditNote  Give a reason for the credit
--
-- So the discipline is there and the data is being captured. What is missing is
-- that every one of those reasons is free text, which means nobody can group
-- them. "damaged", "Damaged", "dmgd" and "damage - customer brought back" are
-- four distinct reasons as far as a report is concerned, and the void-history
-- template can only list them one per line. The question the columns exist to
-- answer — what are we losing to voids, and why do goods come back — cannot be
-- answered by the thing recording the answer.
--
-- ── WHY TWO TABLES AND NOT ONE WITH A SCOPE ──────────────────────────────
--
-- The vocabularies do not overlap. Nothing a customer says when they bring
-- something back is ever why a cashier voids a sale, and nothing that makes a
-- cashier void is ever why goods come back. Faulty is not a void reason;
-- rang up twice is not a return reason. One table with a scope column would
-- spend its life being filtered back into these two, and one mis-set scope puts
-- the wrong word in front of a cashier mid-sale.
--
-- Two tables also keeps each list SHORT, which is the property that decides
-- whether a picker gets used honestly or whether everyone taps the first row.
--
-- ── WHY THE CODE COLUMNS ARE NULLABLE AND STAY THAT WAY ──────────────────
--
-- Every void and every credit note that already exists carries free text and no
-- code. Back-filling one would be inventing a fact about trade that already
-- happened — nobody can now say whether a March void that reads "mistake" was a
-- wrong item or a double ring. NULL means nobody was asked, which is the truth,
-- and a report showing those rows as Not recorded is more honest than a report
-- confidently mis-grouping them.
--
-- The free-text columns stay and stay useful. The picker answers "which of the
-- things that happen was this", the note answers "what actually happened this
-- time" — and only the first is groupable, so only the first is mandatory.
--
-- ── WHERE THE RETURN REASON LANDS ────────────────────────────────────────
--
-- A void writes sales_documents.cancel_reason, which has existed since 015. A
-- credit note has NO dedicated column: createCreditNote puts its reason in
-- internal_note, next to a generated caption in notes. That is why this file
-- adds two FK columns to one table rather than one to each of two — a credit
-- note IS a sales_documents row, doc_type credit_sale.
--
-- Only ever one of the two is set on a given row: a cancelled sale has a void
-- reason, a credit note has a return reason. Neither is populated on an
-- ordinary finalised sale, which is the overwhelming majority of the table, so
-- both indexes stay small.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Void reasons ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_void_reasons (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Short handle a person picks and a report groups by: WRONG-ITEM, TEST.
  code        VARCHAR(24)  NOT NULL,
  name        VARCHAR(120) NOT NULL,

  -- Whether the till may also take a free-text note beside the code. Off for a
  -- reason that says everything already, on for the ones that never do.
  allows_note TINYINT(1)   NOT NULL DEFAULT 1,

  -- Retired rather than deleted, for the same reason an adjustment reason is:
  -- history naming it has to keep reading correctly.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  sort_order  INT          NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_void_reason_code (code),
  KEY ix_void_reason_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Return reasons ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales_return_reasons (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  code        VARCHAR(24)  NOT NULL,
  name        VARCHAR(120) NOT NULL,

  allows_note TINYINT(1)   NOT NULL DEFAULT 1,

  -- Whether goods coming back for this reason can be sold again. A change of
  -- mind returns sellable stock to the shelf; a faulty unit does not. Nothing
  -- reads this yet — the credit note writes stock back either way, as it always
  -- has. It is recorded now because it is the fact the person handling the
  -- return knows at the moment they pick the reason, and asking them again
  -- later is asking them to remember. A future write-off flow reads it.
  restocks    TINYINT(1)   NOT NULL DEFAULT 1,

  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  sort_order  INT          NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_return_reason_code (code),
  KEY ix_return_reason_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Seed both lists ───────────────────────────────────────────────────
-- INSERT IGNORE rather than NOT EXISTS on the whole table: a site that has
-- already added reasons of its own must still receive any new standard one, and
-- the unique code makes each row arrive at most once.
--
-- These are the words a shop floor actually uses, not a taxonomy. A manager
-- renames rather than invents, and a list of six gets read — a list of twenty
-- gets scrolled past to whatever is on top.
INSERT IGNORE INTO sales_void_reasons (code, name, allows_note, sort_order) VALUES
  ('WRONG-ITEM',  'Wrong item rung up',       0, 10),
  ('WRONG-QTY',   'Wrong quantity or price',  0, 20),
  ('DOUBLE-RUNG', 'Rung up twice',            0, 30),
  ('CUST-LEFT',   'Customer changed mind',    0, 40),
  ('PAY-FAILED',  'Payment did not go through', 0, 50),
  ('TRAINING',    'Training or test sale',    0, 60),
  ('OTHER',       'Something else',           1, 90);

INSERT IGNORE INTO sales_return_reasons (code, name, allows_note, restocks, sort_order) VALUES
  ('FAULTY',      'Faulty or damaged',      1, 0, 10),
  ('NOT-AS-DESC', 'Not as described',       1, 1, 20),
  ('WRONG-SIZE',  'Wrong size or colour',   0, 1, 30),
  ('WRONG-ITEM',  'Wrong item supplied',    0, 1, 40),
  ('CHANGED-MIND','Changed their mind',     0, 1, 50),
  ('EXPIRED',     'Past its date',          1, 0, 60),
  ('OTHER',       'Something else',         1, 1, 90),
  -- Nothing came back and nobody chose this. An invoice correction reverses the
  -- original through the ordinary credit path, so it needs a return reason to
  -- satisfy the column — but it is not a return, and letting it borrow FAULTY
  -- or OTHER would put corrections in the returns report as goods that came
  -- back. sort_order 999 keeps it last in the setup list, where a manager can
  -- see it exists without it competing for a cashier's attention.
  ('CORRECTION',  'Invoice correction',     1, 1, 999);

-- ── 4. The two columns on sales_documents ────────────────────────────────
--
-- ON DELETE SET NULL, matching the adjustment reason FK and for the same
-- reason: a reason is a LABEL, and retiring one must never be blocked by the
-- documents that used it. In practice deleteReason retires anything used, so
-- this fires only when a reason nothing referenced is genuinely deleted — but
-- the free text stays on the row either way, so the document still reads.
--
-- Guarded on information_schema: ADD COLUMN is not re-runnable on its own, and
-- a second pass would error on the duplicate rather than pass over it.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_documents'
      AND COLUMN_NAME = 'cancel_reason_id') = 0,
  'ALTER TABLE sales_documents
     ADD COLUMN cancel_reason_id INT UNSIGNED NULL AFTER cancel_reason,
     ADD KEY ix_sales_cancel_reason (cancel_reason_id),
     ADD CONSTRAINT fk_sales_cancel_reason FOREIGN KEY (cancel_reason_id)
       REFERENCES sales_void_reasons (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sales_documents'
      AND COLUMN_NAME = 'return_reason_id') = 0,
  'ALTER TABLE sales_documents
     ADD COLUMN return_reason_id INT UNSIGNED NULL AFTER cancel_reason_id,
     ADD KEY ix_sales_return_reason (return_reason_id),
     ADD CONSTRAINT fk_sales_return_reason FOREIGN KEY (return_reason_id)
       REFERENCES sales_return_reasons (id) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
