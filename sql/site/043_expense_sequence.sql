-- The numbering sequence for expenses.
--
-- Separate from 042 because that migration is already applied: schema_migrations
-- records a file by NAME, so editing an applied file silently does nothing and
-- the sequence would exist only on databases created afterwards.
--
-- INSERT IGNORE so it is safe on a site that somehow already has the row.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('expense', 'EXP', 1, 6, 'none');
