-- ============================================================================
-- 113 — SERVICE LEVEL TARGETS FOR JOB CARDS
--
-- Two promises per priority: respond within X, resolve within Y. A geyser
-- burst on a Friday afternoon gets a different promise from a squeaky door.
--
-- WHAT IS STORED AND WHAT IS NOT
--
-- Stored: the POLICY (the promise), and the two DEADLINES once computed.
-- Derived on read, always: whether a job has breached.
--
-- The deadlines are stored for the same reason document totals are stored in
-- 015 and chargeable_km is stored in 107 — a job promised Monday 11:00 under
-- last years trading hours must keep saying Monday 11:00 after somebody edits
-- the trading hours. Recomputing on read would silently restate history, and
-- the one figure a customer argues about is the one you promised them.
--
-- The BREACH is not stored, because a stored flag is wrong the minute after it
-- is written and needs a cron to stay true. Same argument isClosed() makes
-- about open/closed: reaching the deadline IS the breach.
--
-- WHY A POLICY TABLE AND NOT TWO COLUMNS OF MINUTES ON THE JOB
--
-- Because the promise is a property of the business, not of the job. Four rows
-- of policy answer "what do we promise urgent customers", which is a question
-- an owner asks and changes; 400 jobs each carrying their own copy answers
-- nothing and cannot be changed. The job stores the RESULT of applying the
-- policy, plus which policy it was, so a later change to the promise does not
-- rewrite what was already promised.
--
-- WHY TRADING HOURS LIVE IN SETTINGS AND NOT IN THIS TABLE
--
-- One business has one week. Putting opening times on the policy row would let
-- urgent and normal disagree about when Tuesday starts, which is not a feature
-- anybody wants and is four chances to typo instead of one.
-- ============================================================================

-- ── Trading hours: the week the SLA clock runs on ───────────────────────────
--
-- The mask is the shape report_schedules.days_of_week and specials.days_of_week
-- already use: 7 characters, Monday first, 1 means open. One shape, one
-- validator, and a reader who has seen it once recognises it here.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_sla_trading_days', '1111100')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

INSERT INTO settings (setting_key, setting_value)
VALUES ('job_sla_opens_at', '08:00')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

INSERT INTO settings (setting_key, setting_value)
VALUES ('job_sla_closes_at', '17:00')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Public holidays count as closed. On by default: a business that trades
-- through Christmas is the exception, and the safe default is the one that does
-- not breach somebody for a day the doors were locked.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_sla_skip_holidays', '1')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- ── The promises ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS job_sla_policies (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- One policy per priority. The priority enum is the same one job_cards uses;
  -- keeping them in step is why this is not a free-text name.
  priority          ENUM('low','normal','high','urgent') NOT NULL,

  name              VARCHAR(120) NOT NULL,

  -- The two promises, in BUSINESS minutes. NULL means no promise of that kind:
  -- plenty of businesses commit to answering fast and refuse to commit to a
  -- fix date, because the fix depends on a part arriving. A zero would be a
  -- promise of instant, which is not the same statement.
  respond_minutes   INT UNSIGNED NULL,
  resolve_minutes   INT UNSIGNED NULL,

  -- A policy can be retired without deleting it, so jobs that were measured
  -- against it keep their reference and their history stays readable.
  is_active         TINYINT(1) NOT NULL DEFAULT 1,

  note              VARCHAR(190) NULL,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One live policy per priority. Two would make "which promise applies" a
  -- question with two answers, and the pickers would disagree with the maths.
  UNIQUE KEY uq_sla_priority (priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Defensible starting figures, in business minutes against a 9-hour day:
--   urgent  respond 1h,  resolve 1 day
--   high    respond 4h,  resolve 2 days
--   normal  respond 1 day, resolve 5 days
--   low     respond 2 days, no resolve promise
--
-- INSERT IGNORE on a unique key with no nullable column, so a re-run cannot
-- reset a figure somebody has since tuned. (The gl_mappings trap does not apply
-- here: priority is NOT NULL, so the unique key actually dedupes.)
INSERT IGNORE INTO job_sla_policies (priority, name, respond_minutes, resolve_minutes)
VALUES
  ('urgent', 'Urgent',   60,   540),
  ('high',   'High',     240,  1080),
  ('normal', 'Standard', 540,  2700),
  ('low',    'Low',      1080, NULL);

-- ── What the job remembers ─────────────────────────────────────────────────
--
-- Risky ALTERs first is the ordering rule, but these three are additive on a
-- table this migration has no other business with, so the order is simply the
-- order they are read in.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS sla_policy_id INT UNSIGNED NULL AFTER priority;

-- The two deadlines, as stored wall clock. NULL means no promise applies —
-- either no policy for that priority, or a policy that promises nothing of that
-- kind. NULL is not "not yet computed": these are written when the job is
-- created and rewritten when the priority changes.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS respond_by DATETIME NULL AFTER sla_policy_id;

ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS resolve_by DATETIME NULL AFTER respond_by;

-- WHEN SOMEBODY FIRST DID SOMETHING ABOUT IT.
--
-- The response clock stops here, and this is the column that makes the
-- distinction between "met" and "not breached yet" possible. Set once and never
-- overwritten: a second reply does not un-respond the first, and letting it move
-- would quietly turn a met target into a breach.
--
-- Not derived from the activity log: the log records every field edit, so the
-- first entry is usually the creation itself, and a job would count as responded
-- to the instant it was typed in.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS responded_at DATETIME NULL AFTER resolve_by;

ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS responded_by_user_id INT UNSIGNED NULL AFTER responded_at;

ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS responded_by_name VARCHAR(120) NULL AFTER responded_by_user_id;

-- RESTRICT, not SET NULL: a policy holding jobs must not be deletable, because
-- losing it loses the answer to "what did we promise this customer". The code
-- offers is_active = 0 instead, which is the same move stock_locations makes.
ALTER TABLE job_cards
  ADD FOREIGN KEY IF NOT EXISTS fk_job_sla (sla_policy_id)
  REFERENCES job_sla_policies (id) ON DELETE RESTRICT;

-- The worklist query: open jobs with a deadline, soonest first. Both deadlines
-- get an index because the two worklists are separate questions — "who is
-- waiting for a first reply" is asked by a dispatcher every hour, and "what will
-- miss its fix date" is asked by a manager once a day.
ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_job_respond (status, responded_at, respond_by);

ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_job_resolve (status, resolve_by);
