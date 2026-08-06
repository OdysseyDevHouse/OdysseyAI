-- ─────────────────────────────────────────────────────────────────────────
-- "Parked" becomes "Saved".
--
-- Park is forecourt language. What the button actually does is SAVE a basket
-- so it can be picked up again — which is the word every till operator already
-- uses for it, and the word they look for when they cannot find the sale they
-- put down five minutes ago.
--
-- Renamed in the database rather than mapped through a label table, for the
-- reason 022 gives: a stored value that disagrees with the product is a
-- mapping every future reader has to learn before they can trust a query they
-- wrote by hand.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────
--
--   sales_documents.status   'parked' → 'saved'
--
-- ── WHAT DELIBERATELY DOES NOT ───────────────────────────────────────────
--
--   Nothing else. Unlike 'void'/'credit_note' in 022, 'parked' was never
--   written into the free-text columns that carry document strings —
--   stock_movements.source and document_audit.action only ever see a doc type
--   or a posting action, and a parked sale posts nothing by definition. Both
--   were checked; neither needs a companion UPDATE.
--
-- ── ORDER MATTERS ────────────────────────────────────────────────────────
--
-- Widen the ENUM to hold both values, move the data, then drop the old one.
-- Changing the ENUM and the data in one statement would silently blank every
-- row whose value is not yet in the new definition.
--
-- DDL auto-commits, so every step is written to be re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Widen, so both old and new values are legal at once ───────────────
ALTER TABLE sales_documents
  MODIFY COLUMN status ENUM('draft','parked','saved','issued','finalised','cancelled')
    NOT NULL DEFAULT 'draft';

-- ── 2. Move the data ─────────────────────────────────────────────────────
UPDATE sales_documents SET status = 'saved' WHERE status = 'parked';

-- ── 3. Narrow, so the old value can never be written again ───────────────
ALTER TABLE sales_documents
  MODIFY COLUMN status ENUM('draft','saved','issued','finalised','cancelled')
    NOT NULL DEFAULT 'draft';
