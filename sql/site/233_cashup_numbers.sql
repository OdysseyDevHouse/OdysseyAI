-- ── A cash-up gets a real number ────────────────────────────────────────────
--
-- Until now a cash-up was identified by `shifts.id` — an auto-increment that
-- means nothing to anybody. The report builder's own comment said so out loud:
-- "A shift carries no document number — it is identified by its id, and the
-- cash-up screen names it by till and date." That is fine right up until two
-- people need to talk about one.
--
-- A manager phoning about a short drawer says "cash-up 47". The bookkeeper
-- looks up 47 and finds a different shift, because 47 is a row id — it counts
-- every shift ever opened at every till, it is not the 47th cash-up of
-- anything, and at another branch of the same group it is a third shift again.
-- An invoice number has none of those problems, and the machinery that gives it
-- one has been in this schema since 015.
--
-- So a cash-up is numbered the way an invoice is: CSH_01_000001.
--
-- ── WHY THE SHAPE HAS NO TILL SEGMENT ───────────────────────────────────────
--
-- An invoice is INV_01_02_000041 — store 01, till 02. A cash-up is CSH_01_000001,
-- store only, and the missing segment is deliberate.
--
-- A shift does not always have a till. In `user` cash-up mode (055) the shift
-- belongs to a PERSON and their own float, across whatever registers they
-- worked that day — `shifts.terminal_id` is NULL by design there. A number
-- carrying a till segment would either have to invent one or produce two
-- different shapes on one site depending on a setting, and a store that
-- switches modes would then have a register of cash-ups that cannot be sorted
-- or matched by prefix.
--
-- The store segment stays, and it is the half that matters: it is what stops
-- twenty branches of one group each issuing CSH_000001. See numberFormat.ts.
--
-- ── ONE SEQUENCE FOR THE SITE, NOT ONE PER TILL ─────────────────────────────
--
-- Same reasoning as 166 for tickets, and the same trap. Seeding per-terminal
-- would give a back-office site with no tills no sequence at all, and a site
-- with tills two counters that both issue 000001. A cash-up is not rung up at a
-- register — even in terminal mode it is the store reconciling a drawer — so it
-- numbers from the site-wide row, `terminal_id = 0`.
--
-- Which also means a till cannot number a cash-up while offline. That is
-- correct and costs nothing: closing a shift already needs the server to derive
-- what was expected, so there was never an offline cash-up to protect.

-- ── The column ──────────────────────────────────────────────────────────────
--
-- Named `document_number`, not `cashup_number`. verifySequence() reads that
-- exact column out of whatever table it is pointed at, and 136 already had to
-- rename `laybys.layby_number` to satisfy the same contract. Matching it now
-- costs a better-reading column name and buys the gap-audit for free.
--
-- NULLABLE, and it stays nullable forever. The number is allocated when the
-- shift OPENS, so in ordinary running every row has one — but a NOT NULL column
-- would make the sequence a hard dependency of starting a shift, and a cashier
-- standing at a till at 07:00 must never be blocked from opening a drawer
-- because a settings row is missing. shifts.ts allocates defensively and falls
-- back to NULL; the screen then shows the id, exactly as it did before.
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS document_number VARCHAR(40) NULL AFTER id;

-- One number, one cash-up. This is the guard that actually matters: the atomic
-- UPDATE in nextDocumentNumber makes double-issue very hard, and this makes it
-- impossible. Two shifts sharing CSH_01_000042 is precisely the confusion the
-- whole change exists to remove.
--
-- UNIQUE tolerates many NULLs in MySQL/MariaDB, which is what lets the column
-- stay nullable without weakening this — see 016's note on the same property
-- being a problem there and a feature here.
ALTER TABLE shifts
  ADD UNIQUE KEY IF NOT EXISTS uq_shift_number (document_number);

-- ── The status column verifySequence requires ───────────────────────────────
--
-- Registering a type in OWN_TABLE_TYPES commits it to that function's contract,
-- which hard-codes `status = 'cancelled'` to tell an explainable gap from a
-- missing number. `shifts` has no status column: it has closed_at, and open and
-- closed are not the same question at all — an open shift is in progress, not
-- cancelled.
--
-- 116 added a `status` column to customer_assets for exactly this reason, and
-- 165 did the same for tickets. This follows both.
--
-- 'open' rather than defaulting to 'closed': a row created by openShift is open
-- by definition, and the default is what an INSERT that does not name the column
-- gets.
ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS status ENUM('open','closed','cancelled')
    NOT NULL DEFAULT 'open' AFTER closed_at;

-- Bring existing rows in line with the closed_at they already carry. Ordinary
-- running keeps the two in step from here — closeShift writes both in one
-- statement — but a table that predates the column has every row at the 'open'
-- default, including shifts cashed up months ago.
UPDATE shifts SET status = 'closed' WHERE closed_at IS NOT NULL AND status = 'open';

-- ── The sequence ────────────────────────────────────────────────────────────
--
-- INSERT IGNORE is safe here and is NOT the trap 164 fell into: the primary key
-- is (terminal_id, doc_type) and both columns are NOT NULL, so it genuinely
-- dedupes. A site re-running this keeps its counter rather than being reset to 1.
--
-- Padding 6 and no yearly reset, matching every other document type in this
-- schema. A cash-up register that restarts each January would make CSH_01_000001
-- ambiguous across years, and the store segment cannot disambiguate a year.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('cashup', 'CSH', 1, 6, 'none');

-- ── Numbering the cash-ups that already exist ───────────────────────────────
--
-- No live sites yet, so this is dev data — but leaving it unnumbered would mean
-- every screen below has to render two shapes forever, and the one thing worth
-- testing is that it does not have to.
--
-- ROW_NUMBER() OVER (ORDER BY id), not a `SET @n := 0` counter with an ordered
-- UPDATE. 064 explains why at length and the reason holds here: that pattern
-- depends on the order MySQL happens to evaluate the SET clause, is deprecated,
-- and silently numbers rows in storage order when the optimiser picks another
-- plan. Here that would mean a cash-up register whose numbers do not follow the
-- order the shifts were opened in.
--
-- The store segment comes from `settings`, defaulted to '01' the same way
-- numbering.ts defaults it, so a site that never set one still backfills to the
-- shape it will issue from tomorrow.
UPDATE shifts s
  JOIN (
    SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n FROM shifts WHERE document_number IS NULL
  ) ranked ON ranked.id = s.id
  CROSS JOIN (
    SELECT LPAD(COALESCE(NULLIF(setting_value, ''), '01'), 2, '0') AS store
      FROM settings WHERE setting_key = 'store_number'
    UNION ALL SELECT '01'
    LIMIT 1
  ) cfg
   SET s.document_number = CONCAT('CSH_', cfg.store, '_', LPAD(ranked.n, 6, '0'));

-- Move the counter past what was just backfilled, so the next shift opened does
-- not collide with a number this migration already handed out. GREATEST, not a
-- plain assignment: a site whose sequence is somehow already ahead keeps it.
UPDATE document_sequences ds
  JOIN (SELECT COUNT(*) AS n FROM shifts WHERE document_number IS NOT NULL) b
   SET ds.last_issued_number = GREATEST(COALESCE(ds.last_issued_number, 0), b.n),
       ds.next_number        = GREATEST(ds.next_number, b.n + 1)
 WHERE ds.doc_type = 'cashup' AND ds.terminal_id = 0;
