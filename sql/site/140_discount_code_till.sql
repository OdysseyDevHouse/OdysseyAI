-- Discount codes at the till.
--
-- The redemption ledger must be able to point at a SALES DOCUMENT, because at
-- a counter there is no online order to hang the use on. order_id loosens to
-- NULL rather than growing a second ledger table: one ledger, two kinds of
-- evidence, and every existing query (per-customer limits, codeStats) keeps
-- reading the same rows.
ALTER TABLE discount_code_uses
  MODIFY COLUMN order_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS document_id INT UNSIGNED NULL AFTER order_id,
  -- One redemption per sale, mirroring uq_use_per_order (both allow NULLs, so
  -- the two kinds of evidence never collide with each other).
  ADD UNIQUE KEY IF NOT EXISTS uq_use_per_document (document_id);

-- MariaDB has no IF NOT EXISTS for a named constraint — drop first, re-add.
ALTER TABLE discount_code_uses DROP FOREIGN KEY IF EXISTS fk_use_document;
ALTER TABLE discount_code_uses
  ADD CONSTRAINT fk_use_document
    FOREIGN KEY (document_id) REFERENCES sales_documents (id) ON DELETE CASCADE;

-- What the sale remembers, mirroring online_orders (073): the money lives on
-- the LINES (discount_incl per line); these carry the WHY — the code's id
-- while it exists, and the typed word forever.
ALTER TABLE sales_documents
  ADD COLUMN IF NOT EXISTS discount_code_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS discount_code VARCHAR(40) NOT NULL DEFAULT '',
  ADD KEY IF NOT EXISTS ix_sales_doc_discount_code (discount_code_id);

ALTER TABLE sales_documents DROP FOREIGN KEY IF EXISTS fk_sales_doc_discount_code;
ALTER TABLE sales_documents
  ADD CONSTRAINT fk_sales_doc_discount_code
    FOREIGN KEY (discount_code_id) REFERENCES discount_codes (id) ON DELETE SET NULL;
