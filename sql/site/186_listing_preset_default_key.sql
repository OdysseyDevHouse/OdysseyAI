-- ─────────────────────────────────────────────────────────────────────────
-- The shop's default listing must be ONE row.
--
-- 185 marked the shop's default with `department_id IS NULL` and put a UNIQUE
-- index on the column to keep it single. That does not work: in MySQL a UNIQUE
-- index does not constrain NULLs — any number of rows may hold one — so
-- `ON DUPLICATE KEY UPDATE` never matched, and every save of the shop default
-- INSERTED another row instead of updating the one already there.
--
-- The symptom is worse than a duplicate. `shopListingPreset` reads with no
-- ORDER BY, so the shop's settings became whichever row the engine returned
-- first: saving 2 columns and reading back 3 was the actual failure, and it
-- looked like a caching bug rather than a schema one.
--
-- ── WHY A SENTINEL AND NOT A SECOND TABLE ────────────────────────────────
--
-- 0 rather than NULL for "the shop's default". A separate one-row table for the
-- shop and a per-department table beside it would make the uniqueness free, but
-- it would also duplicate all eight columns and every read, and the cascade
-- would have to join two shapes that must never disagree. One table with a
-- reserved id keeps the cascade a single lookup.
--
-- 0 is safe as a sentinel because `departments.id` is AUTO_INCREMENT and
-- therefore never 0 — the FK is dropped for the same reason, since a sentinel
-- cannot point at a row.
-- ─────────────────────────────────────────────────────────────────────────

-- The FK first: it would refuse the sentinel.
ALTER TABLE online_listing_presets
  DROP FOREIGN KEY IF EXISTS fk_listing_department;

-- Collapse whatever duplicates 185 already allowed down to the newest, which is
-- the one the last save intended.
DELETE p FROM online_listing_presets p
  JOIN (
    SELECT MAX(id) AS keep_id FROM online_listing_presets WHERE department_id IS NULL
  ) newest
  WHERE p.department_id IS NULL AND p.id <> newest.keep_id;

UPDATE online_listing_presets SET department_id = 0 WHERE department_id IS NULL;

ALTER TABLE online_listing_presets
  MODIFY COLUMN department_id INT UNSIGNED NOT NULL DEFAULT 0;

-- Now the unique index means what it was meant to mean: NOT NULL, so a second
-- default row is a duplicate-key error rather than a silent insert.
