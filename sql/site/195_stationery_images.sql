-- Pictures a shop can put on its printed documents.
--
-- ── WHY A TABLE AND NOT A SETTING ────────────────────────────────────────────
--
-- The logo is a setting: one answer per site that nothing joins to, exactly what
-- the settings header says belongs there. This is the other case. A shop puts
-- SEVERAL pictures on its documents — a CCTV installer showing the equipment it
-- fits, a workshop showing its accreditations — and each one is referenced by
-- name from any number of designs. Rows that other things point at earn a table.
--
-- ── WHAT IS STORED IS THE DISK NAME, NEVER A PATH ────────────────────────────
--
-- lib/uploads.ts generates a UUID plus a normalised extension, and that is all
-- that is kept. The name the browser sent is attacker-controlled; it is held
-- only to show the shop which picture is which while managing them, and is never
-- used to open a file.
--
-- ── THE MIME TYPE COMES FROM THE BYTES ───────────────────────────────────────
--
-- Derived from the VERIFIED magic bytes at upload, never from what the browser
-- claimed. The serving route re-sniffs on the way out and sends what it finds
-- rather than what this column says, so the two can never disagree about whether
-- a response is a picture — but the column is what the designer lists by, so it
-- has to be right too.
--
-- ── A PICTURE THAT GOES MISSING IS NOT AN ERROR ──────────────────────────────
--
-- A database restored without the uploads directory leaves rows pointing at
-- bytes that are gone. Every reader degrades to "no picture" and the document
-- prints without it, rather than showing a broken image to a customer. Same rule
-- the logo follows.

CREATE TABLE IF NOT EXISTS stationery_images (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The generated opaque name on disk. UNIQUE because it is the key the serving
  -- route resolves, and because two uploads of banner.png must not collide.
  stored_name  VARCHAR(190) NOT NULL,

  -- What the shop called it, so a list of pictures is navigable. Never a path.
  filename     VARCHAR(255) NOT NULL,

  -- What the shop chooses to call it in the designer, where the uploaded name is
  -- unhelpful ("IMG_4821.jpg"). Falls back to the filename when left empty.
  label        VARCHAR(120) NOT NULL DEFAULT '',

  -- From the verified magic bytes. See the header.
  mime_type    VARCHAR(40)  NOT NULL,
  size_bytes   BIGINT UNSIGNED NOT NULL DEFAULT 0,

  created_by      INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_stored_name (stored_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
