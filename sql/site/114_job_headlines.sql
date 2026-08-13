-- ============================================================================
-- 114 — JOB HEADLINES, AND THE WORK THEY BRING WITH THEM
--
-- A headline is what kind of job this is: Repair Air Conditioner, Site Survey,
-- New PC Installation. Until now a job carried only a free-text title, which
-- says what THIS job is and nothing about what jobs of its kind require.
--
-- WHY A HEADLINE IS NOT JUST A CATEGORY
--
-- The whole point is that it carries defaults with it. Choosing "Annual Service"
-- should bring the eight checks that service always needs, the filter it always
-- consumes, the two hours it usually takes, and the board it belongs on. A
-- dropdown that only labels the job is a report filter; a headline that attaches
-- the work is the difference between a system a business configures once and a
-- system where every technician retypes the same checklist.
--
-- ONE ITEM TABLE, NOT TWO
--
-- Section 23 of the PRD calls a task and a checklist different things: a task is
-- work to be done, a checklist is a set of checks. Both are an ordered list of
-- named things attached to a job, each either done or not, each optionally
-- required before the job can move on. The ONLY difference is that a check
-- captures a value and a task does not.
--
-- So: one table, one `response_type`, where 'none' means a task. Two tables would
-- be two copies of the sort-order logic, two copies of the blocking rule, two
-- screens rendering near-identical rows, and a permanent question about which one
-- a new requirement belongs in. `kind` is kept as a LABEL so the screens can
-- still say Task and Check, because that is the vocabulary the trade uses.
--
-- THE ITEMS ARE COPIED ONTO THE JOB, NOT REFERENCED
--
-- job_card_items holds its own name and response type rather than pointing at the
-- template row. Editing "Check gas pressure" to "Check refrigerant pressure" next
-- March must not silently rewrite what a technician signed off last week — the
-- same argument the job LINES make for snapshotting product_code, and the same
-- one 015 makes for storing document totals.
-- ============================================================================

-- ── The headline itself ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_headlines (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Frozen at creation, so renaming the headline relabels every job that used it
  -- rather than stranding them. Same reason job_statuses.code is frozen.
  code              VARCHAR(40)  NOT NULL,
  name              VARCHAR(120) NOT NULL,
  description       VARCHAR(190) NULL,

  -- ── What choosing it decides ─────────────────────────────────────────────
  --
  -- All nullable: a headline that expresses no opinion about priority leaves the
  -- site default alone. NULL is "no opinion", not "normal".
  default_priority  ENUM('low','normal','high','urgent') NULL,
  default_board_id  INT UNSIGNED NULL,

  -- How long this kind of work usually takes, in minutes. Feeds the appointment
  -- length so a dispatcher booking a service does not guess at an hour every time.
  suggested_minutes INT UNSIGNED NULL,

  -- Free text, deliberately not a skills table. "Gas licence, working at height"
  -- is a note for whoever assigns the job; a normalised skills register with
  -- per-user certifications and expiry dates is its own project, and building the
  -- table without the register would be a foreign key to nothing.
  required_skills   VARCHAR(190) NULL,

  sort_order        INT          NOT NULL DEFAULT 0,
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_headline_code (code),
  KEY ix_headline_active (is_active, sort_order),
  -- SET NULL: deleting a board must not take the headline with it. The headline
  -- then simply expresses no board preference.
  CONSTRAINT fk_headline_board FOREIGN KEY (default_board_id)
    REFERENCES job_boards (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The template items a headline brings ────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_headline_items (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  headline_id   INT UNSIGNED NOT NULL,

  -- The LABEL, for the screens. See the header: this is vocabulary, not structure.
  kind          ENUM('task','check') NOT NULL DEFAULT 'task',

  name          VARCHAR(190) NOT NULL,
  hint          VARCHAR(190) NULL,

  -- What completing it records. 'none' is a plain task: ticked or not.
  --
  -- measure carries a unit (a pressure, a temperature); number does not. Keeping
  -- them apart means a reading of 12 can be rendered as "12 bar" without every
  -- caller having to know which items have units.
  response_type ENUM('none','yesno','passfail','number','measure','text','photo','signature')
                NOT NULL DEFAULT 'none',
  unit          VARCHAR(20)  NULL,

  -- When in the visit it belongs. A safety check is before work; a customer
  -- signature is after. Ordering by phase then sort_order gives a technician the
  -- list in the order they will actually work it.
  work_phase    ENUM('before','during','after') NOT NULL DEFAULT 'during',

  -- Blocks completion of the job when unanswered. NOT the same as important: a
  -- required item is one the business will refuse to close a job without.
  is_required   TINYINT(1)   NOT NULL DEFAULT 0,

  sort_order    INT          NOT NULL DEFAULT 0,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_hitem_headline (headline_id, work_phase, sort_order),
  CONSTRAINT fk_hitem_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The standard parts a headline brings ────────────────────────────────────
--
-- Suggestions, not commitments. Selecting the headline offers them; a person
-- decides. Auto-adding a billable line because of a dropdown is how a customer
-- gets charged for a filter nobody fitted.
CREATE TABLE IF NOT EXISTS job_headline_parts (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  headline_id  INT UNSIGNED NOT NULL,
  product_id   INT UNSIGNED NOT NULL,
  qty          DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  -- part covers a stocked item; labour and travel cover the service products a
  -- job of this kind always bills. Mirrors job_card_lines.line_kind so the copy
  -- across needs no translation.
  line_kind    ENUM('part','labour','travel','charge') NOT NULL DEFAULT 'part',
  sort_order   INT          NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_hpart (headline_id, product_id, line_kind),
  KEY ix_hpart_product (product_id),
  CONSTRAINT fk_hpart_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE CASCADE,
  -- RESTRICT: a product named by a headline must not vanish underneath it. The
  -- setup screen removes the link first, which is a deliberate act.
  CONSTRAINT fk_hpart_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Which headlines a job carries ───────────────────────────────────────────
--
-- MANY per job, per section 8: replacing a compressor and surveying the site can
-- be one visit. That is why this is a join table and not a column on job_cards.
CREATE TABLE IF NOT EXISTS job_card_headlines (
  job_card_id INT UNSIGNED NOT NULL,
  headline_id INT UNSIGNED NOT NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (job_card_id, headline_id),
  KEY ix_jch_headline (headline_id),
  CONSTRAINT fk_jch_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE,
  -- RESTRICT, unlike job_board_statuses: a headline names what a job WAS, and a
  -- deleted headline would erase the answer to what kind of work was done. The
  -- setup screen retires with is_active instead.
  CONSTRAINT fk_jch_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The items ON a job, copied from the template ────────────────────────────
CREATE TABLE IF NOT EXISTS job_card_items (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id     INT UNSIGNED NOT NULL,

  -- Where it came from, for reporting on which headline generates the most
  -- unfinished work. SET NULL because the copy below stands on its own, and a
  -- retired headline must not block deleting itself forever.
  headline_item_id INT UNSIGNED NULL,
  headline_id      INT UNSIGNED NULL,

  -- THE COPY. See the header: a template edit must not rewrite signed-off history.
  kind          ENUM('task','check') NOT NULL DEFAULT 'task',
  name          VARCHAR(190) NOT NULL,
  hint          VARCHAR(190) NULL,
  response_type ENUM('none','yesno','passfail','number','measure','text','photo','signature')
                NOT NULL DEFAULT 'none',
  unit          VARCHAR(20)  NULL,
  work_phase    ENUM('before','during','after') NOT NULL DEFAULT 'during',
  is_required   TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order    INT          NOT NULL DEFAULT 0,

  -- ── What was recorded ───────────────────────────────────────────────────
  --
  -- ONE text column for every response type rather than one column per type.
  -- A yes/no stores 'yes', a measure stores '12.4', a photo stores an attachment
  -- id. Five typed columns would be four NULLs on every row and a CHECK
  -- constraint nobody maintains; the response_type says how to read it.
  --
  -- The cost, stated plainly: a numeric response cannot be SUMmed in SQL without
  -- a CAST. That is the right trade — these are read per job, not aggregated, and
  -- the report builder can expose a cast column if anybody ever needs the average.
  response      VARCHAR(500) NULL,

  -- Completed is its own column, not "response IS NOT NULL": a task has no
  -- response and still gets done, and a check answered 'no' is complete AND
  -- failing. Conflating them would make a failed check look outstanding.
  completed_at  DATETIME     NULL,
  completed_by_user_id INT UNSIGNED NULL,
  completed_by_name    VARCHAR(120) NULL,

  -- A check that FAILED. Derived from the response for yesno/passfail, but stored
  -- because "which jobs had a failing check" must be one indexed read rather than
  -- a string comparison across every item ever recorded.
  is_failed     TINYINT(1)   NOT NULL DEFAULT 0,

  note          VARCHAR(190) NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_jci_job (job_card_id, work_phase, sort_order),
  -- The blocking query: outstanding required items on this job.
  KEY ix_jci_outstanding (job_card_id, is_required, completed_at),
  -- The exception report: failed checks, newest first.
  KEY ix_jci_failed (is_failed, job_card_id),
  CONSTRAINT fk_jci_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_jci_template FOREIGN KEY (headline_item_id)
    REFERENCES job_headline_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_jci_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────────

-- Section 7 of the PRD requires at least one headline on every job. OFF by
-- default, deliberately: turning it on before any headline exists would make it
-- impossible to create a job at all, and this migration seeds none. The setup
-- screen offers the switch once there is something to choose.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_headline_required', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Whether an unanswered REQUIRED item stops a job being closed.
--
-- On by default. The whole reason to mark an item required is that the business
-- will not sign the job off without it; a required flag that does nothing is
-- worse than no flag, because it teaches people the marking is decorative.
-- closeJob already refuses on undecided costs, so the pattern exists.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_items_block_close', '1')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Whether the standard parts a headline names are added as lines automatically.
--
-- OFF by default: see job_headline_parts. Offering them is safe, adding a
-- billable line because of a dropdown is not.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_headline_autoparts', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
