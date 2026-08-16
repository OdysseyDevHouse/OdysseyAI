-- ─────────────────────────────────────────────────────────────────────────
-- Voids taken off a DRAFT sale: what came off the screen before anyone paid.
--
-- ── VOID IS NOT CANCEL ───────────────────────────────────────────────────
--
-- These are two different events and this schema exists because they are.
--
--   CANCEL  a FINALISED sale is reversed. Stock goes back, money comes off a
--           card or out of a drawer, the document keeps its number and its
--           status becomes cancelled. Recorded on sales_documents itself:
--           cancel_reason, cancel_reason_id, cancelled_at, cancelled_by_user_id
--           (015, renamed by 029, reason-coded by 102).
--
--   VOID    something is taken off a sale that was NEVER finalised. The
--           customer changed their mind at the counter, the cashier rang the
--           wrong thing, a line was scanned twice. Nothing posted, so there is
--           nothing to reverse and no document to write a reason onto.
--
-- The legacy system used void for the second meaning, which is why the first
-- one was renamed to cancel rather than the other way round. Conflating them
-- again in the schema would undo that: a report asking what we lost to voids
-- would answer with reversed invoices, which is a different question with a
-- different answer.
--
-- ── WHY A TABLE AND NOT sales_documents ──────────────────────────────────
--
-- Because there is usually no row to write to. A retail counter sale lives
-- entirely in the browser until it is tendered — document_id is NULL for most
-- of what lands here, and that is the normal case, not the edge case. Only a
-- parked basket, a hospitality tab or a seated table has a draft row at the
-- moment a line is voided off it.
--
-- The same argument the undo trail makes in (pos)/pos/actions.ts applies with
-- more force here: nothing posted means nothing an auditor can reconcile
-- against, so it is written down HERE or it is not written down at all. An
-- honest mis-scan and a cashier ringing goods up, pocketing the cash and
-- voiding the line produce an identical absence in sales_documents. This table
-- is the only place the difference can ever show up.
--
-- ── WHY NOT THE ACTIVITY LOG ─────────────────────────────────────────────
--
-- The undo trail goes to activity_log and that was right for it: undo is rare,
-- capped by a shop setting, and asked about one row at a time. Voids are
-- neither rare nor asked about one at a time. The question is "what are we
-- losing to voids, by reason, by operator, by till, this month" — a GROUP BY
-- with a SUM over a value column. activity_log keeps its detail as JSON in
-- `changes`, which cannot be summed, and the log's own header says why high
-- volume till traffic is kept out of it: it buries what the log is for.
--
-- ── THE THREE KINDS ──────────────────────────────────────────────────────
--
-- void_type is the distinction the cashier makes with their hands, and the
-- report has to keep them apart because they mean different things:
--
--   item   the minus key took ONE unit off a line that still exists
--   line   the Void key took a whole line off the sale
--   sale   the basket was abandoned with lines in it
--
-- A minus press on a single-unit line removes the line (see stepQty in
-- lib/basket.ts) — that is recorded as `item`, because item is what the cashier
-- did. What the reducer then did to the array is an implementation detail, and
-- filing it as a line void would silently inflate line voids on exactly the
-- shops that sell single units.
--
-- ── WHY A SALE VOID ALSO WRITES ITS LINES ────────────────────────────────
--
-- Abandoning a basket of four writes five rows: one `sale` and four `line`,
-- sharing a group_id. Without the line rows a product-level void report cannot
-- see the goods that went out with the basket, which is where the value
-- actually is. With only line rows nobody can tell four separate mistakes from
-- one abandoned sale.
--
-- So both are recorded and group_id is what tells them apart. A report totalling
-- value_incl must therefore filter — either void_type = 'sale' OR
-- void_type != 'sale', never both, or every abandoned basket counts twice. The
-- catalog source built on this defaults to excluding the `sale` rollup for
-- exactly that reason.
--
-- ── WHAT IS DELIBERATELY NOT A FOREIGN KEY ───────────────────────────────
--
-- user_id, terminal_id and shift_id are plain columns, following shifts (016)
-- rather than sales_documents (015). An audit row that cannot be written
-- because a terminal was deleted is an audit row that does not exist, and the
-- event it describes has already happened. reason_id IS a FK, ON DELETE SET
-- NULL, matching cancel_reason_id: retiring a reason must never be blocked by
-- the history naming it, and reason_code below keeps the row readable anyway.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pos_void_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the cashier did. See THE THREE KINDS above.
  void_type     ENUM('item','line','sale') NOT NULL,

  -- Ties the `sale` rollup to the `line` rows written with it. NULL on an
  -- ordinary standalone item or line void, which is the majority of the table.
  group_id      CHAR(36)        NULL,

  -- The reason picked, from the shop list managed at /setup/sales-reasons.
  -- NULL only if the reason was later hard-deleted; the code below survives it.
  reason_id     INT UNSIGNED    NULL,

  -- Denormalised on purpose. A report grouping by reason must keep reading
  -- correctly after a reason is renamed or deleted, and this is what the row
  -- meant AT THE TIME. The join to sales_void_reasons gives the current name;
  -- this gives the historical one.
  reason_code   VARCHAR(24)     NULL,

  -- The free text beside the code, when the reason allows one.
  note          VARCHAR(500)    NULL,

  -- The draft this came off, when there was one. NULL is the normal case for a
  -- retail counter sale, which never touches the database before it is paid.
  document_id   INT UNSIGNED    NULL,

  -- What was voided. product_id is NULL for a non-stock line (a manual amount,
  -- an open department key) and for the `sale` rollup row.
  product_id    INT UNSIGNED    NULL,
  product_code  VARCHAR(64)     NULL,

  -- As it read on the line. Denormalised for the same reason as reason_code: a
  -- product renamed or deleted must not blank out the void report.
  -- On a `sale` row this is the basket description, eg "4 lines".
  description   VARCHAR(255)    NOT NULL,

  -- How much came off. 1 for a plain minus press; the whole line quantity for a
  -- line void; the basket line count for a `sale` row, which is why it is
  -- DECIMAL and not an integer.
  qty           DECIMAL(12,3)   NOT NULL DEFAULT 0,

  -- What it was worth, VAT in, BEFORE any line discount — the same figure the
  -- undo trail records and the same one documentMath starts from. What the
  -- customer would have been asked for is what makes a pattern worth reading.
  value_incl    DECIMAL(12,4)   NOT NULL DEFAULT 0,

  -- Who, where, and in which shift. The PIN OPERATOR, not the browser session:
  -- a manager who signed the till in at seven is not the person who voided a
  -- line at four, and a trail naming them accuses the wrong person.
  user_id       INT UNSIGNED    NULL,
  user_name     VARCHAR(120)    NULL,
  terminal_id   INT UNSIGNED    NULL,
  terminal_code VARCHAR(32)     NULL,
  shift_id      INT UNSIGNED    NULL,

  -- When the cashier did it, which is not when the row arrived: an offline till
  -- banks its voids on reconnect, so voided_at is sent by the client and
  -- created_at is stamped by the server. A cash-up reconciles on the first.
  voided_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The report's own axis: everything is "voids between these dates", then
  -- grouped. Leading on voided_at is what keeps a month scan off a full table.
  KEY ix_void_when (voided_at, void_type),
  KEY ix_void_reason (reason_id, voided_at),
  KEY ix_void_user (user_id, voided_at),
  KEY ix_void_terminal (terminal_id, voided_at),
  KEY ix_void_shift (shift_id),
  KEY ix_void_product (product_id, voided_at),
  KEY ix_void_group (group_id),
  KEY ix_void_document (document_id),

  CONSTRAINT fk_void_event_reason FOREIGN KEY (reason_id)
    REFERENCES sales_void_reasons (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
