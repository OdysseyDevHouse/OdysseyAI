-- Table reservations — a booking is a promise about a future seat.
--
-- RECONSTRUCTED 2026-08-11. Recorded as applied in ody10000_master on
-- 2026-08-10 with no committed file. Shapes taken verbatim from
-- SHOW CREATE TABLE on the live database; the comments below are inference.
-- No code in src/ touches either table today - see the note in
-- 093_supplier_price_lists.sql.
--
-- It is NOT a sale, and nothing here writes to sales_documents. An online order
-- resolves into a draft sale through saveDraft() because an order IS a
-- transaction — a basket, at a price, that finalises at the till. A booking has
-- no lines, no value and no stock movement. Forcing one through invoicing would
-- put empty draft sales into every sales report and into cash-up, for parties
-- that may never arrive.
--
-- The join key is table_name, deliberately matched by name against the floor plan.
-- See the original migration notes for fuller reasoning; the incoming branch's
-- expanded commentary has been preserved here.

-- The booking itself.
CREATE TABLE IF NOT EXISTS reservations (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  /* Shown to the guest and quoted over the phone. RS000123. */
  reference        VARCHAR(20) NOT NULL DEFAULT '',
  status           ENUM('pending', 'confirmed', 'seated', 'completed', 'no_show', 'cancelled')
                     NOT NULL DEFAULT 'pending',
  source           ENUM('online', 'phone', 'walk_in') NOT NULL DEFAULT 'online',
  contact_name     VARCHAR(120) NOT NULL DEFAULT '',
  contact_phone    VARCHAR(50) NOT NULL DEFAULT '',
  contact_email    VARCHAR(190) NOT NULL DEFAULT '',
  party_size       INT UNSIGNED NOT NULL DEFAULT 0,
  reserved_for     DATETIME NOT NULL,
  duration_minutes INT UNSIGNED NOT NULL DEFAULT 90,
  table_name       VARCHAR(50) NOT NULL DEFAULT '',
  customer_note    VARCHAR(500) NOT NULL DEFAULT '',
  cancel_reason    VARCHAR(255) NOT NULL DEFAULT '',
  seated_at        DATETIME NULL,
  document_id      INT UNSIGNED NULL,
  submitted_ip     VARCHAR(45) NOT NULL DEFAULT '',
  user_id          INT UNSIGNED NULL,
  user_name        VARCHAR(120) NOT NULL DEFAULT '',
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_reservation_reference (reference),
  KEY ix_resv_when (reserved_for, status),
  KEY ix_resv_status (status, reserved_for),
  KEY ix_resv_phone (contact_phone, created_at),
  KEY ix_resv_table (table_name, reserved_for),
  CONSTRAINT fk_resv_document FOREIGN KEY (document_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_resv_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reservation configuration — one row per site, id pinned to 1.
CREATE TABLE IF NOT EXISTS reservation_settings (
  id                       INT UNSIGNED NOT NULL DEFAULT 1,
  is_enabled               TINYINT(1) NOT NULL DEFAULT 0,
  opening_hours            TEXT NULL,
  slot_minutes             INT UNSIGNED NOT NULL DEFAULT 30,
  default_duration_minutes INT UNSIGNED NOT NULL DEFAULT 90,
  lead_time_minutes        INT UNSIGNED NOT NULL DEFAULT 120,
  horizon_days             INT UNSIGNED NOT NULL DEFAULT 60,
  max_party_size           INT UNSIGNED NOT NULL DEFAULT 12,
  auto_confirm             TINYINT(1) NOT NULL DEFAULT 0,
  blurb                    VARCHAR(500) NOT NULL DEFAULT '',
  max_per_phone_per_day    INT UNSIGNED NOT NULL DEFAULT 3,
  created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deliberately NOT seeded with row 1 to match the live master database state.

