-- ─────────────────────────────────────────────────────────────────────────
-- Two-way calendar sync with Google and Outlook (§46.13).
--
-- ── WHAT ALREADY EXISTED, AND WHY THIS IS NOT THAT ───────────────────────
--
-- 108 gave every technician a SUBSCRIBE URL: an .ics feed their calendar polls,
-- read-only, no account linking, no OAuth. That still exists and is still the
-- right answer for somebody who just wants to see their day on their phone.
--
-- What a feed cannot do is the half §46.13 actually asks for:
--
--   * A subscriber POLLS, typically every few hours and entirely at the mercy
--     of the calendar provider. A visit moved at 09:00 can show at 09:00 in the
--     old slot until lunchtime. For "the customer moved it to Thursday" that is
--     not a sync, it is a rumour.
--   * A feed is one-directional by construction. It cannot see that the
--     technician has a dentist appointment at 14:00, so the scheduler keeps
--     cheerfully booking over it.
--
-- So: OAuth per person, events PUSHED as they change, and the external calendar
-- read back for busy time.
--
-- ── ODYSSEY IS THE SYSTEM OF RECORD, ALWAYS ──────────────────────────────
--
-- The single most important decision in this file, and §46.13 is explicit about
-- it. A job visit exists because a business booked work. It has a customer, an
-- address, parts reserved against it, an SLA promise measured from it, and an
-- invoice that will be raised off it.
--
-- A calendar event has none of that. So the sync is deliberately ASYMMETRIC:
--
--   Odyssey → provider   the full truth, written on every change.
--   provider → Odyssey   two things only, and NEITHER writes an appointment:
--                          1. busy time, opaque, feeding conflict detection
--                          2. a PROPOSED change, which a person accepts
--
-- The temptation is to make a dragged event in Google just move the visit. It
-- must not. Dragging in Google cannot re-check the parts, cannot re-run the
-- travel gap, cannot ask whether the customer agreed, and cannot know the job
-- was closed an hour ago. A silent write would produce a visit nobody can
-- explain, and the audit trail would say a technician's phone did it.
--
-- What it CAN do is say "somebody moved this, here is what they want" and let
-- the change go through the same booking path a dispatcher uses, with the same
-- conflict checks and the same activity entry. That is what job_calendar_changes
-- is for, and accepting one is an ordinary reschedule.
--
-- ── WHY BUSY TIME IS OPAQUE ──────────────────────────────────────────────
--
-- job_calendar_busy stores a start, an end and NOTHING else. No title, no
-- attendees, no description, deliberately:
--
--   * The business needs to know the person is not free. It does not need to
--     know they are at a funeral, at a job interview, or seeing an oncologist.
--   * A dispatcher screen showing a technician's private calendar entries is a
--     privacy incident waiting to be discovered by the technician.
--   * Storing less means a breach leaks less, and a busy block is genuinely all
--     the scheduler consumes.
--
-- Google and Microsoft both offer exactly this shape natively (freeBusy /
-- getSchedule), so the opaque version is also the cheaper call.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. A person's linked calendar account ────────────────────────────────
CREATE TABLE IF NOT EXISTS job_calendar_accounts (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- WHOSE calendar. Per user, never per site: a business does not have a
  -- calendar, people do, and a shared service account would put every
  -- technician's visits in one stream that none of them can usefully read.
  user_id     INT UNSIGNED NOT NULL,
  user_name   VARCHAR(120) NOT NULL DEFAULT '',

  provider    ENUM('google','microsoft') NOT NULL,

  -- Who the provider says this is. Shown on the setup screen so somebody who
  -- linked the wrong account of the three they own can see which one it is.
  account_email VARCHAR(190) NOT NULL DEFAULT '',

  /*
   * Which calendar within that account.
   *
   * 'primary' for almost everybody. It matters for the person who keeps a
   * separate "Work" calendar and does not want job visits landing among their
   * family's dentist appointments — and for the business whose technicians
   * share a dispatch calendar the office also watches.
   */
  calendar_id VARCHAR(255) NOT NULL DEFAULT 'primary',

  /*
   * The refresh token, AES-256-GCM enveloped by crypto/secrets.
   *
   * NEVER the access token: those last an hour, so storing one is storing
   * something already expired by the next tick, and it would be a second secret
   * to protect for no benefit. The refresh token is exchanged for an access
   * token at the moment of use and the access token is never written down.
   *
   * TEXT because Microsoft's refresh tokens run past a kilobyte before the
   * envelope adds its own overhead, and a VARCHAR(255) here would truncate
   * silently and fail at the next refresh with an error naming neither cause.
   */
  refresh_token_enc TEXT NULL,

  /*
   * Which way this account syncs. Both halves are separately switchable because
   * they are separately objectionable.
   *
   * Somebody may be glad to have work appear in their calendar and unwilling to
   * let their employer read what else is in it. That person sets push on and
   * pull off, and the scheduler simply does not know when they are busy — which
   * is exactly the state of affairs before this file existed, so it costs
   * nothing and the alternative is that they do not link at all.
   */
  push_enabled TINYINT(1) NOT NULL DEFAULT 1,
  pull_enabled TINYINT(1) NOT NULL DEFAULT 1,

  /*
   * Why this account stopped working, or ''.
   *
   * A refresh token dies when somebody changes their password, revokes access
   * from their Google account screen, or leaves the company. The sync then fails
   * silently forever, which is the worst outcome: the technician believes their
   * calendar is authoritative and it has been stale for a month.
   *
   * So the failure is RECORDED and shown on the setup screen, in words, next to
   * a button that re-links.
   */
  last_error  VARCHAR(400) NOT NULL DEFAULT '',
  last_push_at DATETIME NULL,
  last_pull_at DATETIME NULL,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  /*
   * One account per person per provider.
   *
   * Not per (user, provider, calendar_id): letting one person link two Google
   * calendars means every push has to decide which one, and the honest answer
   * is that nobody wants their visits in two places. Changing calendar means
   * editing the row.
   *
   * Note this key is over two NOT NULL columns, so it genuinely constrains —
   * unlike a nullable "default" key, which does not. That mistake has been made
   * twice in this schema.
   */
  UNIQUE KEY uq_jcalacct_user (user_id, provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── 2. What we put in their calendar, and where it landed ────────────────
--
-- The provider's own id for the event we created, so the NEXT push updates it
-- in place rather than creating a second one. Without this table a moved visit
-- produces two events and the technician drives to the wrong address — the same
-- failure the ICS feed's stable UID rule exists to prevent, arriving by a
-- different route.
CREATE TABLE IF NOT EXISTS job_calendar_links (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id     INT UNSIGNED NOT NULL,
  appointment_id INT UNSIGNED NOT NULL,

  -- The provider's event id. Opaque; never parsed, only handed back.
  external_id    VARCHAR(255) NOT NULL,

  /*
   * A fingerprint of what we last pushed.
   *
   * The push is skipped when nothing a calendar can see has changed. Not an
   * optimisation for its own sake: both providers rate-limit, an appointment row
   * is touched by things a calendar does not care about (arrived_at,
   * travel_started_at, an outcome note), and re-pushing an identical event still
   * costs a quota unit and still risks a notification on the technician's phone
   * saying an event "changed" when it did not.
   */
  pushed_hash    CHAR(40) NOT NULL DEFAULT '',
  pushed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One event per appointment per account. The claim that makes the update
  -- in-place possible at all.
  UNIQUE KEY uq_jcallink (account_id, appointment_id),
  KEY ix_jcallink_ext (external_id),

  CONSTRAINT fk_jcallink_acct FOREIGN KEY (account_id)
    REFERENCES job_calendar_accounts (id) ON DELETE CASCADE,
  /*
   * CASCADE from the appointment, and this is load-bearing rather than tidy.
   *
   * A deleted appointment must take its link with it, because the link is the
   * only record that an event exists in somebody's Google calendar. Orphan the
   * row and the event is unreachable: nothing knows to delete it, and the
   * technician has a ghost booking for a visit that no longer exists, forever.
   *
   * The deletion path therefore reads the links BEFORE deleting the appointment.
   * See removeCalendarEvents in jobCalendar.ts.
   */
  CONSTRAINT fk_jcallink_appt FOREIGN KEY (appointment_id)
    REFERENCES job_card_appointments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── 3. Busy time read back, opaque ───────────────────────────────────────
--
-- See the header for why there is no title column and never will be.
--
-- A CACHE, not a record: rows are replaced wholesale per (account, window) on
-- every pull, because the question "is this person free on Tuesday" has exactly
-- one right answer and it is whatever the provider said most recently. Merging
-- would mean keeping a deleted dentist appointment forever.
CREATE TABLE IF NOT EXISTS job_calendar_busy (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id  INT UNSIGNED NOT NULL,

  -- Denormalised from the account so conflict detection can join on one column
  -- without reaching through job_calendar_accounts on every booking check.
  user_id     INT UNSIGNED NOT NULL,

  starts_at   DATETIME NOT NULL,
  ends_at     DATETIME NOT NULL,

  /*
   * Whether this block came from an event Odyssey itself pushed.
   *
   * Without it the sync accuses itself: we push a visit to Google, read the
   * busy time back, and warn the dispatcher that the technician is already
   * booked — on the very visit being booked. Set by matching the provider's
   * event id against job_calendar_links, and excluded from conflict detection.
   */
  is_ours     TINYINT(1) NOT NULL DEFAULT 0,

  fetched_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The conflict check's own read: this person, this day.
  KEY ix_jcalbusy_when (user_id, starts_at, ends_at),
  KEY ix_jcalbusy_acct (account_id),

  CONSTRAINT fk_jcalbusy_acct FOREIGN KEY (account_id)
    REFERENCES job_calendar_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── 4. Somebody moved it in their calendar ───────────────────────────────
--
-- A PROPOSAL. Never applied automatically — the header says why at length.
--
-- The row exists so that a technician dragging a visit in Google is not simply
-- ignored, which is the other way to get this wrong: if the drag does nothing
-- and says nothing, they believe the visit moved and Odyssey believes it did
-- not, and the customer finds out which is which.
CREATE TABLE IF NOT EXISTS job_calendar_changes (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id     INT UNSIGNED NOT NULL,
  appointment_id INT UNSIGNED NOT NULL,

  -- What they moved it to. NULL end means they only changed the start.
  proposed_starts_at DATETIME NOT NULL,
  proposed_duration_minutes SMALLINT UNSIGNED NULL,

  -- What it was when we noticed, so the screen can say "09:00 → 14:00" rather
  -- than making somebody open two tabs. Frozen at detection: the appointment
  -- may since have moved again for other reasons.
  previous_starts_at DATETIME NOT NULL,
  previous_duration_minutes SMALLINT UNSIGNED NOT NULL,

  --   pending    waiting for somebody to decide
  --   accepted   put through the ordinary booking path, conflicts and all
  --   declined   refused; the next push puts the calendar back
  --   stale      the appointment moved underneath it, so the proposal is about
  --              a state that no longer exists and cannot be meaningfully applied
  status      ENUM('pending','accepted','declined','stale') NOT NULL DEFAULT 'pending',

  decided_at  DATETIME NULL,
  decided_by_user_id INT UNSIGNED NULL,
  decided_by_name VARCHAR(120) NOT NULL DEFAULT '',

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The queue: what is waiting to be decided.
  KEY ix_jcalchg_pending (status, created_at),
  KEY ix_jcalchg_appt (appointment_id),

  CONSTRAINT fk_jcalchg_acct FOREIGN KEY (account_id)
    REFERENCES job_calendar_accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_jcalchg_appt FOREIGN KEY (appointment_id)
    REFERENCES job_card_appointments (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
