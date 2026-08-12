-- ─────────────────────────────────────────────────────────────────────────
-- Appointments: when somebody is going, and who.
--
-- ── WHY A VISIT IS NOT A COLUMN ON THE JOB ───────────────────────────────
--
-- 104 gave a job card a due_at and nothing else, which is right for a workshop
-- repair somebody collects. It is wrong for field service, and the PRD says why:
-- a job may have one or more appointments, because a real job is quoted on
-- Monday, first attended on Wednesday, waits for a part, and is finished the
-- following Tuesday. Three visits, three technicians, three sets of hours.
--
-- Putting scheduled_at on job_cards would model the FIRST visit and lose the
-- rest. Adding scheduled_at_2 is the shape that tells you the model is wrong.
--
-- ── AND WHY IT IS NOT A TAB ──────────────────────────────────────────────
--
-- Not schema, but recorded here because the table shape follows from it: a visit
-- has its own lifecycle, its own technician, its own arrival, and eventually its
-- own time entries and location stamps. A technician standing on somebody's
-- driveway opens THE VISIT, not the job. So it gets its own row and, later, its
-- own screen.
--
-- ── THE STATUSES ARE FIXED, UNLIKE THE JOB STATUSES ──────────────────────
--
-- 104 made job statuses a configurable table, at length, because how many stages
-- there are and what each is called is a property of the business. Appointment
-- status is the opposite: these seven describe where a person physically is, and
-- that is not a matter of local vocabulary. Every field-service business on earth
-- has somebody who has not left yet, is driving, is on site, or did not turn up.
--
-- A configurable version would also break the one thing this column is for —
-- deciding whether a job counts as SCHEDULED. The PRD is explicit that a
-- cancelled or completed appointment must not make a job count as scheduled, and
-- that rule cannot survive a business inventing a status the code has never seen.
--
-- ── UNSCHEDULED IS DERIVED, NEVER STORED ─────────────────────────────────
--
-- An open job with no live future appointment. Stored, it would need a nightly
-- job to stay true and would be wrong in between — the same argument quoteState()
-- makes about expiry, and isClosed() about open versus closed. A date passing is
-- not an event anybody triggers.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_card_appointments (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id     INT UNSIGNED NOT NULL,

  -- Which visit this is, from 1. Renumbered on delete so a job never shows
  -- "visit 1, visit 3" and leaves somebody wondering what happened to 2.
  visit_number    SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  --   scheduled    booked, nobody has confirmed with the customer
  --   confirmed    the customer knows and agreed
  --   en_route     travelling
  --   on_site      arrived
  --   completed    the visit is over. Says nothing about the JOB being done.
  --   cancelled    called off before it happened
  --   no_show      the customer was not there
  --
  -- completed and cancelled and no_show are the three that stop this counting as
  -- a live booking. See LIVE_APPOINTMENT in jobAppointments.ts, which is the one
  -- predicate every query shares.
  status          ENUM('scheduled','confirmed','en_route','on_site','completed','cancelled','no_show')
                  NOT NULL DEFAULT 'scheduled',

  -- When, and for how long. DATETIME and minutes rather than a start and an end:
  -- every screen that draws a lane needs the duration to size a block, and
  -- deriving it from two timestamps means every caller repeats the subtraction.
  starts_at       DATETIME NOT NULL,
  duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60,

  -- Where. Copied from the job at creation and then editable, because a second
  -- visit is sometimes to a different building on the same account.
  service_address_id INT UNSIGNED NULL,

  -- What kind of visit, for reporting: first look, the actual repair, a
  -- follow-up, a quote survey. Free text rather than an ENUM, matching
  -- customer_contacts.role: the useful values differ per trade and a new one
  -- should be data, not a migration.
  visit_type      VARCHAR(60)  NULL,

  notes           VARCHAR(1000) NULL,

  -- What actually happened, as against what was booked. NULL until it does.
  -- These are the figures every on-time-arrival report is built from, and they
  -- cannot be reconstructed later.
  travel_started_at DATETIME NULL,
  arrived_at      DATETIME NULL,
  departed_at     DATETIME NULL,

  -- Why it did not happen. Required by code for cancelled and no_show, because
  -- a missed visit with no reason is the thing a customer phones about.
  outcome_reason  VARCHAR(190) NULL,

  -- Set when somebody booked over a known conflict. The PRD allows the override
  -- and requires the reason be captured and audited — this is the audited half,
  -- and the activity log carries the rest.
  override_reason VARCHAR(190) NULL,

  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_jappt_job (job_card_id, visit_number),
  -- The day view: "what is booked on Tuesday", scanned by status so the
  -- cancelled ones drop out at the index rather than in PHP.
  KEY ix_jappt_when (starts_at, status),
  KEY ix_jappt_address (service_address_id),
  CONSTRAINT fk_jappt_job FOREIGN KEY (job_card_id) REFERENCES job_cards (id) ON DELETE CASCADE,
  -- SET NULL, matching job_cards: an address may be retired while the visit it
  -- served is history.
  CONSTRAINT fk_jappt_address FOREIGN KEY (service_address_id)
    REFERENCES service_addresses (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Who is going ─────────────────────────────────────────────────────────
-- A separate table because a visit takes two people often enough that a single
-- user_id would be wrong, and the PRD asks for it: a job may be assigned to one
-- user, several, or a team.
--
-- job_cards.owner_user_id stays the job LEAD — one person answerable for the
-- whole thing, which the PRD also requires. This is who attends a given visit,
-- which is a different question: the lead often does not attend at all.
CREATE TABLE IF NOT EXISTS job_appointment_assignees (
  appointment_id  INT UNSIGNED NOT NULL,

  -- cp2_users.id from the CONTROL database, so no FK is possible. The name is
  -- snapshotted for the same reason every other document snapshots it.
  user_id         INT UNSIGNED NOT NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  -- The one who leads THIS visit, where two people attend. Enforced in code
  -- rather than by a constraint: a partial unique index is not available, and a
  -- visit mid-edit with nobody marked lead is a legitimate intermediate state.
  is_lead         TINYINT(1) NOT NULL DEFAULT 0,

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (appointment_id, user_id),
  -- "What is this technician doing on Tuesday" — the read the whole schedule
  -- screen and every conflict check are built from.
  KEY ix_jassign_user (user_id),
  CONSTRAINT fk_jassign_appt FOREIGN KEY (appointment_id)
    REFERENCES job_card_appointments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ─────────────────────────────────────────────────────────────
-- How long a visit is assumed to take when nobody says.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_default_visit_minutes', '60')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- The working day, for the schedule screen and the outside-hours warning.
-- Deliberately a pair of times rather than a per-day table: this decides where a
-- lane starts and stops being drawn, not whether the business is open, and a
-- shop that works Saturdays draws the same lane on it.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_day_starts', '07:00')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

INSERT INTO settings (setting_key, setting_value)
VALUES ('job_day_ends', '17:00')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Minutes to leave between two visits for the same person.
--
-- A flat allowance, NOT a computed drive time: nothing in this app talks to a
-- distance provider, and inventing a figure per pair of addresses would be
-- guessing dressed as arithmetic. Thirty minutes catches the case that actually
-- bites — two visits booked back to back across town — and the real
-- travel-time check waits for a provider. See the note in jobAppointments.ts.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_gap_minutes', '30')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
