-- Stock holds: what an online order has spoken for, before anyone agreed to it.
--
-- ── THE PROBLEM ──────────────────────────────────────────────────────────
--
-- The storefront reads stock live and holds nothing. Two shoppers can order the
-- last item within the same minute and both be told "In stock", and the shop
-- discovers it at acceptance with one customer to disappoint. That is not a
-- data-corruption bug — the order-is-a-request design catches it safely — it is
-- a customer-disappointment one, and it is the whole reason for this table.
--
-- ── A HOLD IS NOT A STOCK MOVEMENT ───────────────────────────────────────
--
-- This is the load-bearing distinction, and it is the same one `reservedQty`
-- already makes for open sales orders and lay-bys (see stockMovements.ts):
--
--   products.stock_on_hand is UNTOUCHED. Σ stock_movements.qty_change still
--   equals it, so the reconciliation report — the thing that proves the stock
--   module works — keeps working, and a held item is still owned by the shop.
--
-- What a hold changes is only what the storefront ADVERTISES. That is exactly
-- where the problem was, so it is exactly where the fix belongs. Decrementing
-- stock on order would move goods before anyone in the shop agreed to sell
-- them, which contradicts 034's "the order is a request, the sale is the truth"
-- and needs a compensating write on every decline.
--
-- ── HOLDS SELF-EXPIRE IN THE READ, NOT IN A SWEEP ────────────────────────
--
-- `expires_at` is compared by every query that counts a hold. The sweep below
-- only tidies rows; it is NOT what makes a hold stop counting.
--
-- That is deliberate and it is the important property. A sweep that dies — a
-- crashed cron, an unset secret, a host that never scheduled it — would
-- otherwise leak holds forever and hide sellable stock from the shop, with no
-- symptom except quiet lost sales. Written this way, the worst a dead sweep
-- causes is some old rows nobody reads.

CREATE TABLE IF NOT EXISTS online_stock_holds (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- CASCADE: an order deleted takes its claims with it. A hold with no order is
  -- not a claim on behalf of anybody.
  order_id     INT UNSIGNED NOT NULL,

  -- CASCADE for the same reason: a product that no longer exists cannot be
  -- held. Note this is the CHILD in a variant group — the sellable row — since
  -- a parent can never reach an order line (070).
  product_id   INT UNSIGNED NOT NULL,

  qty          DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- When this stops counting, whatever else happens. See the note above.
  expires_at   DATETIME     NOT NULL,

  -- Set the moment the hold stops applying for a REASON rather than by time:
  -- the order was accepted (it is a real sale now and stock actually moves),
  -- declined, or cancelled. Kept rather than deleted so "why did this order
  -- lose its hold" is answerable.
  released_at  DATETIME     NULL,
  -- 'accepted' | 'declined' | 'cancelled' | 'expired'. Free text rather than an
  -- ENUM because it is diagnostic, not behavioural — nothing branches on it.
  release_note VARCHAR(40)  NOT NULL DEFAULT '',

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- THE query: live holds for a set of products. Live means released_at IS NULL
  -- AND expires_at > NOW(), and both are in the key so the storefront's
  -- availability read never scans.
  KEY ix_hold_live (product_id, released_at, expires_at),
  -- Releasing every hold on one order, which happens on accept and decline.
  KEY ix_hold_order (order_id, released_at),

  CONSTRAINT fk_hold_order
    FOREIGN KEY (order_id) REFERENCES online_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_hold_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The shop's control ───────────────────────────────────────────────────
ALTER TABLE online_store_settings
  -- How long an order holds its stock before the claim lapses.
  --
  -- 60 minutes by default. Long enough that a shop checking its queue every
  -- half hour never loses a hold it meant to honour; short enough that an
  -- abandoned or fraudulent order does not keep goods off the shelf all day.
  --
  -- 0 SWITCHES HOLDING OFF, which is the pre-076 behaviour and a legitimate
  -- choice: a shop with deep stock and slow-moving lines gains nothing from
  -- holds and would rather never refuse a shopper.
  ADD COLUMN IF NOT EXISTS hold_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60;
