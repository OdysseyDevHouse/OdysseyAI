-- ============================================================================
-- 117 — asset_code BECOMES document_number
--
-- A third migration in this pair, because 115 and 116 are both applied and a
-- migration is recorded by filename.
--
-- WHY
--
-- verifySequence() has TWO hard-coded expectations of any table registered in
-- OWN_TABLE_TYPES, not one. 116 satisfied the first by adding `status`. The
-- second is the column name itself: the function counts
-- `WHERE document_number IS NOT NULL`, so a table calling it anything else fails
-- the query outright.
--
-- Renaming rather than adding a second column, because there is only one fact
-- here. `asset_code` and a `document_number` beside it would be two names for the
-- same string, and they would eventually disagree.
--
-- The name is honest anyway: AST000001 IS this record number, issued from
-- document_sequences by the same nextDocumentNumber() every other numbered thing
-- in the system uses. Calling it a code obscured that it was already a document
-- number in everything but spelling.
--
-- CHANGE rather than RENAME COLUMN: MariaDB supports both, but CHANGE restates
-- the definition, which keeps this file readable as the whole truth about the
-- column rather than a diff against a file somebody has to go and find.
-- ============================================================================

ALTER TABLE customer_assets
  CHANGE COLUMN IF EXISTS asset_code document_number VARCHAR(32) NULL;

-- The unique key survives the rename automatically, but it is still named
-- uq_asset_code. Left alone deliberately: renaming an index changes nothing about
-- what it enforces, and a migration that churns index names for tidiness is a
-- migration that can fail on a site where one was already renamed by hand.
