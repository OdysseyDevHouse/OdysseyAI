-- ============================================================================
-- 005_pos_device_licensing.sql — a till may only trade from a licensed device
-- ============================================================================
--
-- Every POS device is a row in cp2_devices, and only a registered, entitled row
-- may ring up a sale. Before this, a till traded whether or not it had claimed a
-- terminal: `terminal_id` is nullable on sales_documents, the header showed an
-- amber "No till claimed" chip, and the sale posted anyway from the shared
-- invoice sequence. A shop paying for two tills could open ten browsers.
--
-- ── THIS ALTERS A TABLE THE v2 BACKEND OWNS ─────────────────────────────────
--
-- Every other migration in sql/tickets/ is strictly additive: new cp2_* tables,
-- nothing existing touched (see the note at the top of 001). This one is the
-- exception, taken deliberately and with the owner's agreement, because the
-- alternative — a parallel licence table keyed to cp2_devices.id — would put the
-- serial in two places and make "which row is authoritative" a question somebody
-- has to answer at 2am.
--
-- What that costs: v2 can no longer insert two devices with the same serial.
-- That is the intended constraint, but it IS a behaviour change in another
-- product. Checked against live data before writing this — zero rows, zero
-- duplicates, zero blank serials — so the ALTER cannot fail on existing data.
--
-- ── WHY UNIQUE, AND WHY NULLS STAY LEGAL ────────────────────────────────────
--
-- A serial identifies exactly one physical machine. Two rows carrying the same
-- serial makes "which licence is this device using" unanswerable, and a till
-- could quietly consume two.
--
-- But NULL must remain freely repeatable, because that is precisely what a
-- PRE-PROVISIONED spot is: a paid licence with no machine in it yet, waiting for
-- a browser to claim it. MySQL permits many NULLs in a unique index — the same
-- property sales_documents.document_number relies on — so one index gives both
-- "no two machines share a serial" and "as many unclaimed spots as were sold".
--
-- The empty string is the trap that would break this: '' is not NULL, so two
-- blank serials WOULD collide. Nothing writes '' today and the claim path writes
-- NULL or a real serial, but the guard below normalises any that appear before
-- the index is added.

-- Belt and braces: if v2 ever wrote '' for "no serial", those rows would all
-- collide with each other under the index below. Zero such rows today; this
-- makes the migration safe to re-run against a database where that changed.
UPDATE cp2_devices
   SET serial_number = NULL
 WHERE serial_number IS NOT NULL AND TRIM(serial_number) = '';

-- The non-unique index this replaces served lookup only. Dropping and re-adding
-- in one statement keeps the column indexed throughout.
ALTER TABLE cp2_devices
  DROP INDEX idx_cp2_devices_serial,
  ADD UNIQUE KEY uq_cp2_devices_serial (serial_number);

-- ── Which till this licence drives ──────────────────────────────────────────
--
-- terminal_id points at a row in the SITE database's `terminals` table, so no
-- foreign key is possible — different database, and that is also why it is a
-- plain column rather than a relationship. It is the link that gives a licensed
-- device its own invoice sequence instead of the shared one.
--
-- Nullable, and stays that way: a spot can be sold and provisioned before anyone
-- has decided which physical till it will be.
ALTER TABLE cp2_devices
  ADD COLUMN IF NOT EXISTS terminal_id INT UNSIGNED NULL AFTER serial_number;

-- When this device last proved it was alive. Written on each licence check, and
-- read by a manager deciding which spot is safe to release — a machine that has
-- not been seen for a month is the one whose licence a replacement should take.
ALTER TABLE cp2_devices
  ADD COLUMN IF NOT EXISTS last_seen_at DATETIME NULL;

-- Resolving a licence happens on every till sign-in and on the sale path, always
-- by (site, serial). Serial alone is already unique above, but the site column
-- keeps the lookup honest when a serial is absent and the query is listing a
-- site's free spots.
ALTER TABLE cp2_devices
  ADD INDEX IF NOT EXISTS ix_cp2_devices_site_serial (site_id, serial_number);
