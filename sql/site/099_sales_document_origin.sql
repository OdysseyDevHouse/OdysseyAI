-- Where a document was captured: at a till, or in the back office.
--
-- This was inferred until now. `terminal_id IS NULL` meant "back office", and
-- both invoice numbering (numberSegmentsFor) and the till-claim guard in
-- salesPosting read it that way. The inference held only because a back-office
-- invoice never recorded a till at all.
--
-- It does now. An invoice captured on a machine that is claimed to a till
-- records that till, so "who rang this up, and where" has an answer on every
-- document rather than only on the ones that came from a register. That leaves
-- the old inference with nothing to stand on, which is what this column is for:
-- the discriminator becomes explicit, and terminal_id goes back to meaning only
-- what it says — which machine the document was captured on.
--
-- The two readers behave differently on purpose. A back-office invoice records
-- its till but still numbers from the SHARED run, because its number is printed
-- on something a customer holds and moving those onto a till's run would change
-- the numbers a store has been issuing.
ALTER TABLE sales_documents
  ADD COLUMN origin ENUM('till','back_office') NOT NULL DEFAULT 'till'
    COMMENT 'where captured; back_office numbers from the shared run even with a terminal_id'
    AFTER terminal_code;

-- Backfill reproduces the old inference exactly, so no document that already
-- exists changes how it behaves, and nothing is renumbered.
--
-- One honest imprecision: a POS machine that was never claimed to a till also
-- posted with terminal_id NULL, so those sales are labelled back_office here.
-- No surviving column separates them from a genuine back-office capture. They
-- were numbered from the shared run at the time and this label keeps them
-- there, which is the property that has to hold — the label is the less
-- accurate part of a row that is otherwise unchanged.
UPDATE sales_documents SET origin = 'back_office' WHERE terminal_id IS NULL;
