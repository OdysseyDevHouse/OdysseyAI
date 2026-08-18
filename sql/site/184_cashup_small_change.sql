-- ── Small change on a cash-up ───────────────────────────────────────────────
--
-- The denomination grid counts PILES: a quantity per denomination, multiplied
-- by that denomination's value. That is the right shape for notes and for the
-- coins a shop actually sorts, and the wrong shape for the handful of coppers
-- at the bottom of every drawer.
--
-- A shop trading in South Africa still receives 1c, 2c and 5c pieces even
-- though they are no longer minted, and nobody counts them individually — they
-- are swept together, weighed by eye or tipped onto a scale, and declared as
-- one amount. Asking for "how many 2c" produces either a lie or a cashier on
-- their knees at the counter.
--
-- ── WHY A COLUMN AND NOT ANOTHER DENOMINATION ROW ──────────────────────────
--
-- The obvious trick is a cash_denominations row with value = 1.00 called
-- "Small change", so the grid's own qty × value arithmetic gives the answer.
-- It does not work: shift_count_denominations.qty is INT UNSIGNED, so that row
-- could only ever hold whole rands and R3.47 of coppers would have to be
-- rounded — on the one figure whose entire purpose is to absorb the awkward
-- remainder.
--
-- So it is an AMOUNT on the declaration itself: one number, typed as money,
-- added to the counted cash. It sits beside `declared_cash` rather than inside
-- it so a report can still say what was counted by pile and what was swept in,
-- and so an old declaration reads back as it was signed.

ALTER TABLE shift_declarations
  ADD COLUMN IF NOT EXISTS small_change DECIMAL(12,4) NOT NULL DEFAULT 0.0000
  AFTER declared_cash;
