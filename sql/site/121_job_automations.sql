-- ============================================================================
-- 121_job_automations.sql — the three things that should happen on their own
-- ============================================================================
--
-- Section 12 asks for a workflow automation engine. The plan argued that out and
-- promised six NAMED automations instead, each separately switchable, on the
-- contracts.auto_send precedent: a general engine needs an event bus this app
-- does not have, plus loop detection and an execution log, and costs more
-- forever in support than the six rules anybody actually wants.
--
-- Three of the six arrived with phase 14 as notifications: told on assign, told
-- on close, and the follower path that carries both. This migration is the other
-- three, and all three are TIME-based -- which is exactly why they need a table
-- and the notifications did not. An event that fires because somebody clicked
-- needs no record; an event that fires because a clock passed needs to know
-- whether it already did.
--
-- ── WHY A CLAIM ROW AND NOT A TIMESTAMP COLUMN ──────────────────────────────
--
-- The cheap version is job_cards.escalated_at, set when the mail goes out. It
-- was rejected twice over.
--
-- It holds ONE event, so the next automation needs another column, and the one
-- after that another -- a schema that grows a column per feature.
--
-- Worse, it is written AFTER the send. A crash in between sends the mail and
-- forgets, so the next tick sends it again. Claiming FIRST inverts that: the row
-- goes in before anything happens, so a crash mid-send leaves a claim with no
-- delivery, which is visible and reportable. Sending twice is the failure nobody
-- notices until a customer complains; not sending is the failure a reconcile
-- screen can find.
--
-- This is job_series_runs from 118, in the same shape and for the same reason.
-- ============================================================================


CREATE TABLE IF NOT EXISTS job_automation_runs (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id  INT UNSIGNED NOT NULL,

  /*
   * Which automation. An ENUM rather than a free string because the whole point
   * of the named-rules approach is that the set is CLOSED -- a typo in a string
   * would silently create a fourth automation that runs forever and reconciles
   * against nothing.
   *
   * respond_breach and resolve_breach are separate values, not one escalation:
   * a job can breach its response promise, get responded to, and then breach its
   * resolution promise as well. One value would let the second escalation be
   * swallowed by the first claim.
   */
  event        ENUM('respond_breach','resolve_breach','visit_reminder','auto_invoice')
               NOT NULL,

  /*
   * The DAY this covers, not the moment it ran.
   *
   * A date rather than a datetime so the unique key means what it should: one
   * escalation per job per day, however many times the tick runs. A datetime
   * would make every run unique and the key would guarantee nothing.
   *
   * For a visit reminder it is the date of the VISIT, so moving a booking to
   * another day earns a fresh reminder rather than being silenced by the old one.
   */
  for_date     DATE         NOT NULL,

  /*
   * What the run produced, where that is a thing. The invoice for auto_invoice;
   * NULL for the notifications, which produce an email and no row.
   */
  result_id    INT UNSIGNED NULL,

  -- 'claimed' only inside the window between claiming and doing. A row left at
  -- claimed means the tick died mid-way, which reconcileJobAutomations reports:
  -- the unique key means it will never be retried, so nothing else would see it.
  status       ENUM('claimed','done','failed') NOT NULL DEFAULT 'claimed',
  detail       VARCHAR(400) NULL,

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The guarantee. Everything above is commentary on this line.
  UNIQUE KEY uq_job_event_day (job_card_id, event, for_date),
  KEY ix_jauto_stuck (status, created_at),
  CONSTRAINT fk_jauto_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── Settings ────────────────────────────────────────────────────────────────
--
-- INSERT IGNORE is safe: setting_key is the unique key and is NOT NULL, so a
-- re-run cannot duplicate and cannot reset a value somebody changed. (Where a
-- unique key includes a NULLABLE column this would NOT dedupe and would need
-- NOT EXISTS -- the gl_mappings trap from 083.)
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  /*
   * Escalate a breached SLA to the owner and followers.
   *
   * ON, because the SLA data has existed since phase 8 and nothing has ever
   * acted on it. A breach worklist nobody is told about is a worklist nobody
   * opens, which is the state this has been in for four phases.
   */
  ('job_auto_escalate', '1'),

  /*
   * Remind a technician the evening before a booked visit.
   *
   * ON. It tells somebody something they want to know about their own day, and
   * the worst case of a wrong one is a person who was already going.
   */
  ('job_auto_visit_reminder', '1'),

  /*
   * How many hours ahead a visit is reminded about. 16 puts the evening tick on
   * tomorrow morning work.
   */
  ('job_auto_visit_hours', '16'),

  /*
   * Raise the draft invoice when a job closes with billable lines.
   *
   * OFF, and the only one of the three that is. The other two send an email; a
   * wrong one is noise. This one creates PAPERWORK against a real customer
   * account, and a job closed by mistake would leave an invoice behind that
   * somebody has to find and void.
   *
   * It raises a DRAFT, never a finalised invoice -- finalising stays a human act
   * through the one posting engine, exactly as invoiceJob has always required.
   * Even so, defaults-off is the honest setting for the one automation that can
   * cost money.
   */
  ('job_auto_invoice', '0');
