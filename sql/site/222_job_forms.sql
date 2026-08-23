-- ─────────────────────────────────────────────────────────────────────────
-- Custom forms (§24): the builder, its versions, its fields, and the answers.
--
-- ── WHY THIS IS NOT job_headline_items WITH MORE COLUMNS ─────────────────
--
-- 114 built a checklist: a flat ordered list of items, each with one response.
-- It is a good checklist and most of what it learned is kept below. What it
-- cannot become by adding columns is a FORM, and the reason is versioning.
--
-- The checklist versions by COPY-ON-ATTACH: the moment a headline lands on a
-- job, every item is duplicated into job_card_items, so a later template edit
-- cannot rewrite signed-off history. That works, and it is why job_card_items
-- repeats every template column.
--
-- It stops working the moment a form is worth versioning in its own right. A
-- copied row cannot say WHICH version it came from, so nothing can answer "show
-- me every response to v3" — and §24 requires exactly that: each submitted
-- response records the form version, and template edits must not alter history.
--
-- So the version becomes a row, and an answer points at it. Copy-on-attach is
-- replaced by a pointer, which is cheaper and says more.
--
-- ── FOUR TABLES, AND WHAT EACH IS FOR ────────────────────────────────────
--
--   job_forms          the FORM as a thing that persists across versions --
--                      its name, whether customers may see it, whether it is
--                      still offered. A rename does not make a new form.
--
--   job_form_versions  a PUBLISHED shape. Immutable once a response points at
--                      it. This is what makes "which version was this answered
--                      against" a question with an answer.
--
--   job_form_fields    the fields OF one version. Never edited in place after
--                      that version has been answered -- editing publishes a
--                      new version instead.
--
--   job_form_responses one filling-in, plus job_form_answers for the values.
--
-- ── WHY ANSWERS ARE ROWS AND NOT ONE JSON BLOB ───────────────────────────
--
-- A blob is tempting: one column, no join, trivially flexible. It is also
-- unqueryable. "Every job where the gas pressure reading was under 400" is the
-- question a form exists to make answerable, and against JSON that is a table
-- scan with string parsing in the WHERE clause.
--
-- 127_custom_fields made the same call for the same reason and its comment
-- stands: five typed columns beat one text column, because a number stored as
-- text sorts 100 before 20.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_forms (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name        VARCHAR(190) NOT NULL,
  description VARCHAR(400) NULL,

  -- Frozen at creation, like job_statuses.code and for the same reason: a
  -- rename must relabel the form rather than orphan every response to it.
  code        VARCHAR(60)  NOT NULL,

  -- Whether a customer may see this form and its answers in the portal.
  -- Defaults OFF: a form is an internal record until somebody decides it is
  -- not, and the reverse default would publish commissioning notes nobody
  -- meant to share. Same stance as custom_field_defs.is_public.
  is_public   TINYINT(1)   NOT NULL DEFAULT 0,

  -- A retired form keeps its history and stops being offered. Never deleted
  -- while a response exists -- see the FK on job_form_responses.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_form_code (code),
  KEY ix_form_active (is_active, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS job_form_versions (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  form_id     INT UNSIGNED NOT NULL,

  -- 1, 2, 3. Shown to people and recorded on every response.
  version     INT UNSIGNED NOT NULL DEFAULT 1,

  -- A version being edited is a DRAFT and may change freely. Publishing freezes
  -- it: from then on an edit creates the next version instead.
  --
  -- Only one draft per form at a time, enforced in application code rather than
  -- by an index -- MariaDB has no partial unique index, and a plain UNIQUE on
  -- (form_id, is_draft) would cap a form at ONE PUBLISHED VERSION, which is the
  -- opposite of the point. Same trap customer_contacts.is_primary documents.
  is_draft    TINYINT(1)   NOT NULL DEFAULT 1,

  published_at DATETIME NULL,
  published_by_name VARCHAR(120) NOT NULL DEFAULT '',

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_formver (form_id, version),
  KEY ix_formver_form (form_id, is_draft),
  CONSTRAINT fk_formver_form FOREIGN KEY (form_id)
    REFERENCES job_forms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS job_form_fields (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id  INT UNSIGNED NOT NULL,

  /*
   * Every field type §24 asks for, plus the four the checklist already had.
   *
   * `heading` and `page_break` are FIELDS rather than a separate sections
   * table, which is the one structural shortcut here and a deliberate one: a
   * section is a position in an ordered list, and modelling it as a parent row
   * means every field carries a section_id that must stay consistent with its
   * sort order. Two ways to say where something is, disagreeing.
   *
   * `record` covers §24's customer/contact/site/asset pickers -- one type with
   * `record_kind` below, because they differ only in which table is searched
   * and four near-identical enum values would need four near-identical
   * renderers.
   */
  field_type  ENUM(
    'short_text','long_text','number','measure','date','time',
    'dropdown','multi_select','choice','checkbox','yesno',
    'file','photo','signature','gps','record',
    'heading','page_break'
  ) NOT NULL DEFAULT 'short_text',

  label       VARCHAR(190) NOT NULL,
  hint        VARCHAR(190) NULL,

  -- For 'measure'. The checklist proved this pays for itself: a reading with no
  -- unit is a number somebody has to remember the meaning of.
  unit        VARCHAR(20)  NULL,

  -- For 'record': which file is searched. NULL for every other type.
  record_kind ENUM('customer','contact','site','asset') NULL,

  -- Choices for dropdown, multi_select and choice. JSON because the shape is a
  -- list of strings and nothing joins to it -- the same call 127 made for
  -- custom_field_defs.options.
  options     JSON NULL,

  is_required TINYINT(1)   NOT NULL DEFAULT 0,

  /*
   * Validation beyond required (§24). NULL means unconstrained.
   *
   * min/max apply to number and measure; min_len/max_len and pattern to the
   * text types. Kept as columns rather than a rules blob because the renderer
   * has to enforce them and a blob would mean parsing on every keystroke.
   */
  min_value   DECIMAL(14,4) NULL,
  max_value   DECIMAL(14,4) NULL,
  max_length  INT UNSIGNED  NULL,
  pattern     VARCHAR(190)  NULL,

  /*
   * Conditional logic (§24), in its simplest honest form: show this field only
   * when ANOTHER field on the same version holds a given value.
   *
   * One condition, not a tree. A rules engine is what §24 could be read to ask
   * for, and it is the shape that never ships -- every builder that has tried
   * has ended up with an AND/OR editor nobody can use. One condition covers
   * "if the answer was No, why not", which is what people actually build.
   */
  show_if_field_id INT UNSIGNED NULL,
  show_if_value    VARCHAR(190) NULL,

  sort_order  INT NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  KEY ix_formfield_version (version_id, sort_order),

  CONSTRAINT fk_formfield_version FOREIGN KEY (version_id)
    REFERENCES job_form_versions (id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: deleting the field a condition points at must
  -- make the dependent field unconditional, never delete it. Losing a question
  -- because somebody removed the one above it is not a behaviour anybody wants.
  CONSTRAINT fk_formfield_showif FOREIGN KEY (show_if_field_id)
    REFERENCES job_form_fields (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── Where a form is asked for ────────────────────────────────────────────
-- A form attached to a headline appears on every job carrying that headline.
-- Deliberately NOT copied onto the job the way checklist items are: the
-- attachment is a rule, and the response below is the record.
CREATE TABLE IF NOT EXISTS job_headline_forms (
  headline_id INT UNSIGNED NOT NULL,
  form_id     INT UNSIGNED NOT NULL,

  -- A form that must be filled in before the job can close. Same role
  -- job_card_items.is_required plays, and read by the same close gate.
  is_required TINYINT(1) NOT NULL DEFAULT 0,

  sort_order  INT NOT NULL DEFAULT 0,

  PRIMARY KEY (headline_id, form_id),
  KEY ix_hform_form (form_id),
  CONSTRAINT fk_hform_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE CASCADE,
  CONSTRAINT fk_hform_form FOREIGN KEY (form_id)
    REFERENCES job_forms (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS job_form_responses (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  job_card_id INT UNSIGNED NOT NULL,
  form_id     INT UNSIGNED NOT NULL,

  -- WHICH SHAPE THIS WAS ANSWERED AGAINST. The column the checklist could not
  -- have, and the reason this table exists rather than more columns on 114.
  version_id  INT UNSIGNED NOT NULL,

  -- Which asset on the job this is about (§18.4). NULL for a form about the job
  -- as a whole. Nullable rather than a separate table because most forms are
  -- about the job, and a join table for an optional single link is ceremony.
  asset_id    INT UNSIGNED NULL,

  /*
   * A response is a DRAFT until it is submitted (§24 asks for draft saving).
   *
   * The distinction is load-bearing for the close gate: a required form that is
   * half filled in has not been filled in. `submitted_at` NULL is the draft.
   */
  submitted_at DATETIME NULL,

  respondent_user_id INT UNSIGNED NULL,
  respondent_name    VARCHAR(120) NOT NULL DEFAULT '',

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The job card's own read: every response on this job.
  KEY ix_formresp_job (job_card_id, form_id),
  KEY ix_formresp_version (version_id),

  CONSTRAINT fk_formresp_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE, and this is the point of the whole file: a submitted
  -- response is EVIDENCE. Deleting the form must not delete what people
  -- answered, so a form with responses cannot be deleted at all -- it is
  -- retired with is_active instead.
  CONSTRAINT fk_formresp_form FOREIGN KEY (form_id)
    REFERENCES job_forms (id) ON DELETE RESTRICT,
  CONSTRAINT fk_formresp_version FOREIGN KEY (version_id)
    REFERENCES job_form_versions (id) ON DELETE RESTRICT,
  CONSTRAINT fk_formresp_asset FOREIGN KEY (asset_id)
    REFERENCES customer_assets (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS job_form_answers (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  response_id INT UNSIGNED NOT NULL,
  field_id    INT UNSIGNED NOT NULL,

  /*
   * TYPED COLUMNS, one filled per answer.
   *
   * 127_custom_fields' reasoning, verbatim in effect: a number stored as text
   * sorts 100 before 20, and a date stored as text cannot be compared to a
   * range. The cost is four mostly-NULL columns per row; the benefit is that
   * "every job where the pressure was under 400" is an index scan.
   *
   * value_text also carries the JSON array for multi_select, because a list of
   * chosen strings has no better typed home and nothing joins to it.
   */
  value_text   VARCHAR(1000) NULL,
  value_number DECIMAL(14,4) NULL,
  value_date   DATETIME      NULL,
  value_bool   TINYINT(1)    NULL,

  -- photo, file and signature all resolve to an upload in party_documents --
  -- which is the table, despite the column being called attachment_id in 119
  -- and here. Same shape and the same reasoning as 119: ON DELETE SET NULL, so
  -- removing the file UN-ANSWERS the field rather than leaving it pointing at
  -- bytes that are gone. An answer claiming a photo that is not there is worse
  -- than a blank one, because only one of the two is visible on a screen.
  attachment_id BIGINT UNSIGNED NULL,

  -- For 'record': which customer, contact, site or asset was picked. No FK,
  -- because the target table varies by the field's record_kind and MariaDB
  -- cannot express a conditional reference. The kind on the FIELD is what says
  -- how to read this.
  record_id    INT UNSIGNED NULL,

  -- For 'gps'. Same precision as job_card_travel, so the two agree about what a
  -- coordinate is.
  latitude     DECIMAL(10,7) NULL,
  longitude    DECIMAL(10,7) NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_answer (response_id, field_id),
  KEY ix_answer_field (field_id),

  CONSTRAINT fk_answer_response FOREIGN KEY (response_id)
    REFERENCES job_form_responses (id) ON DELETE CASCADE,
  CONSTRAINT fk_answer_field FOREIGN KEY (field_id)
    REFERENCES job_form_fields (id) ON DELETE CASCADE,
  CONSTRAINT fk_answer_attachment FOREIGN KEY (attachment_id)
    REFERENCES party_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
