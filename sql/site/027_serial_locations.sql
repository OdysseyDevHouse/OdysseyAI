-- ─────────────────────────────────────────────────────────────────────────
-- Which room each individual unit is in.
--
-- 025 gave every pile a location and 026 let stock move between them. Serials
-- were left behind: product_serials predates locations, so a serialised
-- product could say "12 in the warehouse, 3 on the shop floor" while the 15
-- serials themselves sat nowhere in particular.
--
-- That gap is not cosmetic. It breaks the promise serials exist for. A
-- customer arrives with a faulty handset, the desk looks it up, and the system
-- can say who bought it but not which shelf its replacement is on.
--
-- ── THE INVARIANT GETS SHARPER ───────────────────────────────────────────
--
-- 021_serials.sql promised, for a serial product:
--
--   (S1)  count(serials WHERE status='in_stock')  =  products.stock_on_hand
--
-- Locations refine it to a per-room version, which is strictly stronger:
--
--   (S2)  count(in_stock serials IN location L)   =  the pile in L
--
-- (S2) implies (S1) by summing over locations, exactly as invariant (B)
-- implies (A). And it catches what (S1) cannot: a transfer that moved the
-- quantity but left the serials pointing at the room the goods left.
--
-- ── WHY NULLABLE, AND WHY THAT IS NOT A LOOPHOLE ─────────────────────────
--
-- location_id is NULL only for a sold, returned or written-off unit — one that
-- is not in stock anywhere, and for which naming a room would be a lie. An
-- in_stock serial must always have one, and reconcileSerials treats an
-- in_stock serial with a NULL location as drift rather than ignoring it.
--
-- Making the column NOT NULL would force sold units to keep claiming a shelf
-- they no longer occupy, which is a worse lie than the one it prevents.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Where the unit is ─────────────────────────────────────────────────
ALTER TABLE product_serials
  ADD COLUMN IF NOT EXISTS location_id INT UNSIGNED NULL AFTER product_id;

-- ── 2. Existing in-stock units are wherever their product says they are ──
--
-- Before locations there was one pile, so every in_stock serial belongs to
-- whichever location holds that product. Preferring the pile that actually has
-- stock over blindly using main matters for a site that has already received
-- serialised goods into a warehouse: those units are there, not on the shop
-- floor.
--
-- The ORDER BY makes the choice deterministic — the fullest pile wins, and main
-- breaks a tie — so a re-run cannot land the same serial somewhere different.
UPDATE product_serials s
   SET s.location_id = (
     SELECT pls.location_id
       FROM product_location_stock pls
       JOIN stock_locations l ON l.id = pls.location_id
      WHERE pls.product_id = s.product_id
        AND pls.stock_on_hand > 0
      ORDER BY pls.stock_on_hand DESC, l.is_main DESC, l.id ASC
      LIMIT 1
   )
 WHERE s.status = 'in_stock' AND s.location_id IS NULL;

-- Anything still unplaced — an in_stock serial whose product holds no stock in
-- any location, which is itself a drift reconcileSerials would report — goes to
-- main so the column is never half-populated for in_stock units.
UPDATE product_serials
   SET location_id = (SELECT id FROM stock_locations WHERE is_main = 1 ORDER BY id LIMIT 1)
 WHERE status = 'in_stock' AND location_id IS NULL;

-- A sold or written-off unit is deliberately left NULL: it is not in a room.

-- ── 3. Indexes and the constraint ────────────────────────────────────────
-- "What serials are in this room" — the picking question, and the one
-- reconcileSerials groups by.
ALTER TABLE product_serials
  ADD KEY IF NOT EXISTS ix_serial_location (location_id, status);

-- The exact shape of the per-location count: product, room, status.
ALTER TABLE product_serials
  ADD KEY IF NOT EXISTS ix_serial_product_location (product_id, location_id, status);

-- RESTRICT, matching every other reference to a location: a room holding
-- serialised units cannot be deleted out from under them.
--
-- Note the MariaDB form — `ADD FOREIGN KEY IF NOT EXISTS <name> (cols)`. It
-- does NOT accept `ADD CONSTRAINT IF NOT EXISTS <name> FOREIGN KEY`.
ALTER TABLE product_serials
  ADD FOREIGN KEY IF NOT EXISTS fk_serial_location (location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT;

-- ── 4. Serial movements record the room too ──────────────────────────────
-- Without this, a transfer of a serialised unit records that it moved but not
-- between where and where — and the warranty desk, which reads this table, gets
-- a history that says less than the quantity ledger does.
ALTER TABLE serial_movements
  ADD COLUMN IF NOT EXISTS from_location_id INT UNSIGNED NULL AFTER document_line_id;

ALTER TABLE serial_movements
  ADD COLUMN IF NOT EXISTS to_location_id INT UNSIGNED NULL AFTER from_location_id;

ALTER TABLE serial_movements
  ADD FOREIGN KEY IF NOT EXISTS fk_smove_from (from_location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT;

ALTER TABLE serial_movements
  ADD FOREIGN KEY IF NOT EXISTS fk_smove_to (to_location_id)
    REFERENCES stock_locations (id) ON DELETE RESTRICT;
