-- Table bookings.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file. Shapes taken verbatim from
-- SHOW CREATE TABLE on the live database; the comments below are inference.
-- No code in src/ touches either table today - see the note in
-- 093_supplier_price_lists.sql.

-- ── The booking ──────────────────────────────────────────────────────────
-- A reservation is a promise about a future table, so it exists long before
-- there is a sale to attach it to. document_id is therefore nullable and gets
-- filled when the party is seated and a bill is opened - that link is what
-- turns "we held a table" into "and here is what they spent".
CREATE TABLE IF NOT EXISTS reservations (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The short code read out over the phone. Unique so it can be searched on.
  reference        VARCHAR(20) NOT NULL DEFAULT '',

  -- The whole life of a booking. no_show and cancelled are kept apart because
  -- they mean different things to the shop: one is a customer who did not
  -- arrive, the other is a table given back in time to resell.
  status           ENUM('pending','confirmed','seated','completed','no_show','cancelled')
                     NOT NULL DEFAULT 'pending',
  source           ENUM('online','phone','walk_in') NOT NULL DEFAULT 'online',

  contact_name     VARCHAR(120) NOT NULL DEFAULT '',
  contact_phone    VARCHAR(50)  NOT NULL DEFAULT '',
  contact_email    VARCHAR(190) NOT NULL DEFAULT '',
  party_size       INT UNSIGNED NOT NULL DEFAULT 0,

  -- When the table is wanted, and for how long. Duration is stored per booking
  -- rather than read from settings so that changing the default later cannot
  -- silently move every table already on the book.
  reserved_for     DATETIME NOT NULL,
  duration_minutes INT UNSIGNED NOT NULL DEFAULT 90,

  -- Free text, not a foreign key to the floor plan: a booking can name a table
  -- that is later renamed or removed without the booking becoming unreadable.
  table_name       VARCHAR(50) NOT NULL DEFAULT '',

  customer_note    VARCHAR(500) NOT NULL DEFAULT '',
  cancel_reason    VARCHAR(255) NOT NULL DEFAULT '',
  seated_at        DATETIME NULL,

  -- The bill, once there is one.
  document_id      INT UNSIGNED NULL,

  -- Kept for the online form, so abuse can be traced back.
  submitted_ip     VARCHAR(45) NOT NULL DEFAULT '',

  -- Who took or last handled it, name held alongside so it survives the user.
  user_id          INT UNSIGNED NULL,
  user_name        VARCHAR(120) NOT NULL DEFAULT '',

  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_reservation_reference (reference),

  -- The book for a service, the queue of bookings needing attention, lookup by
  -- phone number at the door, and what is on a given table.
  KEY ix_resv_when (reserved_for, status),
  KEY ix_resv_status (status, reserved_for),
  KEY ix_resv_phone (contact_phone, created_at),
  KEY ix_resv_table (table_name, reserved_for),
  KEY fk_resv_document (document_id),
  KEY fk_resv_user (user_id),

  CONSTRAINT fk_resv_document FOREIGN KEY (document_id) REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_resv_user     FOREIGN KEY (user_id)     REFERENCES users (id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What the shop will accept ────────────────────────────────────────────
-- One row, id 1, on the same singleton pattern as online_store_settings.
CREATE TABLE IF NOT EXISTS reservation_settings (
  id                       INT UNSIGNED NOT NULL DEFAULT 1,

  -- The master switch. Off means the public booking form is not offered at all.
  is_enabled               TINYINT(1) NOT NULL DEFAULT 0,

  -- Serialised opening hours; a table of them would be a schema change every
  -- time a shop wants a split shift or a public holiday exception.
  opening_hours            TEXT NULL,

  -- How the day is cut up for the picker, and the default length of a sitting.
  slot_minutes             INT UNSIGNED NOT NULL DEFAULT 30,
  default_duration_minutes INT UNSIGNED NOT NULL DEFAULT 90,

  -- How far ahead a booking must be made, and how far ahead it may be made.
  lead_time_minutes        INT UNSIGNED NOT NULL DEFAULT 120,
  horizon_days             INT UNSIGNED NOT NULL DEFAULT 60,

  max_party_size           INT UNSIGNED NOT NULL DEFAULT 12,

  -- Whether a booking lands as confirmed or waits for someone to accept it.
  auto_confirm             TINYINT(1) NOT NULL DEFAULT 0,

  -- Shown above the form: parking, dress, corkage.
  blurb                    VARCHAR(500) NOT NULL DEFAULT '',

  -- Cheap abuse ceiling on a form with no login behind it.
  max_per_phone_per_day    INT UNSIGNED NOT NULL DEFAULT 3,

  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deliberately NOT seeded with row 1, unlike online_store_settings in
-- 034_online_store.sql. The table is empty on ody10000_master, where the
-- original of this migration did run, so seeding here would make a new site
-- diverge from master - which is the one thing this reconstruction exists to
-- prevent. Whatever code eventually reads these settings has to cope with the
-- row being absent in any case, because master is already in that state.
