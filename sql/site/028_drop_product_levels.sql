-- ─────────────────────────────────────────────────────────────────────────
-- Drops products.min_stock and products.max_stock.
--
-- Reorder levels moved to product_location_stock in 025_stock_locations.sql,
-- and the argument for the move is the argument for this drop: a level is only
-- meaningful against the stock it governs. A warehouse holding 500 and a shop
-- floor holding 5 need different reorder points, and one site-wide number
-- could only ever be wrong for one of them.
--
-- ── WHY DROP RATHER THAN LEAVE THEM ──────────────────────────────────────
--
-- Since 025 these columns have been written by nothing and read for no
-- reorder decision. A column that no longer means anything is worse than no
-- column: the next person to find `min_stock` on `products` has no way to know
-- it is a fossil, and the obvious reading — "the minimum level for this
-- product" — is exactly wrong now that levels are per room.
--
-- 025 already copied both values into the main location, so nothing is lost.
-- That copy is what makes this safe to run.
--
-- ── THE ONE READER THAT MATTERED ─────────────────────────────────────────
--
-- listProducts had a `belowMinimum` filter comparing the SITE TOTAL against
-- the site-wide level. It now compares each pile against its own level, which
-- is the question a buyer is actually asking: not "do we own enough in total"
-- but "is any room running out". See products.ts.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- Belt and braces before the drop: carry across anything that 025 could not,
-- which is a product whose main-location row was created after that migration
-- ran and therefore defaulted to zero levels. Only fills rows still at zero,
-- so a level genuinely set per location is never overwritten by a stale
-- product-level figure.
UPDATE product_location_stock pls
  JOIN products p        ON p.id = pls.product_id
  JOIN stock_locations l ON l.id = pls.location_id AND l.is_main = 1
   SET pls.min_stock = p.min_stock,
       pls.max_stock = p.max_stock
 WHERE pls.min_stock = 0 AND pls.max_stock = 0
   AND (p.min_stock <> 0 OR p.max_stock <> 0);

ALTER TABLE products DROP COLUMN IF EXISTS min_stock;
ALTER TABLE products DROP COLUMN IF EXISTS max_stock;
