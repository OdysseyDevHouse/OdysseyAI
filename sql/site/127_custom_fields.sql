-- ── Custom fields ───────────────────────────────────────────────────────────
--
-- Fields a business defines for itself, on jobs, customers and equipment.
--
-- ── WHY THIS IS ITS OWN MODULE AND NOT A JOB FEATURE ────────────────────────
--
-- The job-cards plan argued against a general mechanism, on the grounds that a
-- framework built inside job cards ends up job-shaped and wrong for everything
-- else. That argument is sound and this migration answers it rather than
-- ignoring it: nothing here mentions a job. The entity is a column, jobs are the
-- first consumer, and a customer field is not a job field wearing a flag.
--
-- The concrete test is the FK. There is deliberately no
-- `job_card_id` here — see the entity/entity_id pair below.
--
-- ── WHY THE VALUE IS NOT A SNAPSHOT ─────────────────────────────────────────
--
-- job_card_items COPIES its template because a signed-off checklist is evidence:
-- what was asked at the time must not change when the template does. A custom
-- field is the opposite. "Warranty expires" is a fact about the customer that
-- somebody corrects when it was typed wrong, and a value that could not be
-- edited would be useless.
--
-- So: definitions live in one table, values in another, and a value points at
-- its definition for real rather than carrying a copy. Renaming a field relabels
-- every value, which is what somebody renaming a field means.
--
-- The cost is stated plainly: DELETING a definition destroys its values. That is
-- why the delete is refused in code once any value exists, and why retiring is
-- offered instead.
--
-- ── ONE TEXT COLUMN, NOT ONE PER TYPE ───────────────────────────────────────
--
-- Copied from job_card_items, and for the same reason: five typed columns are
-- four NULLs on every row plus a CHECK constraint nobody maintains. field_type
-- says how to read it.
--
-- The cost, again plainly: a numeric field cannot be SUMmed without a CAST.
-- These are read per record rather than aggregated, and the report builder can
-- expose a cast column if anybody ever needs an average.

-- ── The definitions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  /*
   * WHAT this field is attached to.
   *
   * A string rather than three tables, and rather than an FK. The same argument
   * attachmentTargets and activity_log already make in this schema: an entity
   * column plus a loose id is how one mechanism serves several record types
   * without three copies of every query.
   *
   * The cost is that no foreign key can protect a value whose record is deleted,
   * which is exactly why reconcileCustomFields reports orphans.
   */
  entity      ENUM('job','customer','equipment') NOT NULL,

  /*
   * Frozen at creation, like job_headlines.code and job_statuses.code.
   *
   * A report or an import that names a field names it by code. Letting a rename
   * change the code would silently break both, so the NAME is what somebody
   * edits and the code is what the machinery uses.
   */
  code        VARCHAR(40) NOT NULL,

  name        VARCHAR(120) NOT NULL,
  hint        VARCHAR(190) NULL,

  /*
   * How the value is captured and read back.
   *
   * Deliberately NARROWER than job_headline_items.response_type. There is no
   * photo and no signature here: an attachment belongs on the Files tab where
   * party_documents already holds it with its permissions, and a signature is
   * evidence with a legal meaning that a free-form field must not imply.
   *
   * `list` reads its options from the JSON column below.
   */
  field_type  ENUM('text','number','date','yesno','list') NOT NULL DEFAULT 'text',

  /*
   * The choices, for a list field. JSON because the alternative is a fourth
   * table holding two columns, and nothing ever queries INSIDE this - the
   * options are rendered as a dropdown and validated on save, both of which read
   * the whole array.
   *
   * 015_sales_core argues against JSON where anything might query into it. That
   * argument does not apply here, and this comment records that it was checked.
   */
  options     JSON NULL,

  unit        VARCHAR(20) NULL,

  -- Blocks saving the record when empty. Not the same as important.
  is_required TINYINT(1) NOT NULL DEFAULT 0,

  /*
   * Whether a customer may see this on the portal.
   *
   * Defaults to 0, and that default is the point. A field somebody adds without
   * thinking about the portal must not appear on it - "internal risk rating"
   * showing up on a customer screen is the failure this column exists to stop.
   */
  is_public   TINYINT(1) NOT NULL DEFAULT 0,

  sort_order  INT NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- Codes are unique WITHIN an entity: a job and a customer may both have a
  -- field coded `region` without one blocking the other.
  UNIQUE KEY uq_cfdef_entity_code (entity, code),
  KEY ix_cfdef_entity (entity, is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The values ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_field_values (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  field_id   INT UNSIGNED NOT NULL,

  /*
   * WHICH record. The loose pair, matching activity_log and party_documents.
   *
   * entity is repeated here rather than read through field_id. It is redundant
   * and it is deliberate: it makes "every custom value on this job" one indexed
   * read with no join, which is what every screen that renders a record needs.
   */
  entity     ENUM('job','customer','equipment') NOT NULL,
  entity_id  INT UNSIGNED NOT NULL,

  /*
   * One column for every type. See the header.
   *
   * 500 rather than TEXT: a custom field is a field, not a document. Something
   * longer than 500 characters is a note, and notes already have a home.
   */
  value      VARCHAR(500) NULL,

  -- Who last set it. A snapshot of the name, as everywhere else in this schema,
  -- so a deactivated user does not blank the audit trail.
  set_by_user_id INT UNSIGNED NULL,
  set_by_name    VARCHAR(120) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  /*
   * One value per field per record. The key does the enforcing so a double
   * submit cannot write two, and it is what lets the save be a single
   * INSERT .. ON DUPLICATE KEY UPDATE rather than a read-then-write race.
   */
  UNIQUE KEY uq_cfval_field_record (field_id, entity, entity_id),
  -- The read every record screen does.
  KEY ix_cfval_record (entity, entity_id),
  /*
   * CASCADE, and the header explains it: a definition that is gone has no values
   * worth keeping, because nothing could say what they meant. The delete is
   * refused in code while any value exists, so reaching this cascade means
   * somebody removed the values first or went in by hand.
   */
  CONSTRAINT fk_cfval_def FOREIGN KEY (field_id)
    REFERENCES custom_field_defs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
