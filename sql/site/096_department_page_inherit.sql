-- Letting one department page stand in for the departments beneath it.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file; the column exists on that database and no
-- other. Shape taken from SHOW FULL COLUMNS on the live table. Nothing in src/
-- reads it - the builder screens that did were lost on 2026-08-09 (see
-- RECOVERY-NOTES.md), so restoring the column keeps a new site matching master
-- rather than completing a feature.
--
-- Put on the parent page so a single switch covers a branch as it grows; a
-- comment is included to explain the purpose.
ALTER TABLE storefront_pages
  ADD COLUMN IF NOT EXISTS applies_to_children TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'department pages: also render on descendant departments with no page of their own';

