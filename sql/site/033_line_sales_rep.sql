-- ─────────────────────────────────────────────────────────────────────────
-- A clerk per LINE, not per document.
--
-- sales_documents.user_id already records who captured the document. That is
-- a different question from who SOLD each item, and on a counter where two
-- assistants serve one customer off one invoice, only the per-line answer can
-- pay the right commission — which is the whole reason sales_reps carries a
-- commission_pct.
--
-- Nullable, because most lines have no rep at all: a till sale rung up by
-- whoever was standing there is not a commission event, and forcing a value
-- would invent one.
--
-- SET NULL on delete, matching customers.rep_id in 012: a rep who leaves is
-- removed, and last year's invoice must stay readable rather than vanish with
-- them.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_document_lines
  ADD COLUMN sales_rep_id INT UNSIGNED NULL AFTER department_id;

ALTER TABLE sales_document_lines
  ADD CONSTRAINT fk_sales_line_rep
    FOREIGN KEY (sales_rep_id) REFERENCES sales_reps (id) ON DELETE SET NULL;

-- Commission reporting reads "every line for this rep in a period", which
-- without this index is a full scan of the largest table in the database.
ALTER TABLE sales_document_lines
  ADD KEY ix_sales_line_rep (sales_rep_id);
