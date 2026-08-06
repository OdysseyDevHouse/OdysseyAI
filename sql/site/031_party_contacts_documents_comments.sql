-- ─────────────────────────────────────────────────────────────────────────
-- Contacts, documents and comments for customers and suppliers.
--
-- Three things an account screen could not do before: name more than one
-- person, keep the signed paperwork, and record what was said.
--
-- ── WHY THE ACCOUNT KEEPS ITS OWN EMAIL AND PHONE ────────────────────────
--
-- customers.email / phone and suppliers.email / phone STAY, and are not
-- migrated into the contact list. They are not the same fact.
--
-- The column on the account is where the BUSINESS is reached — the address a
-- statement run posts to, the number on file for the account itself. The
-- contact rows are PEOPLE, who come and go. Folding the first into the second
-- would mean a statement run has to pick a person, and picking wrong sends a
-- debtors statement to the receiving clerk who left in March.
--
-- So statementRuns and remittance keep reading the account column and are
-- untouched by this migration. Contacts are addressed by a human, deliberately.
--
-- ── WHY CONTACTS ARE PER-PARTY BUT DOCUMENTS AND COMMENTS ARE NOT ────────
--
-- 013_suppliers.sql sets the precedent: customers and suppliers are separate
-- tables because they differ in the columns that matter, and a shared table
-- with a type column makes every query carry a filter it can forget. Contacts
-- follow that reasoning and get one table each, with a real foreign key.
--
-- Documents and comments do NOT. They carry no per-party columns at all — a
-- filename is a filename — and the moment a product or a purchase order wants
-- an attachment, a per-party design needs a new table and a new module. So
-- they use the loose (entity, entity_id) pair that activity_log already proved
-- in 011: no foreign key, writable for any table without a schema change.
--
-- The tradeoff is real and accepted: no FK means no ON DELETE CASCADE, so
-- deleting an account must clear its documents and comments in application
-- code. That is done in deleteCustomer/deleteSupplier, in the same transaction
-- as the delete. The alternative — four near-identical tables today and six
-- next quarter — costs more than the one cleanup call.
--
-- ── WHY FILE BYTES ARE NOT IN HERE ───────────────────────────────────────
--
-- Only metadata. The bytes go to disk under uploads/, keyed by stored_name.
-- A site database that has to stream 40MB of scanned credit applications for
-- a screen that only lists their names is a slow screen and a slow backup.
--
-- The consequence to know about: the database and the uploads directory are
-- now two things that must be backed up together, and a restore of one without
-- the other leaves rows pointing at files that are not there. listDocuments
-- does not stat the disk — a missing file surfaces on download, not on list,
-- because making the list screen touch the filesystem once per row would make
-- the common case pay for the rare one.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it
-- as one multipleStatements batch, and MariaDB reads a lone ' inside a `--`
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Customer contacts ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_contacts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id INT UNSIGNED NOT NULL,

  name        VARCHAR(120) NOT NULL,
  -- Free text, not an ENUM. "Accounts", "Store manager", "After hours" — the
  -- useful values differ per trade, and a new one is data, not a migration.
  role        VARCHAR(60)  NULL,
  email       VARCHAR(190) NULL,
  phone       VARCHAR(40)  NULL,
  notes       VARCHAR(400) NULL,

  -- The one to ask for by default. Not a substitute for the account email:
  -- this picks a PERSON to call, never an address a statement run posts to.
  --
  -- Enforced in application code rather than by a unique index. A partial
  -- unique index is not available in MariaDB, and a plain UNIQUE (customer_id,
  -- is_primary) would cap an account at one NON-primary contact, which is the
  -- opposite of the point of this table.
  is_primary  TINYINT(1)   NOT NULL DEFAULT 0,

  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The only read this table serves: one account, in display order.
  KEY ix_ccontact_customer (customer_id, sort_order, id),
  -- "Who is this, and which account are they at" — the inbound-call lookup.
  KEY ix_ccontact_email (email),
  KEY ix_ccontact_phone (phone),
  -- CASCADE, unlike the SET NULL on group and rep in 012. A contact has no
  -- meaning without the account it belongs to, so an orphan row is not a
  -- record worth keeping. Deleting the account is already the deliberate act.
  CONSTRAINT fk_ccontact_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Supplier contacts ─────────────────────────────────────────────────
-- The mirror of the above, for the same reasons.
CREATE TABLE IF NOT EXISTS supplier_contacts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id INT UNSIGNED NOT NULL,

  name        VARCHAR(120) NOT NULL,
  role        VARCHAR(60)  NULL,
  email       VARCHAR(190) NULL,
  phone       VARCHAR(40)  NULL,
  notes       VARCHAR(400) NULL,
  is_primary  TINYINT(1)   NOT NULL DEFAULT 0,

  sort_order  INT          NOT NULL DEFAULT 0,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_scontact_supplier (supplier_id, sort_order, id),
  KEY ix_scontact_email (email),
  KEY ix_scontact_phone (phone),
  CONSTRAINT fk_scontact_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 3. Documents ─────────────────────────────────────────────────────────
-- Metadata for a file on disk. See the header for why the bytes are not here.
CREATE TABLE IF NOT EXISTS party_documents (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Loose pair, exactly as activity_log. No foreign key: see the header.
  entity        VARCHAR(40)  NOT NULL,          -- 'customer' | 'supplier'
  entity_id     INT UNSIGNED NOT NULL,

  -- What the user called it. Shown on screen and used as the download name, so
  -- it keeps its spaces and punctuation.
  filename      VARCHAR(255) NOT NULL,

  -- What it is called on disk: a generated opaque name, never the users.
  -- Two reasons. A filename from a browser is attacker-controlled and a path
  -- traversal risk, and two people uploading Application.pdf must not collide.
  -- UNIQUE because it is the key the download route resolves.
  stored_name   VARCHAR(190) NOT NULL,

  -- Advisory only. Set from the browser at upload time and echoed back on
  -- download; never trusted to decide whether a file is safe. The download
  -- route sends Content-Disposition: attachment precisely so this does not
  -- have to be trusted.
  mime_type     VARCHAR(120) NULL,
  size_bytes    BIGINT UNSIGNED NOT NULL DEFAULT 0,

  -- A line about what the document is, since a filename often is not one.
  description   VARCHAR(400) NULL,

  -- Snapshotted like activity_log.user_name, and for the same reason: no FK is
  -- possible across databases, so a rename would otherwise rewrite history.
  uploaded_by   INT UNSIGNED NULL,
  uploaded_name VARCHAR(120) NOT NULL DEFAULT '',

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pdoc_stored (stored_name),
  -- The Documents tab: one account, newest first.
  KEY ix_pdoc_entity (entity, entity_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 4. Comments ──────────────────────────────────────────────────────────
-- What someone said about this account.
--
-- Distinct from activity_log, which records what the SYSTEM observed a person
-- do, and from the notes column, which is one editable field describing the
-- account as it stands today. A comment is a dated remark by a named person:
-- "spoke to Sarah, paying Friday". Those three answer different questions and
-- collapsing them loses the one that gets read most.
--
-- Editable and deletable, unlike activity_log. An audit trail that can be
-- changed is not one; a comment thread that cannot fix a typo is a nuisance.
CREATE TABLE IF NOT EXISTS party_comments (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  entity      VARCHAR(40)  NOT NULL,            -- 'customer' | 'supplier'
  entity_id   INT UNSIGNED NOT NULL,

  body        TEXT         NOT NULL,

  -- Rises to the top of the thread regardless of date. For the standing warning
  -- that a new cashier must see before the twelve routine call notes under it.
  is_pinned   TINYINT(1)   NOT NULL DEFAULT 0,

  author_id   INT UNSIGNED NULL,
  author_name VARCHAR(120) NOT NULL DEFAULT '',

  -- Whether the body has been changed since it was written.
  --
  -- A stored flag rather than created_at <> updated_at, which is what this
  -- started as and could not work: DATETIME holds whole seconds, so an edit in
  -- the same second as the insert is invisible and one in the very next second
  -- is indistinguishable from clock granularity. Whether "(edited)" appeared
  -- then depended on where two writes fell inside a second, which is not
  -- something the user did.
  is_edited   TINYINT(1)   NOT NULL DEFAULT 0,

  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The thread: one account, pinned first, then newest. Matches the ORDER BY
  -- in listComments exactly.
  KEY ix_pcomment_entity (entity, entity_id, is_pinned, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 5. is_edited, for a database that already ran an earlier 028 ─────────
--
-- The CREATE above is guarded by IF NOT EXISTS, so a site that applied this
-- file before is_edited was added would keep a party_comments without it and
-- every read of the column would then fail. This ALTER is the catch-up, and is
-- a no-op everywhere else.
ALTER TABLE party_comments
  ADD COLUMN IF NOT EXISTS is_edited TINYINT(1) NOT NULL DEFAULT 0 AFTER author_name;
