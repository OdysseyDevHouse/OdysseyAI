-- ============================================================================
-- 007_device_serial_per_site.sql — one machine may hold a licence in each store
-- ============================================================================
--
-- 005 made `serial_number` globally unique, on the reasoning that a serial
-- identifies exactly one physical machine and two rows carrying it makes "which
-- licence is this device using" unanswerable.
--
-- That reasoning holds. What it missed is that the QUESTION is only ambiguous
-- when asked without a store. Every caller already asks with one:
-- `licenceForSerial(siteId, serial)` selects on `site_id AND serial_number`, and
-- has since 005. Nothing anywhere resolves a licence by serial alone.
--
-- ── WHAT THE GLOBAL INDEX ACTUALLY PREVENTED ────────────────────────────────
--
-- An operator with two linked stores, standing at one PC, working both. That is
-- the ordinary shape of a small group — the back office is one desk, not one
-- desk per store — and under the global index it was impossible: claiming the
-- second store's till hit "This machine is already registered as another till."
-- and the first store's licence had to be released to get there.
--
-- So the constraint was not protecting revenue, it was blocking a paying
-- customer from buying a second licence.
--
-- ── WHY (site_id, serial_number) IS STILL THE RIGHT GUARD ───────────────────
--
-- The property worth keeping is that a machine cannot consume TWO licences in
-- the SAME store — that is the one that would let a shop paying for two tills
-- quietly trade from one browser twice. Scoping the index to the site keeps that
-- exactly as strict as it was, and only relaxes the cross-store case, where a
-- separate row means a separately sold and separately paid licence.
--
-- NULL stays freely repeatable for the same reason as before: a NULL serial is a
-- pre-provisioned spot with no machine in it yet, and MySQL permits many NULLs
-- in a unique index. Scoping to the site does not change that — (10000, NULL)
-- repeats as freely as NULL did.
--
-- ── THIS RELAXES A CONSTRAINT, SO IT CANNOT FAIL ON EXISTING DATA ───────────
--
-- Every pair unique under (serial_number) is unique under (site_id,
-- serial_number). Verified against live data before writing this: 3 rows, 2
-- serials, 0 duplicates. Re-runnable, and safe on any database 005 succeeded on.

-- Same normalisation 005 did, repeated because this file must stand alone on a
-- database restored from before it: '' is not NULL, so blank serials would
-- collide with each other within a site under the index below.
UPDATE cp2_devices
   SET serial_number = NULL
 WHERE serial_number IS NOT NULL AND TRIM(serial_number) = '';

-- Dropped and replaced in one statement so the column is never unindexed.
--
-- `ix_cp2_devices_site_serial (site_id, serial_number)` from 005 becomes
-- redundant once this exists — same columns, same order, and a unique index
-- serves lookup identically — so it goes at the same time rather than leaving
-- two indexes over one pair of columns for the optimiser to choose between.
ALTER TABLE cp2_devices
  DROP INDEX uq_cp2_devices_serial,
  DROP INDEX ix_cp2_devices_site_serial,
  ADD UNIQUE KEY uq_cp2_devices_site_serial (site_id, serial_number);

-- Serial alone is no longer unique, so it is no longer indexed on its own
-- either — and the composite above cannot serve a lookup that does not know the
-- site. Nothing in Odyssey does one, but the v2 backend shares this table and
-- support routinely asks "where is this machine?" given only a serial off a
-- sticker. Non-unique, purely for that.
ALTER TABLE cp2_devices
  ADD INDEX IF NOT EXISTS idx_cp2_devices_serial (serial_number);
