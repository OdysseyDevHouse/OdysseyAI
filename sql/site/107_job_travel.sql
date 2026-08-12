-- ─────────────────────────────────────────────────────────────────────────
-- Travel: how far somebody went, and how much of it the customer pays for.
--
-- ── FOUR FIGURES, AND WHY NONE OF THEM DERIVES THE OTHERS ────────────────
--
-- The PRD sets this out as a worked example and it is worth restating, because
-- the temptation is to store one number and compute the rest:
--
--   Recorded:   29.1 km   what the technician claims
--   Expected:   27.4 km   what the trip should have been
--   Verified:   29.1 km   what somebody accepted
--   Chargeable: 29 km     what goes on the invoice, after rounding
--
-- Each comes from a DIFFERENT SOURCE and none can be worked out from another:
--
--   expected    arithmetic on two sets of coordinates. Available BEFORE the trip.
--   recorded    a person, or an odometer. Available only after.
--   verified    a manager accepted a figure. NULL means nobody has looked yet,
--               which is a real and important third state — see below.
--   chargeable  the verified or recorded figure after a rounding rule, and the
--               rounding rule is a SETTING that changes.
--
-- Collapsing any pair loses the question the pair exists to answer. If verified
-- defaulted to recorded, "has anybody checked this" becomes unanswerable, and the
-- approval worklist has nothing to select on.
--
-- ── WHY chargeable IS STORED AND NOT COMPUTED ────────────────────────────
--
-- The same reason 015 stores document totals rather than deriving them: a trip
-- invoiced last March must keep the figure it was invoiced at. Rounding to the
-- nearest 5km is a setting, and a business that changes it next year must not
-- silently restate what it has already billed.
--
-- ── AND WHY EXPECTED IS ESTIMATED, NOT MEASURED ──────────────────────────
--
-- Nothing in this app talks to a distance provider. `expected_km` is a
-- straight-line haversine between two stored coordinate pairs multiplied by a
-- road factor — good enough to catch a 60km claim on a 12km trip, which is the
-- thing this column exists for, and NOT good enough to argue over 2km.
--
-- So `expected_source` says which it was. Labelling an estimate as a measurement
-- is how a technician gets accused of padding a claim by an arithmetic artefact,
-- and the column is what stops the interface implying more precision than it has.
--
-- ── LOCATION STAMPS, NOT TRACKING ────────────────────────────────────────
--
-- The PRD asks for continuous GPS tracking with geofencing. That was argued out:
-- POPIA makes continuous location special-category processing, consent obtained
-- from an employee as a condition of employment is weak consent, and practically
-- it is the fastest way to make technicians route around the app.
--
-- What is here instead is a stamp at the two moments somebody presses a button —
-- departing and arriving. It answers the question the business actually has ("was
-- he really there") with a consent story defensible in one sentence, no background
-- service, and a retention rule that is one column and a cron away.
--
-- 106 already stamps arrived_at on the appointment. These columns hold WHERE,
-- and only when the device offered it.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_card_travel (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_card_id       INT UNSIGNED NOT NULL,

  -- Which visit this trip belongs to. Nullable: a trip to fetch a part is real
  -- travel on the job that belongs to no appointment.
  appointment_id    INT UNSIGNED NULL,

  -- Who drove. cp2_users.id from the CONTROL database, so no FK is possible; the
  -- name is snapshotted for the same reason every other document snapshots it.
  user_id           INT UNSIGNED NOT NULL,
  user_name         VARCHAR(120) NOT NULL DEFAULT '',

  travelled_on      DATE NOT NULL,

  -- Where from and to, as text. Snapshotted rather than joined: an address that
  -- is later corrected must not restate what a trip said at the time, and a leg
  -- often starts somewhere that is not a record at all (home, a supplier).
  from_label        VARCHAR(190) NULL,
  to_label          VARCHAR(190) NULL,
  -- The service address, when the trip went to one. SET NULL so retiring an
  -- address does not block deleting it.
  service_address_id INT UNSIGNED NULL,

  -- ── The four figures ───────────────────────────────────────────────────
  -- DECIMAL(8,2): up to 999999.99 km, which is more than any single trip, and two
  -- places because an odometer reads to a tenth and a claim is sometimes 12.35.
  expected_km       DECIMAL(8,2) NULL,
  --   estimated  straight-line haversine times a road factor. What this app does.
  --   provider   a real routing service. Nothing writes this yet.
  --   manual     somebody typed what the trip should be.
  --
  -- NULL alongside a NULL expected_km, so "no expectation" and "an expectation
  -- from an unknown source" cannot be confused.
  expected_source   ENUM('estimated','provider','manual') NULL,

  recorded_km       DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  --   manual    the technician typed it
  --   odometer  read off the vehicle
  --   gps       from a device
  recorded_source   ENUM('manual','odometer','gps') NOT NULL DEFAULT 'manual',
  -- is_return is added by 108. It belongs beside these two, but this file had
  -- already been applied when the need for it was found, and the runner records a
  -- migration BY NAME — editing an applied file changes nothing.

  -- NULL means NOBODY HAS LOOKED, and that is the point of the column. Defaulting
  -- it to recorded_km would make the approval worklist unbuildable: there would be
  -- no way to select the trips still waiting for a decision.
  verified_km       DECIMAL(8,2) NULL,
  verified_by_user_id INT UNSIGNED NULL,
  verified_by_name  VARCHAR(120) NULL,
  verified_at       DATETIME NULL,
  -- Why the verified figure differs from the claim, when it does. Required by
  -- code in that case: a manager quietly reducing somebody kilometres without a
  -- word is the thing that ends up in a dispute.
  verify_note       VARCHAR(190) NULL,

  -- What the invoice uses, after the rounding rule. Stored, see the header.
  chargeable_km     DECIMAL(8,2) NOT NULL DEFAULT 0.00,

  -- Snapshotted at capture, like every other rate in this schema: a rate increase
  -- next year must not restate a trip already billed.
  rate_per_km       DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  cost_per_km       DECIMAL(10,4) NOT NULL DEFAULT 0.0000,

  -- ── Time on the road ───────────────────────────────────────────────────
  -- Minutes, matching how an appointment stores its duration. Separate from the
  -- job timer: driving is not work on the job, and folding the two would make
  -- "how long did the repair take" unanswerable.
  travel_minutes    SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- ── Where they were, when they pressed the button ───────────────────────
  -- Only ever these two moments. See the header on why this is not tracking.
  -- 7 decimal places is roughly 1cm, far finer than any phone reports.
  departed_lat      DECIMAL(10,7) NULL,
  departed_lng      DECIMAL(10,7) NULL,
  arrived_lat       DECIMAL(10,7) NULL,
  arrived_lng       DECIMAL(10,7) NULL,
  -- Metres the device claimed. A 2km accuracy reading is not evidence of anything,
  -- and a geofence warning built on one would accuse somebody wrongly.
  arrived_accuracy_m SMALLINT UNSIGNED NULL,

  -- Set when the recorded figure is outside the allowed tolerance against
  -- expected. Stored rather than derived because the tolerance is a setting: a
  -- trip flagged last month must stay flagged even if the tolerance is widened,
  -- otherwise the approval history rewrites itself.
  tolerance_breached TINYINT(1) NOT NULL DEFAULT 0,

  note              VARCHAR(400) NULL,

  -- The job line this trip produced, so a trip and its money can be walked in
  -- both directions. Matches job_card_lines.travel_id from the other side.
  line_id           INT UNSIGNED NULL,

  user_created_id   INT UNSIGNED NULL,
  user_created_name VARCHAR(120) NOT NULL DEFAULT '',

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_jtravel_job (job_card_id, travelled_on),
  KEY ix_jtravel_appointment (appointment_id),
  -- The approval worklist: everything breaching tolerance that nobody has looked
  -- at. One indexed read, no state machine.
  KEY ix_jtravel_verify (tolerance_breached, verified_at),
  KEY ix_jtravel_user (user_id, travelled_on),
  CONSTRAINT fk_jtravel_job FOREIGN KEY (job_card_id) REFERENCES job_cards (id) ON DELETE CASCADE,
  -- SET NULL rather than CASCADE: deleting a mistaken appointment must not delete
  -- the record that somebody really drove somewhere.
  CONSTRAINT fk_jtravel_appointment FOREIGN KEY (appointment_id)
    REFERENCES job_card_appointments (id) ON DELETE SET NULL,
  CONSTRAINT fk_jtravel_address FOREIGN KEY (service_address_id)
    REFERENCES service_addresses (id) ON DELETE SET NULL,
  CONSTRAINT fk_jtravel_line FOREIGN KEY (line_id)
    REFERENCES job_card_lines (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Where a trip starts from ─────────────────────────────────────────────
-- Coordinates on the stock location, so expected_km has something to measure
-- from. A branch is where the van leaves in the morning.
--
-- Note the MariaDB form: `ADD COLUMN IF NOT EXISTS`, and for a foreign key
-- `ADD FOREIGN KEY IF NOT EXISTS <name>` — it does NOT accept
-- `ADD CONSTRAINT IF NOT EXISTS <name> FOREIGN KEY`.
ALTER TABLE stock_locations
  ADD COLUMN IF NOT EXISTS latitude  DECIMAL(10,7) NULL,
  ADD COLUMN IF NOT EXISTS longitude DECIMAL(10,7) NULL;

-- ── Settings ─────────────────────────────────────────────────────────────
-- What a kilometre is charged at, and what it costs. Both blank until somebody
-- sets them: a rate nobody has chosen must read as unset, not as R0.00 quietly
-- billing nothing for every trip.
--
-- job_travel_rate_per_km already exists from 104. This adds the cost side, which
-- is what makes travel appear in the job margin rather than only on the invoice.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_cost_per_km', '')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- How a claimed distance becomes a chargeable one.
--
--   none  charge exactly what was verified
--   1     nearest whole kilometre
--   5     nearest five, which is what most service businesses actually do
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_round_to', '1')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- A minimum per trip, so a 400m call-out does not bill 0km. Blank for none.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_minimum_km', '')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- How far past the expected distance a claim may go before it needs a signature,
-- as a percentage. 20 means a 30km expectation accepts up to 36km silently.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_tolerance_pct', '20')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Straight-line distance times this is the road estimate. 1.30 is the ordinary
-- ratio of road distance to crow-flight in a built-up area, and it is a setting
-- because a rural region is nearer 1.15 and a mountain pass considerably worse.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_travel_road_factor', '1.30')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
