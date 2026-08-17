-- When a shop is open, and when it has simply run out.
--
-- ── WHY A SHOP NEEDS HOURS AT ALL ───────────────────────────────────────────
--
-- A chain of takeaways running one storefront has to tell a shopper two things
-- the app cannot currently answer: whether the branch they picked is open, and
-- when they can collect. Today the only hours anywhere are storefront_theme
-- .footer_hours, which is free text printed at the bottom of the page — it
-- cannot be parsed, so nothing can be decided from it.
--
-- ── THE SAME SHAPE AS RESERVATIONS, DELIBERATELY ────────────────────────────
--
-- reservation_settings.opening_hours (095) already stores a week as JSON, and
-- src/lib/reservationTypes.ts already parses it, tolerates junk in it, and
-- formats it. That model handles a split lunch/dinner service because a day is
-- an ARRAY of ranges, which is exactly what a restaurant needs.
--
-- Inventing a second hours format here would mean two parsers, two sets of edge
-- cases, and a shop whose reservation hours and ordering hours could disagree in
-- ways neither screen could show. So: same JSON, same parser, same day numbering
-- (0 = Sunday).
--
-- ── OPEN, CLOSED, AND NOT ACCEPTING ARE THREE DIFFERENT THINGS ──────────────
--
-- Closed is not an error. "Order for tomorrow at 08:15" is the normal path for a
-- shopper at 22:30, and a shop that refused those orders would be turning away
-- the trade the feature exists to win.
--
-- Not accepting is a hard stop, and it is a SEPARATE column rather than a state
-- of the hours: the fryer breaks, the kitchen is drowning at 19:00 on a Friday,
-- the power is out. Staff need to stop the queue for an hour without editing
-- their trading hours and remembering to put them back.

ALTER TABLE online_store_settings
  -- The regular week, as reservation_settings.opening_hours. NULL means "always
  -- open", which is what every shop has had until now — so no existing store
  -- changes behaviour when this migration runs.
  --
  -- NULL and '{}' are deliberately different answers. NULL is "no hours were
  -- ever set"; a populated column that parses to nothing is a broken value, and
  -- parseOpeningHours already reads that as closed. Failing open on the first
  -- and closed on the second is the honest reading of each.
  ADD COLUMN IF NOT EXISTS trading_hours TEXT NULL,

  -- The kill switch. Independent of the hours above: a shop can be inside its
  -- trading window and still not be taking orders.
  ADD COLUMN IF NOT EXISTS accepting_orders TINYINT(1) NOT NULL DEFAULT 1,

  -- Shown to the shopper when the switch is off. Without it the storefront can
  -- only say "not taking orders", which reads as broken rather than busy.
  ADD COLUMN IF NOT EXISTS accepting_note VARCHAR(200) NOT NULL DEFAULT '',

  -- How far ahead an order-for-later may be placed. A restaurant wants a day or
  -- two; a butcher taking Christmas orders wants a fortnight.
  ADD COLUMN IF NOT EXISTS order_horizon_days TINYINT UNSIGNED NOT NULL DEFAULT 2;

-- ── Days that do not repeat ─────────────────────────────────────────────────
-- Public holidays, a stocktake, a wedding the whole shop is catering. These are
-- the entire reason a weekly pattern is not enough on its own, and a chain of
-- ten will have different ones per branch — which this gets for free by living
-- in each branch's own database.
CREATE TABLE IF NOT EXISTS online_trading_exceptions (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- One row decides one date. UNIQUE below, so two rows cannot disagree about
  -- whether the shop is open on the 25th.
  on_date    DATE NOT NULL,
  -- Closed all day. When 1 the times below are ignored rather than deleted, so
  -- a shop can close a day and reopen it later without retyping its hours.
  is_closed  TINYINT(1) NOT NULL DEFAULT 1,
  -- A short day: open, but not the usual window. Both NULL with is_closed = 0
  -- is meaningless and is refused by the app rather than by a constraint, so the
  -- screen can explain it.
  open_time  TIME NULL,
  close_time TIME NULL,
  -- Shown to the shopper: "Closed — Christmas Day" beats a bare "Closed".
  note       VARCHAR(200) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_trading_exception_date (on_date),
  KEY ix_trading_exception_date (on_date, is_closed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Sold out, until tomorrow ────────────────────────────────────────────────
--
-- A kitchen that has run out of prepped wings is NOT out of stock: the
-- ingredients are in the fridge, the stock ledger is right, and tomorrow the
-- wings are back. Writing this as stock_on_hand = 0 would corrupt a ledger whose
-- whole value is that it reconciles, and would need somebody to remember to put
-- the figure back at close.
--
-- So it is its own fact, with a date rather than a flag: `unavailable_until`
-- expires by itself. No cron job, nothing to remember, and no way to leave a
-- product hidden for a month because a member of staff went on leave.
CREATE TABLE IF NOT EXISTS online_product_availability (
  product_id        INT UNSIGNED NOT NULL,
  -- The last day it is unavailable. Today means "back tomorrow", which is the
  -- overwhelmingly common case; a longer date covers a supplier who has failed.
  unavailable_until DATE NOT NULL,
  -- "Back tomorrow", "Supplier issue". Shown as-is next to the product.
  note              VARCHAR(120) NOT NULL DEFAULT '',
  set_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  set_by            VARCHAR(120) NOT NULL DEFAULT '',
  PRIMARY KEY (product_id),
  -- The storefront asks "what is off today" on every catalogue read.
  KEY ix_unavailable_until (unavailable_until),
  CONSTRAINT fk_availability_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
