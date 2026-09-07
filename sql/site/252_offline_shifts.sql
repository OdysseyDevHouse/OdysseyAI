-- ── A shift that was opened with no network ─────────────────────────────────
--
-- Until now a till could sell offline but not START. `openShift` is a server
-- action, so a machine that rebooted during an outage — a power cut, a Windows
-- update, a Sunmi somebody sat on — came back up with no shift to bank into and
-- no way to make one. It could still trade: `finaliseOffline` banks into a null
-- shift and the schema has always allowed that. But every sale rung up after the
-- reboot then belonged to no reconciliation at all, so the drawer it went into
-- could not be cashed up, and the variance for the shift that WAS open ran
-- short by exactly the takings nobody could attribute.
--
-- The outage is the whole point of the offline till. Losing the cash-up to it is
-- a strange place to stop.
--
-- ── WHAT THIS MIGRATION IS, AND WHAT IT IS NOT ──────────────────────────────
--
-- It adds an IDEMPOTENCY KEY to two tables and nothing else. No new table, no
-- new column carrying money, no change to how a shift is read, closed, counted
-- or reported. `shifts.id` remains what everything downstream keys on — see the
-- header of `shiftToBankInto`, which calls that the hinge of the whole feature
-- and is still right.
--
-- The uid exists so a queued OPEN can be delivered more than once without
-- opening two shifts. That is the same bargain `offline_sync_claims.sale_uid`
-- makes for a sale, and it is made here for the same reason: a till's queue
-- retries, and a retry that duplicates is worse than one that fails.
--
-- ── WHY A COLUMN AND NOT A CLAIMS TABLE, WHICH IS WHAT SALES USE ────────────
--
-- `offline_sync_claims` is a separate table because a sale's delivery has STATE
-- worth keeping apart from the sale: claimed / posted / rejected, an attempt
-- count, the last error, and a row that exists before the invoice does so a
-- crash mid-finalise can be recognised on the retry. Posting a sale reaches
-- stock, the ledger, loyalty, serials, tips and shifts — there is a lot to be
-- half-way through.
--
-- Opening a shift is one INSERT. There is no half-way, nothing to reconcile, and
-- no error worth keeping beyond the answer the till is about to be given. A
-- unique column on the row itself is the entire mechanism, and the database
-- enforces it rather than a code path remembering to look first.
--
-- ── NULLABLE, AND IT STAYS NULLABLE FOREVER ────────────────────────────────
--
-- Every shift opened in the back office has no uid and never will. NOT NULL
-- would mean inventing one for the ordinary online path — a uid that identifies
-- nothing, deduplicates nothing, and exists only to satisfy a constraint.
--
-- MySQL permits any number of NULLs in a unique index, which is exactly the
-- behaviour wanted here and is the same property 016 leans on for
-- `open_terminal_id`: the index constrains the rows that HAVE a uid and ignores
-- the rest.

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS shift_uid VARCHAR(64) NULL AFTER document_number,
  ADD UNIQUE KEY IF NOT EXISTS uq_shift_uid (shift_uid);

-- ── And the same for a drawer movement ──────────────────────────────────────
--
-- A payout for milk, a float top-up, a banking drop. These are the other half of
-- the reason an offline shift is worth having: without them a cash-up is wrong
-- every time somebody takes a note out for an errand, and the cashier is blamed
-- for a variance that was legitimate.
--
-- `shift_movements` has no natural key — two R50 payouts for "milk" by the same
-- person on the same shift are a perfectly ordinary thing to happen and must
-- both be recorded. So without a uid, a retried flush would silently double a
-- payout and take R100 out of a drawer that lost R50.
--
-- Nothing else is needed here: 055 already added `terminal_id`, so a user-mode
-- movement queued offline can still say which drawer it left.

ALTER TABLE shift_movements
  ADD COLUMN IF NOT EXISTS movement_uid VARCHAR(64) NULL AFTER shift_id,
  ADD UNIQUE KEY IF NOT EXISTS uq_movement_uid (movement_uid);
