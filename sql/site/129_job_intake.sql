-- ── Public job requests ─────────────────────────────────────────────────────
--
-- Somebody outside the business asks for work to be done.
--
-- ── IT IS A HOLDING AREA, NOT A JOB ─────────────────────────────────────────
--
-- The load-bearing decision, and the reason this table exists at all: a public
-- submission does NOT become a job card, and does NOT become a customer.
--
-- If it did, anybody who found the URL could write rows into the job list, the
-- customer table and every count and report that reads them. Instead a request
-- sits here until a person in the business looks at it, matches it to a customer
-- or creates one deliberately, and presses Accept. Only then is a job raised.
--
-- That is also how the rest of this app already behaves. A guest booking is a
-- reservations row with loose contact strings and no customer_id; a guest online
-- order carries a NULLABLE customer link filled in only if they were signed in;
-- a product review has no customer link at all. There is exactly one INSERT INTO
-- customers in the whole codebase and no public path reaches it. This table does
-- not change that.
--
-- ── CONTACT DETAILS ARE STRINGS, NOT A CUSTOMER ─────────────────────────────
--
-- Same shape as reservations: name, phone and email as plain columns. The person
-- who submitted may be an existing customer, a new one, or somebody who is never
-- going to be one, and only a human can tell which.
--
-- customer_id is filled in when somebody ACCEPTS the request, as a record of
-- what they decided.

CREATE TABLE IF NOT EXISTS job_requests (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  /*
   * A short public reference, derived from the id after insert.
   *
   * Reservations does the same. NOT a document_sequences number: this is not a
   * document, most requests will be rejected, and burning a JC number on a
   * spammer would leave permanent gaps in a sequence somebody audits.
   */
  reference      VARCHAR(20) NULL,

  -- ── Who is asking ─────────────────────────────────────────────────────────
  contact_name   VARCHAR(120) NOT NULL,
  contact_phone  VARCHAR(40)  NOT NULL,
  contact_email  VARCHAR(190) NULL,

  -- ── What they want ────────────────────────────────────────────────────────
  title          VARCHAR(190) NOT NULL,
  description    TEXT NULL,
  /*
   * Where the work is, as free text.
   *
   * Deliberately NOT a service_addresses row. An address typed by a stranger is
   * a claim, not a record, and writing it into the addresses table would put
   * unverified rows against a customer who may not even exist yet. Whoever
   * accepts the request decides what becomes a real address.
   */
  address_text   VARCHAR(400) NULL,

  /*
   * Which kind of work, if the form offered a choice.
   *
   * SET NULL rather than RESTRICT: a business must be able to retire a headline
   * without being blocked by an old request that mentioned it.
   */
  headline_id    INT UNSIGNED NULL,

  -- ── What happened to it ───────────────────────────────────────────────────
  --
  -- new       nobody has looked
  -- accepted  a job was raised from it. job_card_id says which
  -- rejected  a person decided not to. reason says why
  -- spam      not a real request. Kept, not deleted, so the count is visible
  status         ENUM('new','accepted','rejected','spam') NOT NULL DEFAULT 'new',

  /*
   * The job it became, once accepted.
   *
   * SET NULL, not CASCADE: deleting the job must not destroy the record that
   * somebody asked for it. The request is evidence of a request.
   */
  job_card_id    INT UNSIGNED NULL,
  customer_id    INT UNSIGNED NULL,

  decided_at     DATETIME NULL,
  decided_by_user_id INT UNSIGNED NULL,
  decided_by_name    VARCHAR(120) NULL,
  decided_reason     VARCHAR(400) NULL,

  /*
   * The submitter IP, for triage.
   *
   * Stored and shown, never used to block: the repo has no IP-based blocking
   * anywhere, and inventing one here would be a platform decision made inside a
   * job-cards feature. What it is for is a human looking at ten identical
   * requests and seeing they came from one place.
   */
  submitted_ip   VARCHAR(45) NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_request_reference (reference),
  -- The screen somebody opens: new ones first, newest first.
  KEY ix_request_status (status, created_at),
  -- The daily cap counts by phone. Digits only, so the index is worth having.
  KEY ix_request_phone (contact_phone, created_at),
  KEY ix_request_job (job_card_id),
  CONSTRAINT fk_request_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE SET NULL,
  CONSTRAINT fk_request_headline FOREIGN KEY (headline_id)
    REFERENCES job_headlines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────────

INSERT INTO settings (setting_key, setting_value)
SELECT 'job_intake_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_intake_enabled');

-- Off by default. Opening a public write endpoint is a decision a business
-- makes, not one a migration makes for them.

INSERT INTO settings (setting_key, setting_value)
SELECT 'job_intake_blurb', 'Tell us what you need and we will come back to you.'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_intake_blurb');

-- How many requests one phone number may send in a day. The reservations
-- precedent, and the only rate limit this app has ever had.
INSERT INTO settings (setting_key, setting_value)
SELECT 'job_intake_max_per_phone', '3'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_intake_max_per_phone');

-- Whether the form offers a list of the kinds of work this business does.
INSERT INTO settings (setting_key, setting_value)
SELECT 'job_intake_show_headlines', '1'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_intake_show_headlines');
