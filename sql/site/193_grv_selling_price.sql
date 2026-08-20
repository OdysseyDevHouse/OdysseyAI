-- ─────────────────────────────────────────────────────────────────────────
-- A GRV re-prices the shelf.
--
-- The receiving grid has always shown Selling, Markup % and GP % beside the
-- landed cost, because pricing a delivery is what a buyer is actually doing
-- while the supplier's invoice is in their hand. Those columns were display
-- only: `ReceiveLineInput` had no selling price, so whatever the buyer typed
-- was dropped at the server boundary and the shelf price never moved.
--
-- This column is what the buyer intends the price to become. It is applied to
-- `product_prices` -- through writePriceRows, the one definition of a price
-- write -- at the moment the receipt POSTS, and never before: a draft that is
-- still being keyed must not move a price the till is charging today.
--
-- ── WHY IT IS STORED ON THE LINE AT ALL ──────────────────────────────────
--
-- The price could be applied and forgotten, since product_price_history
-- already records the before and after against the GRV's id. Two reasons it
-- is kept here instead:
--
--   1. A DRAFT must survive being put down. A delivery keyed on Friday and
--      posted on Monday would otherwise lose every price decision made while
--      the note was in hand, which is the only moment they are easy to make.
--   2. The posted GRV can then SHOW what it re-priced, beside the cost that
--      justified it. History answers "what changed"; the document answers
--      "what did this delivery decide", which is the question a buyer asks.
--
-- NULL, not 0, for "this line did not touch the price". They are different
-- claims: a line the buyer never looked at must leave the shelf alone, while
-- 0.0000 is a real -- if unlikely -- price. A DEFAULT of 0 here would re-price
-- every untouched line on every delivery to free.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE purchase_document_lines
  ADD COLUMN IF NOT EXISTS selling_price_incl DECIMAL(12,4) NULL
    COMMENT 'Buyer-set shelf price (VAT incl.); NULL = leave the price alone';
