-- ── A promise made to ONE customer, and what happens when it is missed ──────
--
-- 113 gives the business four promises, one per priority. A contract customer
-- who pays for a four-hour response gets the same row as everybody else, and
-- 17.5 asks for per-customer targets and escalation rules by name.
--
-- ── THE UNIQUE KEY BECOMES NULLABLE, AND THAT IS A TRAP ─────────────────────
--
-- 113s own comment says, of its INSERT IGNORE seed:
--
--   "The gl_mappings trap does not apply here: priority is NOT NULL, so the
--    unique key actually dedupes."
--
-- Adding a nullable customer_id makes it apply. In MySQL two rows with
-- (NULL, urgent) do NOT collide, because NULL is not equal to NULL — so
-- uq_sla_customer_priority cannot stop a second business default, and
-- INSERT IGNORE against it does nothing at all. 083 learned this the hard way
-- with gl_mappings and a NULL ref_id.
--
-- Consequences, both handled deliberately:
--
--   the seed below is NOT EXISTS, never INSERT IGNORE;
--   savePolicy must do the same, and reconcileSla reports a duplicate default
--   if one ever gets in by another route.
--
-- The key is still worth having: it dedupes every PER-CUSTOMER row, which is
-- the case a picker can actually produce twice.
--
-- ── NULL MEANS THE BUSINESS DEFAULT ─────────────────────────────────────────
--
-- Not "no customer". Every existing row keeps customer_id NULL and goes on
-- being the promise for everybody who has no policy of their own, so this
-- migration changes nothing about what any current job is measured against.
--
-- Selection is: this customers policy for this priority, else the default.
-- Two reads or one query with an ORDER BY; jobSla does the latter.

ALTER TABLE job_sla_policies
  ADD COLUMN IF NOT EXISTS customer_id INT UNSIGNED NULL AFTER id;

-- The old key allowed exactly one policy per priority across the whole site.
-- It has to go before the new one can exist, or per-customer rows are refused.
-- Standalone DROP INDEX, matching 092: MariaDB takes IF EXISTS in that form,
-- and the ALTER TABLE ... DROP INDEX IF EXISTS spelling is the one to distrust.
DROP INDEX IF EXISTS uq_sla_priority ON job_sla_policies;

ALTER TABLE job_sla_policies
  ADD UNIQUE KEY IF NOT EXISTS uq_sla_customer_priority (customer_id, priority);

-- SET NULL rather than CASCADE: deleting a customer must not silently delete a
-- promise, and a policy that loses its customer becomes a business default,
-- which reconcileSla then reports as a duplicate rather than leaving it to
-- quietly compete with the real one.
ALTER TABLE job_sla_policies
  ADD FOREIGN KEY IF NOT EXISTS fk_sla_customer (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL;

-- ── Escalation ──────────────────────────────────────────────────────────────
--
-- Two columns, not a table. An escalation is "after this long, tell this
-- person" — one fact per policy, and a table would buy escalation ladders
-- nobody has asked for at the cost of a join on the hot path.
--
-- escalate_after_minutes is BUSINESS minutes, like every other figure here, and
-- is measured from the REPORTED time rather than from the breach: a business
-- that wants telling before the deadline sets it below respond_minutes, and one
-- that wants telling after sets it above. Measuring from the breach would make
-- the first of those inexpressible.
--
-- escalate_to_user_id has no FK and no snapshotted name, unlike the crew and
-- request tables: this is a LIVE routing rule, not evidence. A manager who
-- leaves should stop being escalated to, and the notification that already went
-- out is the record of what happened.
ALTER TABLE job_sla_policies
  ADD COLUMN IF NOT EXISTS escalate_after_minutes INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS escalate_to_user_id INT UNSIGNED NULL;

ALTER TABLE job_sla_policies
  ADD KEY IF NOT EXISTS ix_sla_customer (customer_id);

-- ── The claim, so an escalation fires once ──────────────────────────────────
--
-- Same shape as job_automations (121): a row claimed under a unique key BEFORE
-- the side effect, so a missed promise escalates once rather than every time
-- the tick runs. Without this, a job breached on Monday would notify its
-- manager every five minutes until somebody closed it.
CREATE TABLE IF NOT EXISTS job_sla_escalations (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id  INT UNSIGNED NOT NULL,

  -- Which promise was missed. A job can escalate once for a late reply and
  -- again for a late fix; they are different failures.
  kind         ENUM('respond','resolve') NOT NULL,

  notified_user_id INT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- THE CLAIM. Both columns NOT NULL, so this key really does dedupe.
  UNIQUE KEY uq_sla_escalation (job_card_id, kind),

  CONSTRAINT fk_slaesc_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ────────────────────────────────────────────────────────────────
--
-- OFF by default. Escalation names a person and tells them somebody else is
-- late; switching that on for every existing site the morning after a migration
-- would be somebody elses inbox, unasked.
INSERT INTO settings (setting_key, setting_value)
SELECT 'job_sla_escalation_enabled', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_sla_escalation_enabled');
