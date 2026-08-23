-- ─────────────────────────────────────────────────────────────────────────
-- Stock takes: counting without seeing the answer, and a gate before the
-- write-off reaches the books.
--
-- Two controls that belong together, because each is weak alone. A blind count
-- produces honest variances and then posts them unchecked; a sign-off gate
-- checks variances that were produced by somebody reading the answer off the
-- screen. Together they are the pair every count methodology describes.
--
-- ── ONE: THE COUNTER MUST NOT SEE THE EXPECTED FIGURE ────────────────────
--
-- 081 argued that a corrected figure with no document behind it answers none
-- of the questions anybody asks afterwards. This is the same argument one step
-- further in: a variance produced by somebody who could see the expected
-- figure answers none of them either.
--
-- The count sheet shows snapshot_qty in a column headed "System says", right
-- beside the input. A counter who sees 14 types 14 -- not from dishonesty, but
-- because a shelf of small identical items is genuinely hard to count and the
-- number on the screen is genuinely persuasive. The shrinkage figure that
-- results is zero, which is exactly the reading a business will not act on.
--
-- So: a per-sheet flag that hides the expected figure WHILE COUNTING.
--
-- ── WHY PER SHEET, AND NOT A SITE SETTING ────────────────────────────────
--
-- Because the two kinds of count are genuinely different jobs. A quarterly
-- shrinkage count wants blindness; a stockroom tidy-up where somebody is
-- reconciling a delivery against a pile wants the expected figure on screen,
-- and forcing blindness there just makes them keep a second window open.
--
-- Same reasoning as 103 putting the refer method on the LINK rather than on a
-- site setting: it is a property of the job, not of the shop.
--
-- ── WHY IT UNHIDES AT POST ───────────────────────────────────────────────
--
-- Blindness protects the COUNT. Once the count is committed there is nothing
-- left to bias, and a posted sheet that still hides what it was counted
-- against is a document nobody can audit. So the flag is read by the grid
-- while draft or counting, and ignored once posted or cancelled.
--
-- ── TWO: A VARIANCE OVER THE LINE NEEDS A SECOND SIGNATURE ───────────────
--
-- postStockTake has no approval step of any kind. Anybody holding
-- stock.adjust can write off any value in one click, and it posts straight to
-- account 5100 -- a journal a bookkeeper has to defend, written by whoever
-- happened to be holding the tablet.
--
-- The threshold pair lives in site_settings alongside
-- purchase_approval_threshold, which this deliberately mirrors:
--
--   stock_take_variance_qty_pct    percentage a line may drift from its
--                                  snapshot before it needs signing off
--   stock_take_variance_value      rand value of a single line variance that
--                                  needs signing off regardless of percentage
--
-- BOTH DEFAULT TO ZERO, WHICH IS OFF. Same convention, same reason: a control
-- that arrives switched on is a control that gets switched off in a hurry on
-- the first busy morning, usually for good. A shop that wants it turns it on.
--
-- Two thresholds rather than one because they catch different failures. A
-- percentage catches "we thought we had 400 and found 40" on a fast-moving
-- cheap line. A value catches "one of these is missing" where the one is a
-- R14,000 item and 1 of 3 is only 33%. Either alone leaves a hole that the
-- other closes.
--
-- ── WHAT APPROVAL IS, AND WHAT IT IS NOT ─────────────────────────────────
--
-- It is a SECOND PERSON agreeing that a specific line's variance is real,
-- recorded with a reason, before that variance may post. It is not a workflow
-- state on the sheet: the sheet stays 'counting' and posting is simply refused
-- while flagged lines are unapproved, which keeps the status enum meaning what
-- it has always meant and keeps the refusal in postStockTake where it belongs.
--
-- The columns sit on the LINE rather than the sheet because approval is
-- per-line by nature. A sheet of 400 lines with three big variances needs
-- three signatures, not one blanket one -- and a blanket one is what a sheet
-- level column would silently become.
--
-- ── WHY THE REASON IS THE EXISTING TABLE ─────────────────────────────────
--
-- 100 already argues why reasons are a table and not an enum, and already
-- seeds the vocabulary a variance needs (breakage, theft, expiry). Approving a
-- count variance is answering the same question an adjustment answers -- where
-- did it go -- so it reads the same list. A second parallel table would split
-- "how much did we lose to breakage last quarter" across two reports.
--
-- SET NULL rather than RESTRICT on the reason: 100 deliberately lets a reason
-- be retired without rewriting history, and a retired reason must not make an
-- old approved line unreadable. The approver name and note are snapshotted, so
-- the record still explains itself with the link gone.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Blind counting ────────────────────────────────────────────────────
-- Defaults to 0, which is the load-bearing part: every sheet already in the
-- field keeps showing what it shows today, and nothing changes until somebody
-- ticks the box on a new one.
ALTER TABLE stock_takes
  ADD COLUMN IF NOT EXISTS is_blind TINYINT(1) NOT NULL DEFAULT 0 AFTER scope_ref_id;

-- ── 2. Per-line approval ─────────────────────────────────────────────────
--
-- All four columns are NULL on an ordinary line and stay that way forever.
-- Only a line whose variance crosses a threshold ever carries them, so the
-- overwhelmingly common case costs four NULLs and no behaviour.
ALTER TABLE stock_take_lines
  -- Who signed it off. Snapshotted name beside the id, matching every other
  -- actor column in this schema -- the user row may be renamed or removed and
  -- the approval has to keep reading.
  ADD COLUMN IF NOT EXISTS approved_by_id INT UNSIGNED NULL AFTER counted_by,
  ADD COLUMN IF NOT EXISTS approved_by    VARCHAR(120)  NULL AFTER approved_by_id,
  ADD COLUMN IF NOT EXISTS approved_at    DATETIME      NULL AFTER approved_by,
  -- Where it went, in the vocabulary the adjustment screens already use.
  ADD COLUMN IF NOT EXISTS approval_reason_id INT UNSIGNED NULL AFTER approved_at,
  -- Free text beside the code, because "shrinkage, under investigation" is a
  -- reason code and "the pallet from Tuesday never came off the truck" is what
  -- actually explains it.
  ADD COLUMN IF NOT EXISTS approval_note VARCHAR(190) NULL AFTER approval_reason_id;

-- Finding the unapproved flagged lines on a sheet is the query postStockTake
-- runs before it will write anything, so it gets an index rather than a scan
-- of five thousand lines.
ALTER TABLE stock_take_lines
  ADD KEY IF NOT EXISTS ix_takeline_approval (stock_take_id, approved_at);

-- Guarded and re-runnable: MariaDB has no ADD CONSTRAINT IF NOT EXISTS, so the
-- drop-then-add pair is what makes this file safe to run twice.
ALTER TABLE stock_take_lines DROP FOREIGN KEY IF EXISTS fk_takeline_approval_reason;
ALTER TABLE stock_take_lines
  ADD CONSTRAINT fk_takeline_approval_reason FOREIGN KEY (approval_reason_id)
    REFERENCES stock_adjustment_reasons (id) ON DELETE SET NULL;
