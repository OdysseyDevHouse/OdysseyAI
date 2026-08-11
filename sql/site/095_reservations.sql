-- Table reservations — a booking is a promise about a future seat.
--
-- ── WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT ───────────────────────────
--
-- It is NOT a sale, and nothing here writes to sales_documents. An online order
-- resolves into a draft sale through saveDraft() because an order IS a
-- transaction — a basket, at a price, that finalises at the till. A booking has
-- no lines, no value and no stock movement. Forcing one through invoicing would
-- put empty draft sales into every sales report and into cash-up, for parties
-- that may never arrive.
--
-- It meets the money later and naturally: the party arrives, staff mark the
-- booking seated, and the till opens that table by name exactly as it does for
-- a walk-in. document_id below is stamped at that moment IF a sale is already
-- open on the table — a convenience link for the queue ("this booking is the
-- party currently on Table 12"), never a dependency. A reservation with
-- document_id NULL is completely normal and always will be.
--
-- ── THE JOIN KEY IS table_name, DELIBERATELY ────────────────────────────────
--
-- Matched by NAME against the same free-text string the POS floor plan already
-- turns on (see 086_pos_floor_plan.sql). Matching by name means drawing
-- tonight's bookings onto the floor plan later is a COMPONENT change, not a
-- migration, and this feature never adds a column to the sale row or touches
-- the offline sync whitelist. The known cost is the one the floor plan already
-- accepts: rename a table and bookings against the old name stop lining up.
--
-- ── party_size / table_name / duration_minutes SHIP UNUSED BY v1's RULES ────
--
-- Phase one does not enforce capacity, does not assign a table and does not
-- compute table turns — staff read the party size and decide. They are here
-- anyway: every phase-two request (refuse bookings when the room is full, put
-- this party on Table 12, show tonight on the plan) needs exactly these three,
-- and a column that costs a few bytes today saves a migration across every site
-- database later. What is NOT here is a slot/capacity table — guessing that
-- shape before the capacity rules exist is how you get a table nothing fits.
--
-- ── NO DEPOSITS IN v1 ───────────────────────────────────────────────────────
--
-- Taking money for a booking raises a refund-policy question that belongs to a
-- considered phase two, not to the first version.

-- The booking itself.
--
-- Status lifecycle:
--   pending   -> confirmed | cancelled          (staff accept, or either side calls it off)
--   confirmed -> seated | no_show | cancelled   (they arrived, or they didn't)
--   seated    -> completed | cancelled
--
-- 'no_show' is a terminal status of its own rather than a flavour of cancelled
-- because it is the one thing restaurateurs actually want counted: a party that
-- cancelled freed the table, a no-show did not.
CREATE TABLE IF NOT EXISTS reservations (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  /* Shown to the guest and quoted over the phone. RS000123. Derived from the
     id rather than the numbering table: a booking is not a document, it never
     appears in a sequence report, and verifySequence would count every one of
     these as a gap. See 'Serial counts are strings' — same argument. */
  reference        VARCHAR(20) NOT NULL DEFAULT '',
  status           ENUM('pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled')
                     NOT NULL DEFAULT 'pending',
  /* How the booking arrived. 'phone' and 'walk_in' exist so the queue can be the
     ONE place staff see tonight's book, rather than a screen that only knows
     about internet bookings beside a paper diary that knows the rest. */
  source           ENUM('online', 'phone', 'walk_in') NOT NULL DEFAULT 'online',
  contact_name     VARCHAR(120) NOT NULL DEFAULT '',
  contact_phone    VARCHAR(50) NOT NULL DEFAULT '',
  contact_email    VARCHAR(190) NOT NULL DEFAULT '',
  party_size       INT UNSIGNED NOT NULL DEFAULT 0,
  /*
   * The booked slot, in the SITE's wall-clock time. A plain DATETIME for the
   * same reason the rest of this schema uses one: every site reads its own
   * clock, and the report ranges in this codebase are already built against DB
   * wall-clock rather than UTC. Mixing the two is the trap asAt threading
   * already documents.
   */
  reserved_for     DATETIME NOT NULL,
  duration_minutes INT UNSIGNED NOT NULL DEFAULT 90,
  /* Nullable in spirit — see the header. Matched by NAME against the floor plan
     and the open sale, never validated against either, because a shop that has
     never drawn a plan must still be able to write "Patio 3" on a booking. */
  table_name       VARCHAR(50) NOT NULL DEFAULT '',
  customer_note    VARCHAR(500) NOT NULL DEFAULT '',
  /* Why staff declined, or why the guest cancelled. Shown back to nobody
     automatically; it exists so the queue can explain itself a week later. */
  cancel_reason    VARCHAR(255) NOT NULL DEFAULT '',
  seated_at        DATETIME NULL,
  /* Convenience link to the open sale, never a dependency. See the header.
     ON DELETE SET NULL: voiding the sale must not delete the booking record. */
  document_id      INT UNSIGNED NULL,
  /* The submitter's IP, kept only for abuse triage on a form with no login. */
  submitted_ip     VARCHAR(45) NOT NULL DEFAULT '',
  /*
   * Who took or last touched the booking. Denormalised name alongside the id,
   * the same pair 094_tip_payouts.sql uses and for the same reason: a staff
   * member who leaves and is deleted must not erase the record of who confirmed
   * a table. Both stay empty/NULL for an online booking, which nobody took.
   */
  user_id          INT UNSIGNED NULL,
  user_name        VARCHAR(120) NOT NULL DEFAULT '',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reservation_reference (reference),
  /* The queue's own query: tonight, in time order. */
  KEY ix_resv_when (reserved_for, status),
  KEY ix_resv_status (status, reserved_for),
  /* Backs the per-phone-per-day abuse check on the public form. */
  KEY ix_resv_phone (contact_phone, created_at),
  KEY ix_resv_table (table_name, reserved_for),
  CONSTRAINT fk_resv_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_resv_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reservation configuration — one row per site, id pinned to 1.
--
-- opening_hours is a JSON object keyed by weekday (0=Sunday) holding the ranges
-- the shop takes bookings in: {"5":[["18:00","21:30"]]}. JSON rather than
-- columns because a restaurant's week is genuinely irregular — lunch and dinner
-- on Saturday, dinner only midweek, closed Monday — and a column pair per day
-- cannot express two sittings without a second pair per day.
--
-- THESE ARE THE FIELDS THAT MAKE THE FORM HONEST. lead_time_minutes is the
-- storefront's lesson repeated (an order must not promise what the kitchen
-- cannot deliver): a booking for twenty minutes from now, on a form nobody is
-- watching, is worse than no booking. horizon_days stops someone booking a
-- table for next Christmas. max_party_size sends the party of forty to the
-- phone, where a human belongs.
--
-- auto_confirm defaults OFF: with no capacity enforcement in v1, auto-confirming
-- would let the room be booked past full with the shop's own promise attached.
-- Staff confirm, and the guest is told the booking is a request until they do.
CREATE TABLE IF NOT EXISTS reservation_settings (
  id                       INT UNSIGNED NOT NULL DEFAULT 1,
  is_enabled               TINYINT(1) NOT NULL DEFAULT 0,
  opening_hours            TEXT NULL,
  /* Granularity of the offered times, in minutes (15/30/60). */
  slot_minutes             INT UNSIGNED NOT NULL DEFAULT 30,
  default_duration_minutes INT UNSIGNED NOT NULL DEFAULT 90,
  lead_time_minutes        INT UNSIGNED NOT NULL DEFAULT 120,
  horizon_days             INT UNSIGNED NOT NULL DEFAULT 60,
  max_party_size           INT UNSIGNED NOT NULL DEFAULT 12,
  auto_confirm             TINYINT(1) NOT NULL DEFAULT 0,
  /* Shown above the public form: dress code, parking, "large groups please call". */
  blurb                    VARCHAR(500) NOT NULL DEFAULT '',
  /* Abuse control on a public, login-less form. 0 = no limit. */
  max_per_phone_per_day    INT UNSIGNED NOT NULL DEFAULT 3,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
