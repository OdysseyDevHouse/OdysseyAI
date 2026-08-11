-- A department page that also dresses its children.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file; the column exists on that database and no
-- other. Shape taken from SHOW FULL COLUMNS on the live table. Nothing in src/
-- reads it - the builder screens that did were lost on 2026-08-09 (see
-- RECOVERY-NOTES.md), so restoring the column keeps a new site matching master
-- rather than completing a feature.
--
-- 070_storefront_pages.sql allows exactly one page per department. Without this
-- flag a shop with a four-level department tree has to build and maintain a
-- layout for every leaf, which is the same layout copied dozens of times. Set
-- here, the page stands in for every department below it that has none of its
-- own; a child that IS given its own page still wins.
ALTER TABLE storefront_pages
  ADD COLUMN IF NOT EXISTS applies_to_children TINYINT(1) NOT NULL DEFAULT 0;
