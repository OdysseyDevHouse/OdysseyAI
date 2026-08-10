-- Tables, for a till that serves food.
--
-- ── WHAT A TABLE ACTUALLY IS ─────────────────────────────────────────────
--
-- A place to PARK A BASKET, with a name a waiter recognises and a state the whole
-- floor can see. That is all. It is not a customer, not a document, and not a
-- location — a bill belongs to table 6 the way a saved sale belongs to a till, and
-- the mechanism is deliberately the same one: `sales_documents.status = 'saved'`.
--
-- Which is why there is no `bill` table here. Inventing one would mean a second
-- kind of unfinished sale, with its own lines, its own totals and its own posting
-- path — and the whole retail engine already knows how to hold a basket and turn it
-- into an invoice. A restaurant does not need different arithmetic; it needs a
-- different way of FINDING the basket it left open.
--
-- ── SECTIONS ARE A STRING, NOT A TABLE ───────────────────────────────────
--
-- "Patio", "Upstairs", "Bar". A shop has three or four, renames them freely, and
-- never reports on them — so a lookup table would be a join and a management screen
-- to maintain something a waiter types once. When a floor plan lands (deferred, see
-- the plan) it will need x/y per table, and that is the point at which this gets
-- revisited rather than guessed at now.

CREATE TABLE pos_tables (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the waiter calls it: '6', 'B2', 'Patio 3'. A string because restaurants
  -- number tables in ways that are not numbers, and because it is printed on a bill.
  code          VARCHAR(16)  NOT NULL,

  -- Free text, empty for most. 'Window', 'Booth by the door'.
  name          VARCHAR(60)  NOT NULL DEFAULT '',

  -- Which part of the floor. Empty means "no sections", which is most small places.
  section       VARCHAR(40)  NOT NULL DEFAULT '',

  -- How many people fit. Zero means nobody has said, which is not the same as a
  -- table for nobody — the gate shows it only when set.
  seats         TINYINT UNSIGNED NOT NULL DEFAULT 0,

  /*
   * The open bill, or NULL when the table is free.
   *
   * This is the whole mechanism. A table with a document is occupied; one without
   * is free — there is no `status` column to fall out of step with reality, which
   * is exactly what a status column would do the first time a bill was paid from
   * the back office.
   *
   * SET NULL on delete rather than CASCADE: voiding a bill must free the table, not
   * remove it from the floor.
   */
  document_id   INT UNSIGNED NULL,

  /*
   * The bill has been asked for.
   *
   * A real third state, and the reason this cannot be derived from `document_id`
   * alone: a table that has asked to pay needs a waiter NOW, while one still eating
   * does not, and on a busy floor that difference is the whole point of looking at
   * the screen. Set when the bill is printed, cleared when the table is settled or
   * freed.
   */
  bill_asked_at DATETIME     NULL,

  -- Where it sits in the list. Tables are read in a fixed order a waiter learns by
  -- position, so this is not sorted by code — '10' before '2' is how a shop that
  -- numbers its tables would be let down by lexical sorting.
  sort_order    INT UNSIGNED NOT NULL DEFAULT 0,

  -- Deactivated rather than deleted: a table taken out of service for a week has
  -- history, and its bills must keep resolving.
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One table per code. A floor with two "table 6"s is a floor where a bill lands
  -- on the wrong one, and the waiter carrying it has no way to tell.
  UNIQUE KEY uq_table_code (code),

  /*
   * One table per open bill.
   *
   * A plain UNIQUE is enough, because MySQL permits any number of NULLs in one — the
   * same property `uq_doc_number` and `uq_terminal_device` already lean on. So this
   * constrains exactly the OCCUPIED tables and leaves every free one alone.
   *
   * (`shifts` needed a generated column for its equivalent rule only because it keys
   * on `closed_at IS NULL` rather than on the nullable column itself. Copying that
   * shape here would be ceremony.)
   *
   * What it prevents: the same basket appearing on two tables, which would let two
   * waiters take payment for one bill.
   */
  UNIQUE KEY uq_table_document (document_id),

  KEY idx_table_order (is_active, section, sort_order),

  CONSTRAINT fk_table_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The mode ─────────────────────────────────────────────────────────────
--
-- 'retail' is the default so every existing store keeps behaving exactly as it
-- does — the table gate does not appear, and nothing about the till changes.
--
-- Read in exactly THREE places on the client (see PosShell's docblock): whether to
-- mount the table gate, whether to offer send-to-kitchen, and whether the
-- hospitality quick keys are enabled. A fourth is the signal that this flag is
-- being threaded rather than contained, which is how the reference POS reached ten
-- thousand lines.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('pos_mode', 'retail')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
