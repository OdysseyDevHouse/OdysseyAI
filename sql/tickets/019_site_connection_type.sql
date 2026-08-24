-- ============================================================================
-- 019_site_connection_type.sql — backoffice_type becomes connection_type
-- ============================================================================
--
-- src/lib/sites.ts selects cp2_sites.connection_type and has done since the
-- hybrid-till work landed. The column does not exist here: what is present is
-- the older backoffice_type ENUM(windows, cloud). Every sign-in therefore dies
-- in listSitesForUser with "Unknown column s.connection_type in SELECT".
--
-- sql/tickets/011_local_backend.sql already describes this rename as done --
-- "It was named backoffice_type, windows | cloud, when this ran. The column was
-- renamed and widened later" -- but no migration in this directory ever
-- performed it. The comment recorded an intention, not a change. This file is
-- the change.
--
-- ── THIS ALTERS A TABLE THE v2 BACKEND OWNS ─────────────────────────────────
--
-- The second such exception, after 005 altered cp2_devices. Same reasoning and
-- the same cost, stated plainly: any v2 code still selecting backoffice_type
-- breaks the moment this runs. Taken deliberately, with the owner asked and
-- answering rename rather than add-alongside.
--
-- The alternative was a new connection_type column with backoffice_type left in
-- place. That keeps v2 running, but it leaves two columns describing the same
-- property of a site, with the control panel writing one and this app reading
-- the other. They drift the first time somebody changes a site in v2, and the
-- drift is silent -- a hybrid site quietly served as cloud. One authoritative
-- column is worth the rename.
--
-- ── WHY THE VALUES CHANGE MEANING, NOT JUST THE NAME ────────────────────────
--
-- backoffice_type answered "where does the back office run": windows or cloud.
-- connection_type answers a different question -- "where does the master
-- database live": cloud, local or hybrid. See docs/plans/hybrid-till-server.md
-- Part 1.
--
-- So this is not a pure rename and the old values cannot survive it. Mapping:
--
--   windows -> cloud      a Windows back office still talked to our servers
--   cloud   -> cloud      unchanged
--
-- Both collapse to cloud because local and hybrid did not exist when any of
-- these rows were written. No site can already be one, and cloud is the value
-- the plan calls the default. A site that should be local or hybrid is set that
-- way afterwards, in the control panel, deliberately.
--
-- ── WHY THREE STATEMENTS AND NOT ONE CHANGE COLUMN ──────────────────────────
--
-- Going straight to ENUM(cloud, local, hybrid) would meet rows holding windows,
-- which is not a member of the new set. MariaDB does not reject those rows -- it
-- coerces each to the empty string and warns. The site rows would survive with
-- a connection_type that matches nothing the app understands, and tabRouting
-- would read it forever. So the enum is widened to the union first, the rows
-- are moved onto a value that exists in both sets, and only then is the column
-- renamed and narrowed.
--
-- DDL auto-commits, so every statement is guarded on information_schema and the
-- file is safe to re-run -- including after a partial failure, where the column
-- may be found under either name.
--
-- NOTE: no apostrophes in comments in this file, per the warning in
-- sql/site/029_rename_void_columns.sql. The runner sends the file as one
-- multipleStatements batch and MariaDB reads a lone apostrophe inside a --
-- comment as opening a string literal, swallowing the SQL that follows.
-- ============================================================================

-- ── 1. Widen the old column to the union of both value sets ─────────────────
-- Nothing is renamed yet. This only makes cloud, local and hybrid legal
-- alongside windows, so the UPDATE below has somewhere to land.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cp2_sites'
      AND COLUMN_NAME = 'backoffice_type') = 1,
  'ALTER TABLE cp2_sites MODIFY COLUMN backoffice_type
     ENUM(''windows'',''cloud'',''local'',''hybrid'') NOT NULL DEFAULT ''cloud''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 2. Move every windows row onto cloud ────────────────────────────────────
-- Guarded too: on a re-run after step 3 succeeded there is no backoffice_type
-- column and an unguarded UPDATE would error.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cp2_sites'
      AND COLUMN_NAME = 'backoffice_type') = 1,
  'UPDATE cp2_sites SET backoffice_type = ''cloud'' WHERE backoffice_type = ''windows''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── 3. Rename, and narrow to the three values the app knows ─────────────────
-- Runs only while the old name is still present AND the new one is not, so a
-- second pass is a no-op rather than an error.
SET @sql := IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cp2_sites'
      AND COLUMN_NAME = 'backoffice_type') = 1
  AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cp2_sites'
      AND COLUMN_NAME = 'connection_type') = 0,
  'ALTER TABLE cp2_sites CHANGE COLUMN backoffice_type connection_type
     ENUM(''cloud'',''local'',''hybrid'') NOT NULL DEFAULT ''cloud''',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
