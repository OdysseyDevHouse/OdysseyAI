-- ─────────────────────────────────────────────────────────────────────────
-- A layout for the space beneath a product.
--
-- ── ONE PAGE FOR ALL PRODUCTS, NOT ONE PER PRODUCT ───────────────────────
--
-- The 'department' kind attaches to a department by id, because a shop has
-- perhaps twenty of them and each is a place a shopper deliberately goes. A
-- shop has forty thousand PRODUCTS, and nobody is going to arrange a cross-sell
-- row forty thousand times.
--
-- So this kind carries NO department_id and no slug: it is the arrangement
-- every product page uses, and the sections on it resolve relative to whichever
-- product is being looked at. "Often bought with this" means a different row on
-- every product while being one row in this table.
--
-- uq_page_department already enforces one row per (kind, department_id), and
-- with department_id NULL for this kind that gives exactly one 'product' page
-- per site — the same mechanism that guarantees one home page. No new
-- constraint is needed, which is the reason the ENUM is widened here rather
-- than a fifth table being added.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE storefront_pages
  MODIFY COLUMN kind ENUM('home','standard','department','product')
    NOT NULL DEFAULT 'standard';
