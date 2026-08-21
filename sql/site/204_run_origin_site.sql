-- Which store started a run that lives in the shared customer file.
--
-- ── THE GAP THIS FILLS ───────────────────────────────────────────────────
--
-- 198 gave origin_site_id to the ROWS a shared file receives from every branch
-- — customer_transactions, loyalty_ledger, gift_card_events — because pooling
-- per-database ids into one table made document_id stop identifying a document.
--
-- The RUN tables were missed, and they have a different problem with the same
-- cause. interest_runs, customer_statement_runs and debt_write_offs all move to
-- the group primary with the customer file, so every branch sees every other
-- branch's runs in one undifferentiated list, with no way to tell whose is
-- whose:
--
--   · Branch 3 charges interest on the 25th. Branch 7 opens the screen on the
--     26th, sees a run it did not make and cannot attribute, and charges again.
--     Every account in the group is charged twice. (The proposal now refuses an
--     overlapping period outright — see interestRuns.ts — but a bookkeeper who
--     cannot see WHO ran what is still working blind.)
--   · listRuns shows branch 3 the statement runs created by branches 1, 2 and
--     4, and retryFailed and deleteRun operate on them freely.
--   · writeOffSummary — the figure the module's header calls "what an auditor
--     asks for by name" — returns the group total on every branch's screen, and
--     a branch's own bad-debt figure cannot be obtained at all.
--
-- ── WHAT THIS COLUMN DOES AND DOES NOT DECIDE ────────────────────────────
--
-- It records provenance. It deliberately does NOT scope the WORK.
--
-- That distinction matters and is easy to get backwards. Interest is charged on
-- a BALANCE, and under sharing there is one balance for the group — so interest
-- must be proposed group-wide, exactly as it is today, or a customer owing
-- R10,000 across three branches gets three partial charges that add up to a
-- different number than one correct one. Same for a statement: one book, one
-- statement, or the customer gets three that each show part of what they owe.
--
-- So a run stays group-wide and this column says who ran it. Only the
-- REPORTING question — "what did MY branch write off this year" — is answered
-- by filtering on it, and that is a genuinely per-branch question because bad
-- debt is charged to the branch that incurred it.
--
-- Deliberately NOT a foreign key, for the reason 198 and 101 give: cp2_sites is
-- in the control database, and a site leaving a group must not make its own
-- history unreadable.
--
-- NULL means "written before this column existed". Unambiguous, because a store
-- that was not sharing was the only store writing to its own tables.

ALTER TABLE interest_runs
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER user_name;

ALTER TABLE interest_runs
  ADD INDEX IF NOT EXISTS ix_irun_origin (origin_site_id, as_at_date);

ALTER TABLE customer_statement_runs
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER user_name;

ALTER TABLE customer_statement_runs
  ADD INDEX IF NOT EXISTS ix_srun_origin (origin_site_id, created_at);

-- Bad debt belongs to the branch that incurred it, so this one is read by a
-- REPORT as well as by the screen — see writeOffSummary().
ALTER TABLE debt_write_offs
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER user_name;

ALTER TABLE debt_write_offs
  ADD INDEX IF NOT EXISTS ix_wo_origin (origin_site_id, write_off_date);
