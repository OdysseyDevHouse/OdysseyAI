-- Cost changes, on the record beside price changes (256).
--
-- 144 put every SELLING price change on the record, and it is complete for one
-- reason: writePriceRows is the one definition of a price write, so every door
-- -- editor, import, reprice, schedule, revert, fanout, GRV, grid -- passes
-- through it. Cost had no such chokepoint. Sixteen places ran their own
-- UPDATE products SET last_cost, and the product screen's history showed none
-- of them: a supplier put a cost up, the margin moved, and the Reporting tab
-- said nothing had happened.
--
-- ── WHY THIS TABLE AND NOT A SIBLING ─────────────────────────────────────────
--
-- The obvious alternative was product_cost_history beside product_price_history.
-- It was rejected because the QUESTION being asked spans both: "the margin on
-- this line looks wrong -- what moved, and which came first?" A cost rise on
-- Monday and the price rise that answered it on Tuesday are one story, and two
-- tables make the screen interleave them by timestamp to tell it -- which is
-- the join a single table already does correctly, including for rows written in
-- the same second by the same GRV.
--
-- So a `kind` discriminates, and price_structure_id becomes NULL-able: a cost
-- belongs to the product, not to a price type. The existing rows are all prices
-- and are stamped as such by the backfill below.
ALTER TABLE product_price_history
  ADD COLUMN IF NOT EXISTS kind VARCHAR(8) NOT NULL DEFAULT 'price' AFTER product_id;

-- Which cost column moved: 'last' or 'average'. NULL on a price row.
--
-- Both are recorded because they answer different questions and a site reads
-- whichever its cost_basis names: average_cost is what a delivery BLENDS and
-- what stock is valued at, last_cost is what was last paid. A history that
-- collapsed them would show a product whose average crept up as though nothing
-- had happened, on exactly the sites that price off it.
ALTER TABLE product_price_history
  ADD COLUMN IF NOT EXISTS cost_column VARCHAR(8) NULL AFTER kind;

-- A cost is the product's own figure, not a price type's.
--
-- MariaDB will not drop NOT NULL while the FK stands, so the constraint comes
-- off, the column is relaxed, and it goes back on. The FK is re-added with the
-- guarded syntax because this migration must be safe to re-run.
ALTER TABLE product_price_history
  DROP FOREIGN KEY IF EXISTS fk_pph_structure;

ALTER TABLE product_price_history
  MODIFY COLUMN price_structure_id INT UNSIGNED NULL;

ALTER TABLE product_price_history
  ADD FOREIGN KEY IF NOT EXISTS fk_pph_structure (price_structure_id)
    REFERENCES price_structures (id) ON DELETE CASCADE;

-- Everything already on file was written by writePriceRows, so it is a price.
-- The column default covers new rows; this covers the ones already there on a
-- site that has been running since 144.
UPDATE product_price_history SET kind = 'price' WHERE kind = '' OR kind IS NULL;

-- The panel reads one product's whole story newest-first, both kinds together,
-- which is this index exactly. ix_pph_product (product_id, created_at) already
-- serves it; this one narrows to a single kind for the cost-only questions
-- ("when did this product's cost last move") without scanning the price rows.
ALTER TABLE product_price_history
  ADD KEY IF NOT EXISTS ix_pph_kind (product_id, kind, created_at);
