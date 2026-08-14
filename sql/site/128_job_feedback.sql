-- ── Customer feedback on a finished job ─────────────────────────────────────
--
-- One star rating and one optional comment, asked for when the job closes.
--
-- ── WHY ONE ROW PER JOB AND NOT A GENERAL SURVEY ────────────────────────────
--
-- Because a survey is a different product. The PRD asks whether the customer was
-- happy with the work; that is one number and one sentence, and a table shaped
-- for exactly that can be read, reported and trended with no machinery at all.
--
-- A general survey engine needs questions, question types, ordering, versioning
-- and per-response storage — which this site already has, for checklists, in
-- job_headline_items. If somebody ever needs five questions, that mechanism is
-- the one to extend rather than this table.
--
-- ── WHY THE RATING IS NOT NULLABLE AND THE COMMENT IS ───────────────────────
--
-- A row exists because somebody answered. Answering means the star; the comment
-- is a bonus most people skip. So a NULL rating would be a row that means
-- nothing, and the whole point of reading this table is that every row is a real
-- opinion.
--
-- A customer who was ASKED and did not answer is not a row here. That is the
-- difference between requested_at and responded_at below, and it is what makes a
-- response RATE calculable rather than guessed at.
--
-- ── WHY NOT product_reviews ─────────────────────────────────────────────────
--
-- 035_product_reviews is about a PRODUCT, is moderated before publication, and
-- is shown on a public storefront. This is about a piece of WORK, is never
-- published anywhere, and needs no moderation because nobody but the business
-- ever reads it. Sharing the table would mean every job rating landing in the
-- storefront moderation queue.

CREATE TABLE IF NOT EXISTS job_feedback (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,

  /*
   * ONE per job. The unique key is the whole guard: a customer following the
   * emailed link twice must correct their answer, not leave two.
   */
  job_card_id  INT UNSIGNED NOT NULL,

  /*
   * Copied from the job when the request is sent, not read through it.
   *
   * A snapshot, for the reason every other snapshot in this schema exists: the
   * job can be reassigned to another customer, and the answer belongs to whoever
   * was actually asked. NULL for a job with no customer, which is legal.
   */
  customer_id  INT UNSIGNED NULL,

  /*
   * When the link went out, and when they answered.
   *
   * Both, because the gap between them IS the response rate. requested_at with
   * no responded_at is somebody who was asked and did not reply, which is the
   * commonest outcome and the one a rate needs to count.
   */
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at DATETIME NULL,

  /*
   * One to five. NULL until they answer.
   *
   * No CHECK constraint naming the range: MariaDB enforces CHECK, but the range
   * is also validated in code where the error message can say something useful,
   * and a constraint violation surfacing as a 500 on a public page is worse than
   * a refusal that explains itself. The column type is the backstop.
   */
  rating       TINYINT UNSIGNED NULL,

  comment      VARCHAR(1000) NULL,

  /*
   * Whether anybody in the business has looked at it.
   *
   * Not a workflow, just a flag: a one-star rating that nobody saw is the single
   * most expensive thing this table can hold. The jobs screen counts the unseen
   * ones, and marking it seen is one press.
   */
  seen_at      DATETIME NULL,
  seen_by_user_id INT UNSIGNED NULL,
  seen_by_name    VARCHAR(120) NULL,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_feedback_job (job_card_id),
  -- The two reads: unseen answers, and the trend over time.
  KEY ix_feedback_unseen (responded_at, seen_at),
  KEY ix_feedback_rating (rating, responded_at),
  KEY ix_feedback_customer (customer_id),
  /*
   * CASCADE. A deleted job takes its feedback with it: the answer is about that
   * job and means nothing without it, unlike a deposit, which is money and
   * survives on the customer account.
   */
  CONSTRAINT fk_feedback_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────────
--
-- NOT EXISTS rather than INSERT IGNORE: settings.setting_key is the primary key
-- here so IGNORE would be safe, but the house rule is NOT EXISTS wherever a seed
-- must never overwrite a live value, and a re-run must not switch somebody
-- feedback back on after they turned it off.

INSERT INTO settings (setting_key, setting_value)
SELECT 'job_feedback_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_feedback_enabled');

-- Off by default, and deliberately: switching this on emails every customer
-- whose job closes, and that is a decision a business makes, not one a migration
-- makes for them.

INSERT INTO settings (setting_key, setting_value)
SELECT 'job_feedback_intro', 'Thank you for your business. How did we do?'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_feedback_intro');
