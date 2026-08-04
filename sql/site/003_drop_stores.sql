-- Reverts 002_stores.sql.
--
-- 002 modelled stores as rows INSIDE one site's database. That was the wrong
-- shape: a store IS a site, with its own master database (ody10000_master,
-- ody10001_master, …), and stores are linked to each other in the CONTROL
-- database. A product is a row in each linked store's own database, matched by
-- `code`; sharing decides whether an edit writes the same price to every linked
-- store or a different one to each.
--
-- Nothing here loses trading data: 002 seeded product_store_inventory from the
-- products columns it copied, and those columns were left in place. This
-- restores them from the seeded store before the tables go, so a site that ran
-- 002 ends up exactly where it started.

-- Put stock and levels back on `products` from the default store, so the
-- single-database shape is whole again.
UPDATE products p
  JOIN product_store_inventory psi ON psi.product_id = p.id
  JOIN stores s ON s.id = psi.store_id AND s.is_default = 1
   SET p.stock_on_hand = psi.stock_on_hand,
       p.min_stock     = psi.min_stock,
       p.max_stock     = psi.max_stock;

-- Child tables first — each has a FK to stores.
DROP TABLE IF EXISTS product_store_prices;
DROP TABLE IF EXISTS product_store_costs;
DROP TABLE IF EXISTS product_store_inventory;
DROP TABLE IF EXISTS stores;
