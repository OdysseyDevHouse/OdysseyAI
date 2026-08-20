-- Which store's catalogue a product belongs to.
--
-- ── THE THREE SHAPES ONE GROUP CAN TAKE ──────────────────────────────────
--
-- Linked stores are used for three quite different things, and until now the
-- schema could only express the middle one:
--
--   1. TWO UNRELATED SHOPS, ONE LOGIN. A restaurant and a liquor store owned
--      by the same person. They share nothing — the point is one portal and
--      consolidated reporting. Already works: groupScopeFor() uses group
--      MEMBERSHIP, deliberately not the product-sharing flag.
--
--   2. A FRANCHISE WITH ONE CATALOGUE. Every branch sells the same range and
--      an edit anywhere reaches everywhere.
--
--   3. HEAD OFFICE OWNS THE RANGE. Branches sell head office's products and
--      may add their own on top, but may NOT edit head office's.
--
-- Shape 3 had nothing enforcing it. fanoutProduct() takes any store as its
-- origin, so a branch editing head office's can of Coke pushed that edit back
-- to head office and to every sibling branch. The rule existed only in
-- somebody's head.
--
-- ── ONE MECHANISM, NOT TWO MODES ─────────────────────────────────────────
--
-- Shapes 2 and 3 do not need separate settings. Give every product an ORIGIN —
-- the store whose catalogue it belongs to — and both fall out of one rule:
--
--   · head office creates a product  -> origin = head office -> branches may
--     view and stock it, but not edit it
--   · a branch creates its own       -> origin = that branch -> it manages it,
--     and the product does not fan out to head office
--
-- Shape 2 is then just the case where head office happens to create
-- everything. A franchise gets both at once — the core range plus a branch's
-- local specials — which is what shape 3 actually describes in practice.
--
-- ── WHY A SITE ID AND NOT A FOREIGN KEY ──────────────────────────────────
--
-- cp2_sites lives in the control database, and a store must keep trading if it
-- leaves a group or the control database is briefly unreachable. Same
-- reasoning, and the same shape, as stock_transfers.peer_site_id (101) and
-- customer_transactions.origin_site_id (198).
--
-- ── NULL MEANS "MINE" ────────────────────────────────────────────────────
--
-- A single store has no group and no head office, so its products have no
-- origin worth recording — and every product that exists today predates this
-- column. NULL therefore reads as "this store's own", which is both the
-- historical truth and the right answer for the overwhelmingly common case.
-- Only a product that ARRIVED from another store carries an id.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER is_archived;

-- The product screen asks "may I edit this?" on every load, so the answer must
-- not be a table scan.
ALTER TABLE products
  ADD INDEX IF NOT EXISTS ix_product_origin (origin_site_id);
