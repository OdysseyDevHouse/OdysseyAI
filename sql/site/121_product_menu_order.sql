-- ============================================================================
-- 121_product_menu_order.sql — where a product sits on the till's menu
-- ============================================================================
--
-- The menu designer lets an owner drag product tiles into the order the till
-- draws them: the six things this shop actually sells go at the top of the
-- department, not wherever the alphabet happens to put them.
--
-- Departments already have `sort_order`. Products had nothing equivalent, so
-- the till could only ever draw them A-Z, and the whole reorder gesture had
-- nowhere to persist to.
--
-- ── WHY A SEPARATE COLUMN AND NOT `sort_order` ON products ──────────────────
--
-- This orders a product WITHIN ITS DEPARTMENT, on one surface: the till's
-- browse grid. It is not a general "sort products this way" field, and calling
-- it `sort_order` would invite the product list, the catalogue export and the
-- online store to start honouring it too — three screens quietly disagreeing
-- about what the number means. The name says which surface owns it.
--
-- ── WHY 0 IS "UNPOSITIONED" RATHER THAN "FIRST" ─────────────────────────────
--
-- Every existing product gets 0, and 0 has to mean "nobody has placed this
-- one" — otherwise a shop's entire catalogue would claim to be joint-first and
-- the first drag would appear to do nothing.
--
-- So readers sort positioned rows (>0) ascending FIRST, then the unpositioned
-- ones A-Z after them. A shop that never opens the designer sees exactly the
-- alphabetical menu it sees today; a shop that places three tiles gets those
-- three at the front with the rest still tidy underneath. Positions are
-- rewritten 1..n on every save, so the gaps a delete leaves never accumulate.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pos_sort_order INT NOT NULL DEFAULT 0
  AFTER visible_in_pos;

-- The designer's read is "every product in THIS department, in menu order",
-- which is exactly this pair. Without it that is a filesort per department on
-- a catalogue that can run to five figures.
ALTER TABLE products
  ADD INDEX IF NOT EXISTS ix_product_menu_order (department_id, pos_sort_order);
