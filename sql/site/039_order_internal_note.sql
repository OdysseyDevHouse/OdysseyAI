-- ─────────────────────────────────────────────────────────────────────────
-- A place for the SHOP to write about an order.
--
-- Its own column rather than appending to customer_note. That field holds the
-- shopper's own words — it is read back to them, it gets quoted in a dispute,
-- and anything the system wrote into it would be impossible to separate out
-- afterwards.
--
-- The first user is the payment path: when a price moves between a shopper
-- ordering and paying, they have been charged the OLD figure. The sale still
-- posts — the money is in and the goods are going out — but the discrepancy is
-- recorded here so staff see it rather than discover it at month end.
--
-- Its own migration rather than an edit to 038_payments.sql because that one
-- has already been applied, and migrations are recorded by NAME: editing an
-- applied file changes nothing on any database that has already run it.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE online_orders
  ADD COLUMN internal_note VARCHAR(500) NOT NULL DEFAULT '';
