-- Documents and comments split per entity, so each half can follow its own file.
--
-- ── THE PROBLEM, WHICH HAS BEEN OPEN SINCE 197 ───────────────────────────
--
-- party_documents and party_comments are keyed by a loose (entity, entity_id)
-- pair with no foreign key, and the entity is 'customer' OR 'supplier' OR
-- 'job_card' OR 'ticket'. One table, four owners.
--
-- While only customers were shared that was survivable: both tables moved to
-- the customer owner and the supplier half went along for the ride, wrongly but
-- invisibly. docs/shared-customer-file-origin-site.md recorded it as open and
-- said to decide it with the supplier classification.
--
-- Sharing suppliers makes it unsurvivable. A supplier record moves to the
-- SUPPLIER owner while a customer record moves to the CUSTOMER owner, and the
-- two may be different databases — the flags are deliberately separate (015).
-- One table cannot follow both.
--
-- ── THE SPLIT ────────────────────────────────────────────────────────────
--
--   customer_documents / customer_comments   follow the customer file
--   supplier_documents / supplier_comments   follow the supplier file
--   job_documents      / job_comments        stay in the branch
--
-- Job cards and tickets were the argument that settled it. The old framing was
-- "two entities, so split in two or accept per-store" — but there were always
-- FOUR, and two of them have no reason to move at all: a job happens at a shop
-- and a ticket is raised at one. A table that already straddles three ownership
-- answers was never going to follow one file cleanly.
--
-- Tickets share the job tables rather than getting their own pair. Both are
-- branch-local work records, neither will ever move, and a fifth and sixth
-- table to express "also does not move" is structure for its own sake. The
-- entity column stays on all six for exactly this reason: it still distinguishes
-- a job from a ticket, and it would still distinguish a future branch-local
-- entity without another migration.
--
-- ── WHY THE BYTES NEED NOTHING ───────────────────────────────────────────
--
-- The obvious worry is that these rows describe FILES, and a row that moves to
-- another database would describe a file on the wrong disk. It does not arise:
--
--   · UPLOADS_ROOT (lib/uploads.ts) is resolved once per PROCESS, from
--     UPLOADS_DIR or cwd/uploads. It takes no siteId. One directory serves
--     every site the server hosts.
--   · Sharing already REQUIRES every member to be on the same MariaDB instance
--     as the primary (015, enforced in storeGroups.ts) — so branch and owner
--     are the same server, and therefore the same uploads directory.
--
-- A local-backend shop with its own machine and its own disk is the one case
-- where that would not hold, and the same-instance rule already excludes it
-- from a sharing group. So storeUpload writes where it always did, the download
-- route finds what it always found, and only the metadata moves.
--
-- If that ever stops being true — a group spanning two servers — this comment
-- is where to start, and the answer would be to write bytes to the owner's
-- disk rather than to move the rows back.
--
-- ── NO DATA IS MIGRATED, BECAUSE THERE IS NONE ───────────────────────────
--
-- Both tables are empty on every database that exists (verified, not assumed).
-- The INSERT...SELECT copies below are therefore no-ops today and exist only so
-- that a site which HAS accumulated rows before running this keeps them. The
-- old tables are left in place rather than dropped: an empty table costs
-- nothing, and dropping one holding a customer's signed contract because a
-- migration assumed it was empty is not a recoverable mistake.

/* ── Customers ──────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS customer_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Kept even though this table now holds one entity. It costs a byte, it keeps
  -- every query and mapper identical across the three pairs, and a row that
  -- names what it is about can be read on its own.
  entity        VARCHAR(40)  NOT NULL DEFAULT 'customer',
  entity_id     INT UNSIGNED NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(190) NOT NULL,
  mime_type     VARCHAR(120) NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  description   VARCHAR(400) NULL,
  uploaded_by   INT UNSIGNED NULL,
  uploaded_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Still UNIQUE, and still the key the download route resolves. Note the
  -- names are UUIDs from one generator against one directory, so they cannot
  -- collide between the three tables either.
  UNIQUE KEY uq_cdoc_stored (stored_name),
  KEY ix_cdoc_entity (entity, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS customer_comments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity      VARCHAR(40)  NOT NULL DEFAULT 'customer',
  entity_id   INT UNSIGNED NOT NULL,
  body        TEXT         NOT NULL,
  is_pinned   TINYINT(1)   NOT NULL DEFAULT 0,
  author_id   INT UNSIGNED NULL,
  author_name VARCHAR(120) NOT NULL DEFAULT '',
  is_edited   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_ccomment_entity (entity, entity_id, is_pinned, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ── Suppliers ──────────────────────────────────────────────────────────── */

CREATE TABLE IF NOT EXISTS supplier_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity        VARCHAR(40)  NOT NULL DEFAULT 'supplier',
  entity_id     INT UNSIGNED NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(190) NOT NULL,
  mime_type     VARCHAR(120) NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  description   VARCHAR(400) NULL,
  uploaded_by   INT UNSIGNED NULL,
  uploaded_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sdoc_stored (stored_name),
  KEY ix_sdoc_entity (entity, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_comments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity      VARCHAR(40)  NOT NULL DEFAULT 'supplier',
  entity_id   INT UNSIGNED NOT NULL,
  body        TEXT         NOT NULL,
  is_pinned   TINYINT(1)   NOT NULL DEFAULT 0,
  author_id   INT UNSIGNED NULL,
  author_name VARCHAR(120) NOT NULL DEFAULT '',
  is_edited   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_scomment_entity (entity, entity_id, is_pinned, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ── Jobs and tickets, which stay put ───────────────────────────────────── */

CREATE TABLE IF NOT EXISTS job_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- 'job_card' or 'ticket'. Both branch-local, so they share a table; the
  -- column is what keeps them apart.
  entity        VARCHAR(40)  NOT NULL,
  entity_id     INT UNSIGNED NOT NULL,
  filename      VARCHAR(255) NOT NULL,
  stored_name   VARCHAR(190) NOT NULL,
  mime_type     VARCHAR(120) NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,
  description   VARCHAR(400) NULL,
  uploaded_by   INT UNSIGNED NULL,
  uploaded_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_jdoc_stored (stored_name),
  KEY ix_jdoc_entity (entity, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS job_comments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  entity      VARCHAR(40)  NOT NULL,
  entity_id   INT UNSIGNED NOT NULL,
  body        TEXT         NOT NULL,
  is_pinned   TINYINT(1)   NOT NULL DEFAULT 0,
  author_id   INT UNSIGNED NULL,
  author_name VARCHAR(120) NOT NULL DEFAULT '',
  is_edited   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_jcomment_entity (entity, entity_id, is_pinned, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/* ── Carry anything that is already there ───────────────────────────────── */
--
-- No-ops on every database today. IGNORE rather than plain INSERT so that
-- re-running the migration on a site that half-applied it cannot fail on the
-- UNIQUE stored_name — the row is already where it belongs.

INSERT IGNORE INTO customer_documents
  (id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
   description, uploaded_by, uploaded_name, created_at)
SELECT id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
       description, uploaded_by, uploaded_name, created_at
  FROM party_documents WHERE entity = 'customer';

INSERT IGNORE INTO supplier_documents
  (id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
   description, uploaded_by, uploaded_name, created_at)
SELECT id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
       description, uploaded_by, uploaded_name, created_at
  FROM party_documents WHERE entity = 'supplier';

INSERT IGNORE INTO job_documents
  (id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
   description, uploaded_by, uploaded_name, created_at)
SELECT id, entity, entity_id, filename, stored_name, mime_type, size_bytes,
       description, uploaded_by, uploaded_name, created_at
  FROM party_documents WHERE entity NOT IN ('customer', 'supplier');

INSERT IGNORE INTO customer_comments
  (id, entity, entity_id, body, is_pinned, author_id, author_name, is_edited,
   created_at, updated_at)
SELECT id, entity, entity_id, body, is_pinned, author_id, author_name, is_edited,
       created_at, updated_at
  FROM party_comments WHERE entity = 'customer';

INSERT IGNORE INTO supplier_comments
  (id, entity, entity_id, body, is_pinned, author_id, author_name, is_edited,
   created_at, updated_at)
SELECT id, entity, entity_id, body, is_pinned, author_id, author_name, is_edited,
       created_at, updated_at
  FROM party_comments WHERE entity = 'supplier';

INSERT IGNORE INTO job_comments
  (id, entity, entity_id, body, is_pinned, author_id, author_name, is_edited,
   created_at, updated_at)
SELECT id, entity, entity_id, body, is_pinned, author_id, author_name, is_edited,
       created_at, updated_at
  FROM party_comments WHERE entity NOT IN ('customer', 'supplier');
