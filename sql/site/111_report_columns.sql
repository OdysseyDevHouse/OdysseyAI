-- Which columns a REPORT shows, and in what order, decided once for the store.
--
-- ── WHY A SECOND TABLE AND NOT list_columns (109) ────────────────────────
--
-- 109 answers the same question for LIST SCREENS, and the two look alike enough
-- to merge. They are kept apart because their id spaces are different and only
-- one of them is open-ended: a list key is one of a handful of screens this
-- application ships, while a report id is either a built-in template key or
-- 'saved:12' — a row in saved_reports that a user created this morning. Sharing
-- one table would mean one key space where a store's saved report could collide
-- with a screen name.
--
-- ── WHY THIS ONE STORES ORDER AND 109 DOES NOT ───────────────────────────
--
-- 109 says, deliberately: "Order is NOT stored: a list that renders its columns
-- in a different order per store is a support call nobody can reproduce." That
-- reasoning holds for a list, whose column order is fixed by the catalogue the
-- application ships.
--
-- A report is the opposite. Its column order is AUTHORED — the builder has had
-- move-up and move-down buttons since it shipped, under a heading that reads
-- "Showing, in this order" — and reordering a report is simply editing it. What
-- was missing is only the ability to do that to a BUILT-IN report without
-- cloning it into a copy, which was the sole option before this table.
--
-- (109 is amended alongside this migration so lists may be reordered too. The
-- comment quoted above no longer describes the code; see 112.)
--
-- ── WHAT IS STORED ───────────────────────────────────────────────────────
--
-- An ORDERED JSON array of visible OUTPUT keys — ReportColumn.key, the same
-- string the grid, the CSV, the spreadsheet and the scheduled email all key
-- off. Not SpecColumn.field: the same field may legitimately appear twice with
-- different aggregates (the spec explicitly allows it), so a field key cannot
-- identify a column and an output key always can.
--
-- The VISIBLE set, never the hidden one. A column added to a template in a
-- later release is then absent from every stored row and stays hidden until
-- somebody asks for it, rather than appearing unannounced in every store. Same
-- rule and same reasoning as 109.
--
-- Unknown keys are dropped on read, so a field renamed or removed from the
-- catalogue needs no migration here.
--
-- ── PER STORE, NOT PER USER ──────────────────────────────────────────────
--
-- The opposite call to report_favorites (054), and deliberately. A favourite is
-- "the four reports I run every morning" — a fact about a person. Which columns
-- a report carries is a fact about how the SHOP reads it, and a store that does
-- not use pack weights wants that column gone for everyone.

CREATE TABLE IF NOT EXISTS report_columns (
  -- The resolver's id space, exactly as report_favorites.report_id uses it: a
  -- built-in template key ('sales-by-product') or 'saved:12'. One row per
  -- report, whichever kind it is — which is what lets a built-in be customised
  -- without first being cloned into a copy.
  report_id   VARCHAR(64) NOT NULL,
  -- Ordered JSON array of visible output keys.
  columns     TEXT        NOT NULL,
  updated_by  INT UNSIGNED NULL,
  updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (report_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── A correction to the record, while we are here ────────────────────────
--
-- 015_sales_core.sql:169-170 still documents two states:
--
--     void      — finalised then reversed the same day. Keeps its number.
--     cancelled — a quote or order abandoned. Never had a number.
--
-- That has not been true since 022, which merged them: "'void' and 'cancelled'
-- merge into one state. They always meant the same thing — a posted document
-- undone — and only 'void' was ever written." The surviving value is
-- 'cancelled'.
--
-- The comment is left in place in 015 because editing an applied migration
-- changes nothing and misleads the next reader. It is corrected here instead,
-- where anybody reading the history in order will meet it.
--
-- The reporting is renamed to match in the same change: a person should never
-- read the word "void" for a state the database stopped having. The template
-- IDS keep the old spelling on purpose — they are stored in report_favorites
-- and report_schedules, so renaming one would orphan every favourite and
-- silently stop a scheduled email. Ids are data; names are display.
