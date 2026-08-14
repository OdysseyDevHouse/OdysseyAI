-- A loyalty voucher spent at online checkout.
--
-- Stored on the order because the sale is finalised later, in the payment
-- callback -- a different request that must know what to hand the posting
-- engine. One code per order in v1.
ALTER TABLE online_orders
  ADD COLUMN IF NOT EXISTS voucher_code VARCHAR(32) NOT NULL DEFAULT '';
