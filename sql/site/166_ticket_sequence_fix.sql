-- ── Correcting the ticket sequence seed ─────────────────────────────────────
--
-- 165 seeded the TK sequence PER TERMINAL:
--
--   INSERT IGNORE INTO document_sequences (terminal_id, doc_type, ...)
--   SELECT id, 'ticket', 'TK', 1, 6 FROM terminals;
--
-- That is wrong twice over, and a new file rather than an edit because a
-- migration is recorded by FILENAME — editing 165 would change nothing on a
-- site that has already run it.
--
-- ── WHY IT WAS WRONG ────────────────────────────────────────────────────────
--
-- 1. A site with NO terminals got no sequence at all, so every ticket there
--    would be created unnumbered. Site 2 has none: it is a back-office site
--    with no till, and there are more of those than not.
--
-- 2. A site WITH terminals got one sequence per terminal, so two people raising
--    a ticket at once would get TK000001 twice from different counters.
--
-- A ticket is not raised at a till. Neither is a job card, which is why 104
-- seeds ONE row with no terminal_id at all — the column defaults to 0, meaning
-- "the whole site". Copying that is the fix.
--
-- Invoices and receipts are the ones that number per terminal, because two
-- tills printing the same invoice number is a real problem SARS cares about.
-- Nothing about a support ticket has that property.

-- The per-terminal rows 165 created, and only those: doc_type = 'ticket' with a
-- terminal_id that is not 0. A site that somehow has a real terminal-0 row keeps
-- it, and the INSERT below is IGNOREd rather than resetting its next_number.
DELETE FROM document_sequences WHERE doc_type = 'ticket' AND terminal_id <> 0;

-- One row for the site, matching 104. INSERT IGNORE is safe: the primary key is
-- (terminal_id, doc_type) and both columns are NOT NULL, so it genuinely
-- dedupes — and a site that already numbered a ticket keeps its counter rather
-- than being reset to 1.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('ticket', 'TK', 1, 6, 'none');
