-- ─────────────────────────────────────────────────────────────────────────
-- Technician vans: stock that lives on a bakkie.
--
-- ── A VAN IS A LOCATION, AND THAT IS THE WHOLE MODEL ─────────────────────
--
-- 101_store_transfers established the shape: model the vehicle AS a location, so
-- every invariant survives a two-day move with no special case. A van holds a
-- real pile, movements against it must be attributable, and
-- product_location_stock gives all of that for free.
--
-- The alternative — a technician_stock table — forks the pile and immediately
-- breaks invariant (C) in stockMovements.ts: Sigma piles = products.stock_on_hand.
-- Every product in a van would report as drift, forever, and a reconciliation
-- report that always shows rows is one nobody reads.
--
-- ── WHY is_transit COULD NOT BE REUSED ───────────────────────────────────
--
-- It already means something specific and incompatible: goods dispatched to
-- another SITE, written only by storeTransfers.ts, and hidden from every picker.
-- Its own comment in stockLocations.ts even calls it "the van, not a room" —
-- but read the next clause: "nobody sells from a truck, counts one, or transfers
-- into one by hand."
--
-- A technician van is the opposite on all three counts. It must be VISIBLE in a
-- transfer picker (that is how stock gets there), COUNTABLE (a van stocktake is a
-- real business need), and transferable into by hand. Reusing is_transit would
-- silently hide every van from the stock-take scope picker and the transfer
-- screens — a feature that appears to exist and cannot be reached.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT ADD ─────────────────────────────
--
-- NO user_id on stock_locations. A van is not one person: a vehicle is driven by
-- whoever is on shift, two technicians share a bakkie, and a technician taking a
-- different van while theirs is serviced would mean editing a stock location.
-- Worse, cp2_users lives in the CONTROL database so no FK is possible, and
-- nothing would stop the column pointing at a departed user.
--
-- Whose van it is resolves from job_appointment_assignees, which 106 already
-- built. A dated assignment table can come later if anybody asks.
--
-- NO reservation columns. Reservation in this codebase is DERIVED, never stored —
-- see the header of salesOrders.ts. Job reservations were designed and cut from
-- this phase: issuing a part to a van does not release its reservation, so the
-- same unit would be deducted twice from availableToSell (which reads the MAIN
-- pile and subtracts a site-wide reservation), permanently, for every part in
-- every van. That needs issued_qty below to exist first, and it needs a quarter
-- of the column being correct before it is folded into the till's read path.
--
-- ── ORDERING: THE RISKY ALTER COMES FIRST ────────────────────────────────
--
-- DDL auto-commits, so a file that fails halfway leaves the earlier statements
-- applied and no row in schema_migrations. Both ALTERs here touch tables with
-- production rows, so they go before anything else: if one fails, the state is
-- "nothing landed" rather than "half landed", and a re-run is clean.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. The van flag ──────────────────────────────────────────────────────
-- Note the MariaDB form: `ADD COLUMN IF NOT EXISTS`. For a foreign key it would
-- be `ADD FOREIGN KEY IF NOT EXISTS <name>` — MariaDB does NOT accept
-- `ADD CONSTRAINT IF NOT EXISTS <name> FOREIGN KEY`.
ALTER TABLE stock_locations
  -- A pile that moves. Visible in the transfer and stock-take pickers, hidden
  -- from the ones where it would be wrong (goods received, reorder suggestions):
  -- a supplier does not deliver into a bakkie, and a buyer does not reorder to
  -- one. See LOCATION_PURPOSE in stockLocations.ts, which is what decides.
  --
  -- setMainLocation() refuses this flag for the reason its own comment already
  -- gives about is_transit: pointing the till at a van would have the counter
  -- promise goods that are on a motorway.
  ADD COLUMN IF NOT EXISTS is_mobile TINYINT(1) NOT NULL DEFAULT 0 AFTER is_transit;

-- ── 2. What is on the van for this job ───────────────────────────────────
ALTER TABLE job_card_lines
  -- How much of this line has physically left the building.
  --
  -- Not for reservations — for the WORKLIST. "What is on my bakkie for this job
  -- that I have not billed yet" is the question a technician and a parts clerk
  -- both ask, and it is unanswerable without this.
  --
  -- Declared now because it cannot be backfilled: the transfers that moved the
  -- stock are recoverable, but which job line each one was FOR is not. Same
  -- reasoning as movement_id, time_entry_id and travel_id in 104, all of which
  -- shipped unwritten for exactly this purpose.
  ADD COLUMN IF NOT EXISTS issued_qty DECIMAL(12,3) NOT NULL DEFAULT 0.000 AFTER invoiced_qty,

  -- The worklist read: parts on a van for this job, not yet billed.
  ADD KEY IF NOT EXISTS ix_jcl_issued (job_card_id, issued_qty);

-- ── 3. Which transfer moved which job line ───────────────────────────────
-- The link that makes reconcileJobParts() possible: without it, "do the movements
-- sum to what the line claims was issued" cannot be asked, and issued_qty becomes
-- a number nothing checks.
--
-- On the TRANSFER line rather than the job line, because one transfer carries
-- several job lines and one job line may be issued across two transfers. A single
-- column on either side could not express that.
ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS job_card_line_id INT UNSIGNED NULL AFTER product_id,
  ADD KEY IF NOT EXISTS ix_stline_job_line (job_card_line_id),
  -- SET NULL, not CASCADE: a posted transfer is a record of goods that really
  -- moved, and it must outlive the job line it was raised for.
  ADD FOREIGN KEY IF NOT EXISTS fk_stline_job_line (job_card_line_id)
    REFERENCES job_card_lines (id) ON DELETE SET NULL;

-- ── 4. Settings ──────────────────────────────────────────────────────────
-- Whether a van may be picked as the source of a sale. Off, and there is no
-- screen to turn it on: it exists so the guard has something to read and so the
-- decision is recorded rather than implied. availableToSell reads the MAIN pile,
-- so a van is not sellable stock by construction.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_van_sellable', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
