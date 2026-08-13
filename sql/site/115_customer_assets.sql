-- ============================================================================
-- 115 — CUSTOMER ASSETS: THE THING THE WORK IS DONE ON
--
-- A customer asset is equipment the CUSTOMER owns and we service: an air
-- conditioner, a pump, a compressor, a medical machine, a vehicle.
--
-- WHY THIS IS NOT fixed_assets
--
-- 046_fixed_assets.sql is a DEPRECIATION REGISTER. It carries
-- depreciation_method and residual_value, and it has depreciation_runs beside
-- it, because it exists to write down things the BUSINESS owns. A customer air
-- conditioner is neither owned by us nor depreciated by us, and putting one in
-- that table would place customer equipment on our balance sheet.
--
-- Saying so here so nobody reaches for it later. The two tables answer opposite
-- questions: what do we own and must write down, versus what do we look after
-- for somebody else.
--
-- WHY A SERIAL IS NOT AN ASSET EITHER
--
-- product_serials tracks a unit WE bought or sold, and already carries
-- customer_id and warranty_until so the counter can answer who bought it. An
-- asset may never have passed through this business at all: a plumber servicing
-- a geyser fitted by somebody else in 2011 still needs a record of it.
--
-- So product_id and serial_id are NULLABLE, and there is a separate
-- serial_text for what is stamped on the plate. Requiring serial_id would mean
-- inventing a fake product and a fake serial for every third-party unit, and
-- that fake serial would then count toward serial invariant S1.
--
-- WHY THE CUSTOMER IS NULLABLE TOO
--
-- Section 52 Q8 of the PRD describes a staged life: an asset can be created
-- against a branch, later linked to a customer, later still to one of their
-- sites. That is a real workflow — a unit received into the workshop before
-- anybody claims it, or equipment noted while surveying a prospect.
--
-- The cost, stated plainly: every query that assumes an owner needs a NULL
-- branch. Accepted, because the alternative is refusing to record equipment
-- that is physically in the workshop.
--
-- SERVICE HISTORY IS A QUERY, NOT A TABLE
--
-- job_cards gains asset_id. What has been done to this asset is
-- `SELECT ... FROM job_cards WHERE asset_id = ?`. A history table would be a
-- second copy of what the job list already knows, and the two would drift the
-- first time a job was cancelled.
-- ============================================================================

-- ── What kind of thing it is ────────────────────────────────────────────────
--
-- Its own table rather than free text so the list can be filtered and the
-- service interval defaulted per kind. Seeded with nothing: the trades this
-- serves have nothing in common, and guessing at categories for a plumber and a
-- medical-equipment technician at once produces a list neither uses.
CREATE TABLE IF NOT EXISTS asset_types (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code              VARCHAR(40)  NOT NULL,
  name              VARCHAR(120) NOT NULL,

  -- How often equipment of this kind wants servicing, in months. Feeds
  -- next_service_on when a job closes; NULL means it is serviced on demand.
  service_months    SMALLINT UNSIGNED NULL,

  -- The label this trade uses for the identifying number. A vehicle has a VIN, a
  -- machine has a serial, a meter has an asset tag. The PRD asks for the asset
  -- field label to be customisable and this is the field that matters.
  identifier_label  VARCHAR(40)  NOT NULL DEFAULT 'Serial number',

  sort_order        INT          NOT NULL DEFAULT 0,
  is_active         TINYINT(1)   NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_asset_type_code (code),
  KEY ix_asset_type_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The asset ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_assets (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Our own handle, so a unit with no legible plate can still be referred to.
  -- Allocated from the AST sequence at creation, like every other document.
  asset_code         VARCHAR(32)  NULL,

  asset_type_id      INT UNSIGNED NULL,

  -- Both nullable. See the header: an asset can exist before anybody owns it.
  customer_id        INT UNSIGNED NULL,
  service_address_id INT UNSIGNED NULL,

  -- ── What it is ──────────────────────────────────────────────────────────
  description        VARCHAR(190) NOT NULL,
  make               VARCHAR(120) NULL,
  model              VARCHAR(120) NULL,

  -- What is stamped on the plate, as typed. Kept even when serial_id is set,
  -- because the plate and our record can legitimately differ and the plate is
  -- what a technician standing in front of it will read.
  serial_text        VARCHAR(64)  NULL,

  /*
   * Normalised for comparison: upper-cased with spaces and hyphens stripped.
   * A GENERATED column rather than something the code maintains, so it cannot
   * drift and the duplicate check is one indexed read.
   *
   * The PRD asks for exactly this — ignore accidental spacing and case while
   * preserving what was typed for display.
   */
  serial_key         VARCHAR(64)
    GENERATED ALWAYS AS (UPPER(REPLACE(REPLACE(COALESCE(serial_text,''), ' ', ''), '-', ''))) STORED,

  -- Only set when WE sold the unit. See the header on why both are nullable.
  product_id         INT UNSIGNED NULL,
  serial_id          INT UNSIGNED NULL,

  -- ── Its life ────────────────────────────────────────────────────────────
  installed_on       DATE         NULL,
  purchased_on       DATE         NULL,
  purchase_reference VARCHAR(60)  NULL,

  -- Warranty on the ASSET, which is not always the serial's manufacturer
  -- warranty: an installation can carry its own workmanship guarantee, and a
  -- second-hand unit can be sold with a shorter one than it shipped with.
  warranty_until     DATE         NULL,

  last_service_on    DATE         NULL,
  next_service_on    DATE         NULL,

  condition_note     VARCHAR(190) NULL,
  note               TEXT         NULL,

  /*
   * retired, not deleted. A scrapped unit keeps its history: the jobs done on it
   * are real and reference it, and the FK below is RESTRICT for that reason.
   */
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  retired_on         DATE         NULL,
  retired_reason     VARCHAR(190) NULL,

  user_id            INT UNSIGNED NULL,
  user_name          VARCHAR(120) NULL,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_asset_code (asset_code),

  -- The duplicate check: same normalised serial under the same customer. NOT
  -- globally unique, because two customers can each own a unit whose plate reads
  -- 001, and because serial_text is nullable for equipment with no plate at all.
  KEY ix_asset_serial (serial_key, customer_id),
  KEY ix_asset_customer (customer_id, is_active),
  KEY ix_asset_address (service_address_id),
  -- The due-a-service worklist.
  KEY ix_asset_due (is_active, next_service_on),

  -- RESTRICT on the customer: deleting an account must not silently orphan the
  -- equipment we service for them. The customer screen already refuses a delete
  -- that has documents behind it.
  CONSTRAINT fk_asset_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE RESTRICT,
  -- SET NULL on the address: a site can be closed while the equipment moves.
  CONSTRAINT fk_asset_address FOREIGN KEY (service_address_id)
    REFERENCES service_addresses (id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_type FOREIGN KEY (asset_type_id)
    REFERENCES asset_types (id) ON DELETE SET NULL,
  CONSTRAINT fk_asset_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE SET NULL,
  -- SET NULL: a written-off serial row must not take the asset with it. The
  -- asset is still on somebody wall.
  CONSTRAINT fk_asset_serial FOREIGN KEY (serial_id)
    REFERENCES product_serials (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Which asset a job is about ──────────────────────────────────────────────
--
-- ONE per job, deliberately, where headlines are many.
--
-- A job is a visit to fix a thing. Servicing eight units at one site is eight
-- jobs or one job with eight line items, and both are already expressible;
-- making asset_id a join table would mean every cost, every check and every
-- warranty question needed to say WHICH asset it belonged to, and the PRD wants
-- exactly that only for the multi-asset case it describes in section 18.4.
-- Starting with one keeps every figure unambiguous, and a join table can be
-- added later without moving the ones already recorded.
ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS asset_id INT UNSIGNED NULL AFTER service_address_id;

ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_jcard_asset (asset_id, reported_at);

-- RESTRICT: an asset named by a job cannot be deleted, because the job is the
-- record of what was done to it. Retiring is the offered alternative.
ALTER TABLE job_cards
  ADD FOREIGN KEY IF NOT EXISTS fk_jcard_asset (asset_id)
  REFERENCES customer_assets (id) ON DELETE RESTRICT;

-- ── Numbering ───────────────────────────────────────────────────────────────
--
-- INSERT IGNORE so a re-run cannot reset a live counter. The unique key here is
-- doc_type, which is NOT NULL, so IGNORE genuinely dedupes.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('customer_asset', 'AST', 1, 6, 'none');

-- ── Settings ────────────────────────────────────────────────────────────────

-- Warn or block when a serial matches equipment already on file for the same
-- customer. WARN by default: section 18.3 of the PRD is explicit that plenty of
-- equipment has no legible serial, and a hard block would stop somebody
-- recording a real second unit whose plate happens to match.
INSERT INTO settings (setting_key, setting_value)
VALUES ('asset_duplicate_action', 'warn')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- Roll next_service_on forward by the type interval when a job closes against
-- the asset. On by default: an interval nobody acts on is decoration, and this
-- is the one thing that turns a service interval into a worklist.
INSERT INTO settings (setting_key, setting_value)
VALUES ('asset_auto_next_service', '1')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
