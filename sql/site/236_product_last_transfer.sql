-- When this product was last moved between locations.
--
-- ── WHY A SIXTH DATE ──────────────────────────────────────────────────────
--
-- `products` already carries last_edit_date, last_purchase_date, last_sold_date,
-- last_adjust_date and last_stock_take_date (109). Each answers a question
-- somebody actually asks, and none of them answers this one: "has this stock
-- moved rooms recently".
--
-- It matters for the same reason "last counted" earned its own column rather
-- than sharing "last adjusted": a transfer is not a correction and not a sale.
-- A product sitting untouched in a back room for a year looks identical to a
-- briskly-moving one if the only evidence is that its stock figure changed —
-- and a transfer changes the figure per LOCATION while leaving the site total
-- exactly where it was.
--
-- ── WHY NOT DERIVE IT ─────────────────────────────────────────────────────
--
-- MAX(created_at) over stock_movements WHERE movement_type IN ('transfer_in',
-- 'transfer_out') is the honest answer and needs no column at all. It is also a
-- scan of the largest table in the database, per product, to render one cell on
-- a form — the same trade the five existing columns already made. A stamped
-- column is denormalisation on purpose, and the writer sits in recordMovement
-- so nothing can move stock for a transfer and forget to say so.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS last_transfer_date DATETIME NULL AFTER last_stock_take_date;

-- Backfilled from the movements themselves, so the column is true for history
-- rather than only from today. Without this every product reads "No date
-- available" until it next moves, which looks exactly like a broken column —
-- the same reason 109 backfilled the stock-take date from its own counts.
--
-- Read from stock_movements rather than stock_transfer_lines deliberately: an
-- INTER-STORE transfer (storeTransfers.ts) writes movements too but has no row
-- in stock_transfers, so the document table would silently miss half of them.
UPDATE products p
   SET p.last_transfer_date = (
     SELECT MAX(m.created_at)
       FROM stock_movements m
      WHERE m.product_id = p.id
        AND m.movement_type IN ('transfer_in', 'transfer_out')
   )
 WHERE p.last_transfer_date IS NULL;
