-- ── Which job a purchase line was bought for (28) ───────────────────────────
--
-- One nullable column on somebody elses table, and it is the one honest
-- exception to the boundary this module has otherwise kept.
--
-- ── WHY NO EXISTING COLUMN WOULD DO ─────────────────────────────────────────
--
-- purchase_document_lines has no free-form reference, no note, and no source
-- pair that is free to use:
--
--   reference and notes are on the HEADER, and one purchase order serves many
--   jobs, so a header link answers the wrong question;
--
--   source_line_id exists but is FK-bound to another purchase line, for
--   supplier returns, and overloading it would make a return of a job part
--   indistinguishable from a job part.
--
-- There is no way to record a job on a purchase line without this column.
--
-- ── THE PRECEDENT IS EXACT ──────────────────────────────────────────────────
--
-- stock_transfer_lines already carries job_card_line_id, added by 110 and
-- written by issueParts at jobParts.ts:351. This is the same relationship on
-- the other document, and 110s reasoning transfers verbatim: the link goes on
-- the LINE because one order carries several job lines and one job line may be
-- ordered across two orders.
--
-- What must NOT follow from this column: purchasing does not otherwise learn
-- about jobs. saveOrder grows no job parameter, and the decision logic lives on
-- job_part_requests. The job module raises no purchase order and writes no
-- stock movement — it records a request and reads what purchasing did, which is
-- the same discipline that kept finaliseDocument() the only posting engine.

ALTER TABLE purchase_document_lines
  ADD COLUMN IF NOT EXISTS job_card_line_id INT UNSIGNED NULL AFTER product_id;

ALTER TABLE purchase_document_lines
  ADD KEY IF NOT EXISTS ix_pdline_job_line (job_card_line_id);

-- SET NULL, not CASCADE, matching 110: a received purchase line is a record of
-- goods that really arrived and must outlive the job line it was raised for.
ALTER TABLE purchase_document_lines
  ADD FOREIGN KEY IF NOT EXISTS fk_pdline_job_line (job_card_line_id)
    REFERENCES job_card_lines (id) ON DELETE SET NULL;

-- ── THE TRAP THIS COLUMN SITS IN ────────────────────────────────────────────
--
-- Written here because it is a property of the table, not of the feature, and
-- the next person to touch this will be reading the schema.
--
-- saveOrder REWRITES ITS LINES WHOLESALE. purchaseDocuments.ts:511 does
--
--   DELETE FROM purchase_document_lines WHERE document_id = ?
--
-- and then re-INSERTs every line. So a buyer who edits an issued order to fix
-- one quantity blanks job_card_line_id on EVERY line of it, and nothing reports
-- that: the order still exists, the parts still arrive, and no job knows they
-- were its.
--
-- Therefore job_card_line_id must be carried on OrderLineInput and re-supplied
-- on every save. The reconcile bucket "ordered, but the purchase line has
-- vanished" is what catches it if this is ever got wrong.
