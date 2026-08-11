-- ─────────────────────────────────────────────────────────────────────────
-- Store transfers: moving stock between two SITES, which is two databases.
--
-- 026 built transfers between locations inside one site and said, in its own
-- header, that goods in transit are not modelled because the walk between two
-- rooms takes a minute. That reasoning was right for rooms and is wrong the
-- moment the two ends are different buildings with different databases.
--
-- ── WHY THIS IS NOT JUST ANOTHER LOCATION ────────────────────────────────
--
-- A STORE is a site: its own row in cp2_sites, its own master database, its own
-- product ids. 003_drop_stores.sql settled that and 025 repeated it. So a store
-- transfer cannot be one document with two location ids, because the far end
-- does not exist in this database and never will.
--
-- It is TWO documents, one in each database, pointing at each other by id:
--
--   in the SENDER    direction = out,  peer_site_id = the receiver
--   in the RECEIVER  direction = in,   peer_site_id = the sender
--
-- Lines match by product CODE, never id — ids increment independently in each
-- database, which is the same rule cp2_store_groups already works by.
--
-- ── IN TRANSIT IS A REAL LOCATION, AND THAT IS THE WHOLE TRICK ───────────
--
-- 026 said: a site that genuinely needs goods in transit should model the van
-- AS a location. This does exactly that, and it is what lets every invariant
-- survive a move that takes two days and two databases.
--
--   DISPATCH, in the sender only:
--     transfer_out  -qty  from the real source
--     transfer_in   +qty  into TRANSIT
--
--   The sender still owns the goods, which is correct: they are on its truck
--   and on its balance sheet. Its total is unchanged, so (A), (B) and (C) all
--   hold with no special case anywhere.
--
--   RECEIVE, which is two commits in two databases:
--     in the RECEIVER   transfer_in  +qty  into the chosen location
--     in the SENDER     transfer_out -qty  out of TRANSIT
--
--   Each database keeps its own invariants at every moment. What cannot be made
--   atomic is the pair, because there is no distributed transaction here and
--   pretending otherwise would be worse than saying so.
--
-- ── THE ORDER OF THOSE TWO COMMITS IS DELIBERATE ─────────────────────────
--
-- The RECEIVER commits FIRST, then the sender settles.
--
-- If the second commit fails, the goods are briefly counted twice across the
-- group: sitting in the senders TRANSIT and on the receivers shelf. That is
-- visible (the sender doc still reads in_transit while the receiver doc names
-- it as received) and it is REPAIRABLE, because settling the sender is
-- idempotent — it only fires while the document is still in_transit.
--
-- The other order loses the goods entirely: they leave the sender, the receiver
-- never records them, and no document anywhere says where they went. A figure
-- that is briefly too high and self-heals beats one that is silently too low.
--
-- ── COST DOES MOVE, UNLIKE AN INTERNAL TRANSFER ──────────────────────────
--
-- 026 is emphatic that a transfer must not touch average_cost: the goods are
-- the same goods in a different room. Across stores that stops being true. The
-- receiver did not own these units a moment ago, and if they land without a
-- cost its stock valuation is wrong from that second on. So the receiver folds
-- the senders cost into its own weighted average exactly as a GRV does, and the
-- sender does not move its average at all — goods left at cost.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. A location that means "on the road" ───────────────────────────────
-- Flagged rather than found by code, because a site is free to rename it and
-- because every picker has to be able to exclude it without string matching.
ALTER TABLE stock_locations
  ADD COLUMN IF NOT EXISTS is_transit TINYINT(1) NOT NULL DEFAULT 0 AFTER is_main;

ALTER TABLE stock_locations
  ADD KEY IF NOT EXISTS ix_location_transit (is_transit);

-- Every site gets one, whether or not it is linked to anything. A dispatch has
-- to have somewhere to put the goods, and creating it lazily would mean the
-- first transfer of the day is the one that discovers the schema is incomplete.
--
-- NOT is_main and NOT deletable in practice: it accrues movements the moment it
-- is used, and deleteLocation already refuses a location with history.
INSERT INTO stock_locations (code, name, is_main, is_transit, is_active, sort_order, note)
SELECT 'TRANSIT', 'In transit', 0, 1, 1, 9000,
       'Goods dispatched to another store and not yet received. Managed by the system.'
 WHERE NOT EXISTS (SELECT 1 FROM stock_locations WHERE is_transit = 1);

-- ── 2. The document learns about the other store ─────────────────────────
ALTER TABLE stock_transfers
  --   internal  between two locations in this site, exactly as 026 built it
  --   out       dispatched from here to another store
  --   in        received here from another store
  ADD COLUMN IF NOT EXISTS direction ENUM('internal','out','in') NOT NULL DEFAULT 'internal' AFTER document_date;

ALTER TABLE stock_transfers
  -- The other sites id in cp2_sites, in the control database. Deliberately NOT
  -- a foreign key: that table lives in a different database, and a site can
  -- leave a group without this documents history becoming unreadable.
  ADD COLUMN IF NOT EXISTS peer_site_id INT UNSIGNED NULL AFTER direction;

ALTER TABLE stock_transfers
  -- Copied at capture, like every other denormalised label on a document. The
  -- transfer has to keep saying which store it went to even if that store is
  -- later renamed, unlinked, or unreachable.
  ADD COLUMN IF NOT EXISTS peer_site_name VARCHAR(190) NULL AFTER peer_site_id;

ALTER TABLE stock_transfers
  -- The matching row in the other stores database, and its number. Both NULL
  -- until the far end exists: a dispatch has no receipt yet.
  ADD COLUMN IF NOT EXISTS peer_transfer_id INT UNSIGNED NULL AFTER peer_site_name;

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS peer_document_number VARCHAR(32) NULL AFTER peer_transfer_id;

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS dispatched_at DATETIME NULL AFTER posted_at;

ALTER TABLE stock_transfers
  ADD COLUMN IF NOT EXISTS received_at DATETIME NULL AFTER dispatched_at;

ALTER TABLE stock_transfers
  ADD KEY IF NOT EXISTS ix_transfer_peer (peer_site_id, status);

ALTER TABLE stock_transfers
  ADD KEY IF NOT EXISTS ix_transfer_direction (direction, status, document_date);

-- ── 3. The source location becomes optional ──────────────────────────────
-- An INBOUND document has no local source: the goods came out of another
-- database entirely, and the only honest value is NULL. An OUTBOUND one keeps
-- both — its destination is this sites TRANSIT location.
--
-- MODIFY rather than a guarded rename: re-running it is harmless because the
-- resulting definition is identical.
ALTER TABLE stock_transfers
  MODIFY COLUMN from_location_id INT UNSIGNED NULL;

-- ── 4. Two more states ───────────────────────────────────────────────────
--   draft       being built, nothing has moved             (unchanged)
--   posted      an INTERNAL transfer, both halves written  (unchanged)
--   in_transit  dispatched, sitting in the senders TRANSIT
--   received    the far end confirmed it, both sides settled
--   cancelled   reversed                                   (unchanged)
--
-- Only ADDING values, so one MODIFY is enough and is re-runnable — the widen,
-- update, narrow dance in 029 is for values that go away, and none do here.
ALTER TABLE stock_transfers
  MODIFY COLUMN status ENUM('draft','posted','in_transit','received','cancelled')
    NOT NULL DEFAULT 'draft';

-- ── 5. What actually arrived ─────────────────────────────────────────────
-- A truck can arrive with less than it left with, and the whole point of a
-- two-step transfer is that the receiver gets to say so.
--
-- NULL means the question does not apply: an internal transfer arrives the
-- instant it leaves, and a dispatch has not been answered yet. A number means
-- the receiver counted, and a number BELOW qty is a loss that the sender wears
-- — see settleDispatch in storeTransfers.ts, which clears the shortfall out of
-- TRANSIT as an adjustment rather than a transfer, because nothing received it.
ALTER TABLE stock_transfer_lines
  ADD COLUMN IF NOT EXISTS qty_received DECIMAL(12,3) NULL AFTER qty;

-- ── 6. Lines carry the code the far end will match on ────────────────────
-- product_code already exists on the line and is already copied at capture, so
-- there is nothing to add — but it stops being merely a label here and becomes
-- the join key, so it must never be null on a store transfer. That is enforced
-- in storeTransfers.ts rather than by the schema, because an INTERNAL transfer
-- has no such need and a NOT NULL would break 026 documents that predate this.

-- ── 7. Every existing transfer is internal ───────────────────────────────
-- The column default already says so for new rows; this states it for the rows
-- that were written before the column existed, so a query filtering on
-- direction never silently misses history.
UPDATE stock_transfers SET direction = 'internal' WHERE direction IS NULL;
