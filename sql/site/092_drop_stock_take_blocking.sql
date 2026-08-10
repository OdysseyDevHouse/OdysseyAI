-- ── Stock takes: the blocking columns come out ───────────────────────────
--
-- 081 added is_blocking and blocking_until for a "hard freeze" -- a count that
-- stops the till selling the products on it while somebody walks the shelves.
--
-- ── WHY IT IS BEING REMOVED RATHER THAN BUILT ────────────────────────────
--
-- It cannot be built honestly in this application, because this application has
-- decided the opposite thing everywhere else:
--
--   · canSellNow() in stockMovements.ts always returns ok. Every product type
--     sells now.
--   · salesPosting.ts never refuses a line on quantity. Stock is allowed to go
--     negative, on purpose: a till that refuses to sell what is in the
--     customer hand loses the revenue without preventing anything.
--   · An offline till sells from its OWN catalogue in browser storage and
--     decrements it locally. decrementStock() in posOffline/catalog.ts says so
--     in as many words, and a server flag is not consulted at all.
--
-- So a blocking flag would refuse a sale on an online till and be invisible to
-- an offline one -- the same shop, the same product, the same moment, and a
-- different answer depending on whether the network happened to be up. A
-- control that appears to guarantee something it cannot guarantee is worse than
-- no control, because somebody will plan a stock take around it.
--
-- What a count actually relies on instead is the two-figure design in 081: the
-- variance posted is counted-minus-CURRENT, so anything sold mid-count is
-- accounted for rather than counted as missing. That is what makes counting a
-- trading shop safe, and it needs no freeze at all.
--
-- Dropped rather than left unused. An unused column with a name this suggestive
-- is a feature somebody will wire up later without finding this reasoning.
--
-- IF NOT EXISTS on the drop: 081 and this file may both be new to a site that
-- has never run either, and the runner applies them in order.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE stock_takes
  DROP COLUMN IF EXISTS is_blocking,
  DROP COLUMN IF EXISTS blocking_until;

-- The index named them, so it goes too. Dropped after the columns, because
-- MariaDB removes an index whose every column has gone.
DROP INDEX IF EXISTS ix_take_blocking ON stock_takes;
