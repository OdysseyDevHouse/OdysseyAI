-- ============================================================================
-- 118 — RECURRING JOBS
--
-- A quarterly service, an annual certificate, a monthly inspection. The office
-- sets it up once and the job appears when it is due.
--
-- THIS IS 061_contracts.sql WITH A JOB INSTEAD OF AN INVOICE
--
-- The shape is copied deliberately, down to the column names, because that
-- module already solved the two hard parts of recurrence and solved them well:
--
--   1. CLAIM-THEN-CREATE. A period is claimed in its own table under a unique
--      key BEFORE anything is created, so a second tick racing the first fails
--      on the insert having written nothing. That is what makes the endpoint
--      safe to call twice a minute.
--
--   2. CATCH-UP. duePeriods() walks from the last generated period to today and
--      returns every one it passed, capped at 24. A series left un-ticked for
--      three months raises three jobs on the next run, not one — and not
--      seventy-three.
--
-- Copying the shape rather than generalising the code: contracts bills money and
-- this raises work, and a shared "recurrence engine" that had to serve both would
-- need to know about escalation, VAT and posting. What IS shared is
-- nextOccurrence() and duePeriods() in the model files, which are pure date
-- arithmetic and already used by expenses too.
--
-- WHAT A RECURRENCE DOES NOT COPY FORWARD
--
-- Per section 19 of the PRD: the new job gets the template. It must NOT inherit
-- checklist answers, time entries, costs, comments or files from the occurrence
-- before it. That is not a rule this schema can enforce — it is a rule
-- generateDueJobs() follows by building a fresh job rather than cloning a row,
-- and (J20) asserts it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS job_series (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name               VARCHAR(120) NOT NULL,

  -- ── Who and where ───────────────────────────────────────────────────────
  --
  -- customer_id is NOT NULL here, unlike on a job card. A recurring schedule
  -- with nobody to serve is a schedule that raises work for nobody; a walk-in
  -- is by definition not recurring.
  customer_id        INT UNSIGNED NOT NULL,
  service_address_id INT UNSIGNED NULL,
  -- The equipment this recurs against, which is the commonest reason to have a
  -- series at all: a compressor wants servicing every six months whoever owns it.
  asset_id           INT UNSIGNED NULL,

  -- ── What the job will say ───────────────────────────────────────────────
  title              VARCHAR(190) NOT NULL,
  description        TEXT         NULL,
  priority           ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  owner_user_id      INT UNSIGNED NULL,
  owner_name         VARCHAR(120) NULL,
  location_id        INT UNSIGNED NULL,

  -- ── When ────────────────────────────────────────────────────────────────
  --
  -- The same four frequencies expenses and contracts use, from the shared
  -- FREQUENCIES in expenseModel. Deliberately NOT extended with daily or a
  -- custom interval: every real maintenance pattern is one of these four, a
  -- daily recurring job is a roster rather than a job, and adding a value to the
  -- shared enum would put it in the expense and contract pickers too.
  frequency          ENUM('weekly','monthly','quarterly','annually') NOT NULL DEFAULT 'monthly',

  -- Which day the occurrence lands on. day_of_month is clamped by the model, so
  -- 31 falls on the 28th or 29th in February rather than rolling into March.
  day_of_month       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  -- 1=Monday..7=Sunday, for the weekly frequency only.
  day_of_week        TINYINT UNSIGNED NULL,

  starts_on          DATE         NOT NULL,
  -- NULL means it runs until somebody switches it off, which is the normal case
  -- for a maintenance contract.
  ends_on            DATE         NULL,

  /*
   * The period most recently generated, as a DATE — not a count, and not a
   * timestamp of when the run happened.
   *
   * This is the cursor duePeriods() walks from, and it is why catch-up works: a
   * series last generated for March, ticked in June, yields April, May and June.
   * Storing "how many have run" instead would lose which ones.
   */
  last_generated_for DATE         NULL,

  -- ── How far ahead ───────────────────────────────────────────────────────
  --
  -- Section 19 asks how far in advance each occurrence is generated. Zero means
  -- on the day; 14 means the job appears a fortnight before it is due, which is
  -- what lets somebody schedule and order parts for it.
  lead_days          SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- ── Switches ────────────────────────────────────────────────────────────
  --
  -- is_active OFF stops generating without deleting the history. The jobs
  -- already raised keep pointing at it.
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,

  /*
   * Whether the tick raises jobs on its own.
   *
   * DEFAULTS OFF, exactly as contracts.auto_send does, and for the same reason:
   * a schedule that started raising work the moment somebody saved it — possibly
   * three months of catch-up — is a schedule nobody trusts again. Switching it
   * on is a deliberate second act.
   */
  auto_create        TINYINT(1)   NOT NULL DEFAULT 0,

  note               VARCHAR(190) NULL,

  user_id            INT UNSIGNED NULL,
  user_name          VARCHAR(120) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_series_customer (customer_id, is_active),
  KEY ix_series_asset (asset_id),
  -- The tick: which series might be due. last_generated_for is in the key
  -- because the cursor is what decides it.
  KEY ix_series_due (is_active, auto_create, last_generated_for),

  -- RESTRICT: a schedule naming a customer must not be orphaned by deleting the
  -- account. The customer screen already refuses a delete with documents behind it.
  CONSTRAINT fk_series_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT,
  -- SET NULL: a closed site or a scrapped unit leaves the schedule standing,
  -- which is correct — the work may move to a replacement.
  CONSTRAINT fk_series_address FOREIGN KEY (service_address_id)
    REFERENCES service_addresses (id) ON DELETE SET NULL,
  CONSTRAINT fk_series_asset FOREIGN KEY (asset_id)
    REFERENCES customer_assets (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Which kinds of work each occurrence brings ──────────────────────────────
--
-- The template side of 114: a quarterly service should raise a job already
-- carrying the checks a service needs. Stored as links so editing the headline
-- changes what FUTURE occurrences bring, while the jobs already raised keep the
-- copies they were given.
CREATE TABLE IF NOT EXISTS job_series_headlines (
  series_id   INT UNSIGNED NOT NULL,
  headline_id INT UNSIGNED NOT NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, headline_id),
  KEY ix_jsh_headline (headline_id),
  CONSTRAINT fk_jsh_series FOREIGN KEY (series_id)
    REFERENCES job_series (id) ON DELETE CASCADE,
  -- RESTRICT, matching job_card_headlines: a headline named by a schedule must
  -- not vanish underneath it.
  CONSTRAINT fk_jsh_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The claim table. This is the double-raise guarantee. ────────────────────
--
-- A period is inserted here BEFORE the job is created. The unique key on
-- (series_id, for_date) means a second tick racing the first fails on this
-- insert, having written nothing at all.
CREATE TABLE IF NOT EXISTS job_series_runs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  series_id    INT UNSIGNED NOT NULL,

  -- The period this covers — the DUE date, not the date it ran. A catch-up
  -- generating three missed months writes three rows dated in the past.
  for_date     DATE         NOT NULL,

  /*
   * NULL only in the window between claiming the period and creating the job. A
   * row that stays NULL means the run died mid-way and this period needs looking
   * at — which is worth being able to find, and which reconcileJobSeries reports.
   */
  job_card_id  INT UNSIGNED NULL,

  status       ENUM('created','failed') NOT NULL DEFAULT 'created',
  error        VARCHAR(400) NULL,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The guarantee. Everything above is commentary on this line.
  UNIQUE KEY uq_series_period (series_id, for_date),
  KEY ix_jsr_job (job_card_id),
  KEY ix_jsr_failed (status, created_at),
  CONSTRAINT fk_jsr_series FOREIGN KEY (series_id)
    REFERENCES job_series (id) ON DELETE CASCADE,
  /*
   * SET NULL rather than CASCADE, and this is load-bearing: deleting a job must
   * not erase the evidence that its period was raised, or the next tick raises
   * it again. The contracts module learned this the same way.
   */
  CONSTRAINT fk_jsr_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Which series a job came from ────────────────────────────────────────────
--
-- On job_cards rather than only in the run table, so a job card can say "this is
-- the quarterly service" without a join, and so the job list can filter on it.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS series_id INT UNSIGNED NULL AFTER source;

ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_jcard_series (series_id, reported_at);

-- SET NULL: deleting a schedule must not delete the work it raised. Those jobs
-- happened.
ALTER TABLE job_cards
  ADD FOREIGN KEY IF NOT EXISTS fk_jcard_series (series_id)
  REFERENCES job_series (id) ON DELETE SET NULL;

-- ── Settings ────────────────────────────────────────────────────────────────

-- How many missed periods one tick will raise before giving up and reporting it.
-- 24 matches the contracts cap. Past that, something is wrong that generating two
-- years of back-dated jobs would make worse rather than better.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_series_catchup_cap', '24')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
