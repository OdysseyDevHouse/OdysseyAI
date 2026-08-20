-- ─────────────────────────────────────────────────────────────────────────
-- Which pile THIS till sells out of.
--
-- Until now every sale came off the MAIN location, always. `recordMovement`
-- falls back to `mainLocationIdTx` when a caller names no location, and
-- salesPosting.ts was the one module in the system that named none — so a shop
-- with a shop floor and a storeroom had both tills eating the same pile, and
-- the storeroom's count only ever moved when somebody transferred by hand.
--
-- That is wrong for a big store in the ordinary way: the front counter sells
-- off the floor, the trade hatch at the back sells out of the storeroom, and
-- the two piles are different goods in different rooms. The machine is what a
-- person stands at, so the machine is what the room belongs to — exactly the
-- reasoning 180_terminal_pos_mode.sql used for which SCREEN a till runs.
--
-- ── WHY NOT REUSE terminals.location ─────────────────────────────────────
--
-- There is already a `location` column on this table and it is NOT this. It is
-- free text — "Front counter", "Next to the door" — a label printed for a human
-- who is looking for the machine. It has no FK, no numeric form, and shops are
-- free to type anything in it.
--
-- Overloading it would mean matching a stock room by a string somebody typed,
-- which is the bug where renaming a location silently re-points a till at MAIN.
-- The new column is a real reference and the old one keeps its job.
--
-- ── NULL MEANS MAIN, AND THAT IS A REAL ANSWER ───────────────────────────
--
-- Unlike pos_mode, which took a NOT NULL DEFAULT, this stays nullable.
--
-- A till with nothing set is not a till that is broken or half-configured — it
-- is the ordinary single-room shop, which is most shops, and which must never
-- be made to answer a question it does not have. NULL is read as "the main
-- location", resolved at the moment of the sale by the same `mainLocationIdTx`
-- that has always been the fallback. So the default behaviour is byte-for-byte
-- what it was before this migration, for every existing till.
--
-- Writing the resolved main id into every row instead would look tidier and be
-- worse: it would freeze today's answer, so a shop that later moves "main" to
-- another room would find its tills still pointing at the old one, with nothing
-- on screen to explain why.
--
-- ── ON DELETE SET NULL ───────────────────────────────────────────────────
--
-- deleteLocation() already refuses a location with stock or movements against
-- it, so a room a till is selling from is essentially undeletable in practice.
-- If one ever does go, the till must keep trading — falling back to main is
-- exactly what a NULL means here, so SET NULL degrades to the safe default
-- rather than RESTRICTing a setup screen or orphaning a row.
-- ─────────────────────────────────────────────────────────────────────────

-- INT UNSIGNED, matching stock_locations.id exactly. A plain INT here is
-- accepted by the ALTER and then rejected by the FK with errno 150 ("Foreign
-- key constraint is incorrectly formed"), which names neither column — so the
-- signedness is worth stating loudly rather than inferring.
ALTER TABLE terminals
  ADD COLUMN IF NOT EXISTS stock_location_id INT UNSIGNED NULL
    AFTER pos_mode;

-- Corrects a database that took the column from an earlier draft of this file,
-- where it was a signed INT. DDL auto-commits, so that column survived the
-- failed FK step and ADD COLUMN IF NOT EXISTS will not revisit it — leaving a
-- site permanently unable to apply the constraint below. A no-op everywhere
-- else, because MODIFY to the type it already has changes nothing.
ALTER TABLE terminals
  MODIFY COLUMN stock_location_id INT UNSIGNED NULL;

ALTER TABLE terminals
  ADD KEY IF NOT EXISTS ix_terminal_stock_location (stock_location_id);

-- MariaDB: ADD FOREIGN KEY IF NOT EXISTS <name>, never ADD CONSTRAINT IF NOT EXISTS.
ALTER TABLE terminals
  ADD FOREIGN KEY IF NOT EXISTS fk_terminal_stock_location (stock_location_id)
    REFERENCES stock_locations (id) ON DELETE SET NULL;
