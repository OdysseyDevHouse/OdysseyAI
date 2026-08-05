-- ─────────────────────────────────────────────────────────────────────────
-- Storing what we call things.
--
-- The screens were renamed first and mapped the old stored values through a
-- label table. That works, but it leaves the database saying one thing and the
-- product saying another — and every future reader has to learn the mapping
-- before they can trust a query they write by hand.
--
-- Done now because the cost is a handful of rows on two development sites. The
-- same change against a live store's year of history is a migration nobody
-- wants to run.
--
-- ── WHAT CHANGES ─────────────────────────────────────────────────────────
--
--   sales_documents.doc_type  'credit_note' → 'credit_sale'
--   sales_documents.status    'void'        → 'cancelled'   (merged)
--   document_sequences.doc_type, stock_movements.source, document_audit.action
--                             the same strings, where they carry a doc type
--
-- ── WHAT DELIBERATELY DOES NOT ───────────────────────────────────────────
--
--   customer_transactions.doc_type  KEEPS 'credit_note'
--   supplier_transactions.doc_type  KEEPS 'credit_note'
--
-- Those are LEDGER documents: an adjustment posted directly to an account,
-- which is what a credit note actually is in accounting. The sales-side thing
-- is reversing a sale, and calling both by one name is the confusion this
-- whole rename exists to remove. Two tables, two meanings, two words.
--
-- ── ORDER MATTERS ────────────────────────────────────────────────────────
--
-- Each ENUM is widened to hold BOTH values, then the data is moved, then the
-- old value is dropped. Changing the ENUM and the data in one statement would
-- silently blank every row whose value is not yet in the new definition.
--
-- DDL auto-commits, so every step is written to be re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Widen, so both old and new values are legal at once ───────────────
ALTER TABLE sales_documents
  MODIFY COLUMN doc_type ENUM('quote','sales_order','invoice','credit_note','credit_sale') NOT NULL;

ALTER TABLE sales_documents
  MODIFY COLUMN status ENUM('draft','parked','issued','finalised','void','cancelled')
    NOT NULL DEFAULT 'draft';

-- ── 2. Move the data ─────────────────────────────────────────────────────
UPDATE sales_documents SET doc_type = 'credit_sale' WHERE doc_type = 'credit_note';

-- 'void' and 'cancelled' merge into one state. They always meant the same
-- thing — a posted document undone — and only 'void' was ever written.
UPDATE sales_documents SET status = 'cancelled' WHERE status = 'void';

-- The numbering row keys off doc_type. Its prefix stays CRN: the customer is
-- holding paper that says CRN000009, and a document number is a promise, not
-- a label we get to restyle.
UPDATE document_sequences SET doc_type = 'credit_sale' WHERE doc_type = 'credit_note';

-- Free-text columns carrying the same strings.
UPDATE stock_movements SET source = 'credit_sale' WHERE source = 'credit_note';
UPDATE stock_movements SET source = 'cancelled'   WHERE source = 'void';

-- ── 3. Narrow, so the old value can never be written again ───────────────
ALTER TABLE sales_documents
  MODIFY COLUMN doc_type ENUM('quote','sales_order','invoice','credit_sale') NOT NULL;

ALTER TABLE sales_documents
  MODIFY COLUMN status ENUM('draft','parked','issued','finalised','cancelled')
    NOT NULL DEFAULT 'draft';
