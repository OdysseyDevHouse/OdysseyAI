-- ============================================================================
-- 136 — layby_number BECOMES document_number
--
-- WHY
--
-- Laybys are numbered from document_sequences ('layby', prefix LAY — seeded in
-- 024) by the same nextDocumentNumber() as every other numbered thing, but the
-- type was never registered in OWN_TABLE_TYPES. verifySequence() therefore fell
-- back to counting layby numbers in sales_documents, where none of them exist,
-- and reported every layby ever issued as MISSING — the one figure the check
-- exists to prove is zero.
--
-- verifySequence() has TWO hard-coded expectations of any table registered in
-- OWN_TABLE_TYPES (see 116/117, which did this same dance for customer_assets):
-- a `status` column whose void value is 'cancelled' — laybys has that already —
-- and the column name `document_number` itself, because the function counts
-- `WHERE document_number IS NOT NULL`.
--
-- Renaming rather than adding a second column, because there is only one fact
-- here: LAY000123 IS this record's document number. Two columns for the same
-- string would eventually disagree.
--
-- CHANGE rather than RENAME COLUMN: CHANGE restates the definition, which keeps
-- this file readable as the whole truth about the column.
-- ============================================================================

ALTER TABLE laybys
  CHANGE COLUMN IF EXISTS layby_number document_number VARCHAR(32) NULL;

-- The unique key survives the rename automatically but is still named
-- uq_layby_number. Left alone deliberately — renaming an index changes nothing
-- about what it enforces (see 117's note on why churning index names is a risk,
-- not a tidy-up).
