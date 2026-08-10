-- Room for a tile token, not a hex colour.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- 001_products.sql sized this at VARCHAR(9) because it held "#2f6fed" — nine
-- characters covers the longest hex form. It now holds a TOKEN naming a swatch
-- (`tile-3`), a gradient (`tile-grad-1`) or the blank tile (`tile-none`), and
-- `tile-grad-1` is eleven characters.
--
-- The effect was not a truncated value, because MySQL in strict mode refuses
-- the write outright: picking any gradient and pressing Save produced
-- "Data too long for column 'image_color'" and the ENTIRE product save failed.
-- Not the colour — the whole record. Found by driving the screen in a browser;
-- both tsc and the unit tests were perfectly happy, because neither of them
-- writes to a real column.
--
-- 32 rather than 12: a token is a name, names grow, and the cost of the extra
-- bytes on a VARCHAR is nothing. Sized once so the next palette addition is not
-- another migration.
--
-- departments.color is left alone deliberately — it still stores what its own
-- picker writes, and widening a column nothing has outgrown is churn.

ALTER TABLE products
  MODIFY COLUMN image_color VARCHAR(32) NULL;
