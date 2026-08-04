-- The master product-sharing switch, per store.
--
-- shares_cost / shares_selling from 001 only decide whether PRICES travel with
-- an edit. This decides whether the stores exchange products at all: with it
-- off, a store sits in the group (so it still appears on the Linked stores
-- screen and can be turned on later) but no edit fans out to it and none of its
-- own products are touched.
--
-- That distinction matters for a customer with four stores where one is run
-- independently — it belongs to the group administratively, but its product
-- file is its own.
--
-- IMPORTANT: turning shares_products ON is only safe while the joining store is
-- EMPTY. Two stores that each already hold products cannot be merged by a flag:
-- the same code may exist in both with different descriptions, departments and
-- prices, and nothing here could decide which is correct. The UI enforces that,
-- and this column only records the outcome.

ALTER TABLE cp2_store_group_members
  ADD COLUMN shares_products TINYINT(1) NOT NULL DEFAULT 0 AFTER position,
  ADD COLUMN shares_departments TINYINT(1) NOT NULL DEFAULT 0 AFTER shares_products;

-- Rows written before this column existed were created by linking a store,
-- which at the time implied sharing. Preserve that meaning rather than
-- silently switching those groups off.
UPDATE cp2_store_group_members SET shares_products = 1, shares_departments = 1;
