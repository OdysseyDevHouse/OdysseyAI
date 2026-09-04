-- ─────────────────────────────────────────────────────────────────────────
-- The member file, on databases that ran the OLD 052.
--
-- ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
--
-- 052_loyalty.sql was REWRITTEN IN PLACE when loyalty stopped being a facet of
-- a debtors account and became its own member file. Migrations are recorded BY
-- NAME, so every database that had already applied the old 052 kept the old
-- shape for ever, and editing the file changed nothing for them.
--
-- The two shapes disagree about the key of the whole cluster:
--
--   old   loyalty_members keyed on customer_id; ledger, wallet, stamps and
--         vouchers all carry customer_id
--   new   loyalty_members has its own id and member_number; everything else
--         carries member_id, and a member need not be a customer at all
--
-- The app was ported to the new shape, so on an old database the Loyalty screen
-- fails with "Unknown column member_id in SELECT" before it renders a row —
-- which is what this file was written to fix. scripts/reset-loyalty-schema.mjs
-- was the manual catch-up for the same drift; this is the one that travels with
-- the build, so an install nobody runs a script against is not left broken.
--
-- ── WHY IT DROPS RATHER THAN ALTERS ──────────────────────────────────────
--
-- Every table in the cluster changes: its primary key, its foreign keys, its
-- unique keys, and in the punch-card tables its columns too (product_id became
-- product_code, because programme configuration travels between stores and an
-- id does not). An ALTER path would be a page of guarded statements that no
-- database in existence has ever exercised, standing between every future
-- install and its schema.
--
-- So the old cluster is dropped and rebuilt in the new shape — but ONLY when it
-- is EMPTY. If any of it holds a row, this migration REFUSES: points are money
-- and nothing here is entitled to decide that a balance can be thrown away.
-- Recovering that case is a conversation with whoever holds the data, not a
-- silent DELETE. Every installation at the time of writing was empty, so the
-- refusal is a guard, not a workflow.
--
-- loyalty_tiers is deliberately NOT dropped: the two shapes define it
-- identically, and it is the one table a store customarily edits (renaming the
-- ladder, retuning its thresholds). Keeping it means the rebuild costs a store
-- nothing it had set up.
--
-- ── AND ON A DATABASE THAT NEVER SAW THE OLD 052 ─────────────────────────
--
-- Nothing. The guard reads information_schema, finds loyalty_members already
-- has an id, and every DROP below is skipped; the CREATE statements are all
-- IF NOT EXISTS and match what 052 already created, so they are no-ops. A fresh
-- install applies 052 and then this file without a single table changing.
--
-- The CREATE blocks are copied from 052 verbatim, minus its prose, so the two
-- can be diffed. 052 remains the place to read WHY each column exists.
--
-- NOTE: no apostrophes in comments in this file. The runner sends it as one
-- multipleStatements batch, and MariaDB reads a lone apostrophe inside a --
-- comment as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Is this database still on the customer-keyed shape? ──────────────────
--
-- "loyalty_members exists and has no id column" is the cheapest fact that
-- separates the two, and it cannot be true of a database that ran the new 052.
SET @has_members := (
  SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_members');

SET @has_member_id := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_members'
     AND COLUMN_NAME = 'id');

SET @old_shape := (@has_members = 1 AND @has_member_id = 0);

-- ── Does the old cluster hold anything? ──────────────────────────────────
--
-- Counted through dynamic SQL because the tables being counted may not exist:
-- a site that ran the old 052 and lost its ledger to a half-finished manual fix
-- is exactly the state this migration has to survive. Tiers are excluded — they
-- are kept, not dropped, so their rows are not at risk.
SET @rows := 0;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_members') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_members) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_ledger') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_ledger) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_wallet') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_wallet) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_cards') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_cards) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_card_items') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_card_items) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_stamps') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_stamps) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape AND (SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'loyalty_vouchers') = 1,
  'SELECT @rows + (SELECT COUNT(*) FROM loyalty_vouchers) INTO @rows', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Stop here rather than destroy a balance. The message is what a technician
-- reads out of the failed migration, so it says what to do next.
SET @sql := IF(@old_shape AND @rows > 0,
  CONCAT('SIGNAL SQLSTATE ''45000'' SET MESSAGE_TEXT = ''245_loyalty_member_file: ',
         'this database is on the old customer-keyed loyalty schema and holds ',
         @rows, ' row(s). Converting it would discard member balances, so it has ',
         'been left alone. Export the loyalty tables and ask for a data-preserving ',
         'conversion before applying this migration.'''),
  'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── Out with the old ─────────────────────────────────────────────────────
--
-- Children first: every foreign key inside the cluster points at members or
-- cards, and vouchers are pointed at by stamps.
SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_stamps', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_card_items', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_vouchers', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_ledger', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_wallet', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_cards', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@old_shape, 'DROP TABLE IF EXISTS loyalty_members', 'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ── In with the member file ──────────────────────────────────────────────
--
-- Verbatim from 052, which is where the reasoning for each column lives.
CREATE TABLE IF NOT EXISTS loyalty_members (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  member_number    VARCHAR(60) NOT NULL,

  customer_id      INT UNSIGNED NULL,
  customer_origin_site_id INT UNSIGNED NULL,

  name             VARCHAR(160) NOT NULL,
  phone            VARCHAR(40) NULL,
  email            VARCHAR(190) NULL,

  is_active        TINYINT(1) NOT NULL DEFAULT 1,

  points_balance   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  wallet_balance   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  tier_id          INT UNSIGNED NULL,
  tier_since       DATETIME NULL,
  tier_review_date DATE NULL,

  joined_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_activity_at DATETIME NULL,

  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_member_number (member_number),
  UNIQUE KEY uq_member_customer (customer_origin_site_id, customer_id),
  KEY idx_member_tier (tier_id),
  KEY idx_member_phone (phone),
  KEY idx_member_activity (last_activity_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Only for a database that lost it. Both shapes define tiers identically, so
-- this never fires on a site that has one — and its ladder is not re-seeded
-- here, because 052 already did that and a store is free to have emptied it.
CREATE TABLE IF NOT EXISTS loyalty_tiers (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name             VARCHAR(40) NOT NULL,
  step             SMALLINT UNSIGNED NOT NULL,

  qualifying_spend DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  multiplier       DECIMAL(6,3) NOT NULL DEFAULT 1.000,
  discount_pct     DECIMAL(6,3) NOT NULL DEFAULT 0.000,

  color            VARCHAR(40) NOT NULL DEFAULT '',

  is_active        TINYINT(1) NOT NULL DEFAULT 1,

  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_tier_name (name),
  UNIQUE KEY uq_tier_step (step)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  member_id      INT UNSIGNED NOT NULL,

  entry_type     ENUM('earn','redeem','expire','adjust','reverse') NOT NULL,

  points         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  basis_amount   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  document_id    INT UNSIGNED NULL,
  origin_site_id INT UNSIGNED NULL,
  document_number VARCHAR(40) NOT NULL DEFAULT '',

  tier_name      VARCHAR(40) NOT NULL DEFAULT '',
  multiplier     DECIMAL(6,3) NOT NULL DEFAULT 1.000,

  note           VARCHAR(255) NOT NULL DEFAULT '',

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_ledger_member (member_id, created_at),
  KEY idx_ledger_document (origin_site_id, document_id),
  KEY idx_ledger_type_date (entry_type, created_at),

  UNIQUE KEY uq_ledger_document_earn (origin_site_id, document_id, entry_type),

  CONSTRAINT fk_loyalty_ledger_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_wallet (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  member_id      INT UNSIGNED NOT NULL,

  entry_type     ENUM('topup','spend','refund','adjust') NOT NULL,

  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  tender_type_id INT UNSIGNED NULL,
  shift_id       INT UNSIGNED NULL,
  terminal_id    INT UNSIGNED NULL,

  document_id    INT UNSIGNED NULL,
  origin_site_id INT UNSIGNED NULL,
  document_number VARCHAR(40) NOT NULL DEFAULT '',

  note           VARCHAR(255) NOT NULL DEFAULT '',

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_wallet_member (member_id, created_at),
  KEY idx_wallet_document (origin_site_id, document_id),
  KEY idx_wallet_shift (origin_site_id, shift_id, entry_type),
  KEY idx_wallet_type_date (entry_type, created_at),

  UNIQUE KEY uq_wallet_document_spend (origin_site_id, document_id, entry_type),

  CONSTRAINT fk_loyalty_wallet_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_cards (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name               VARCHAR(100) NOT NULL,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,

  required_stamps    SMALLINT UNSIGNED NOT NULL DEFAULT 10,

  reward_type        ENUM('free_item','value','points') NOT NULL DEFAULT 'free_item',
  reward_product_code VARCHAR(32) NULL,
  reward_value       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  one_stamp_per_sale TINYINT(1) NOT NULL DEFAULT 1,
  min_line_amount    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  voucher_valid_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  starts_on          DATE NULL,
  ends_on            DATE NULL,

  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_card_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_card_items (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  card_id         INT UNSIGNED NOT NULL,

  product_code    VARCHAR(32) NULL,
  department_name VARCHAR(120) NULL,

  PRIMARY KEY (id),
  KEY idx_card_item_card (card_id),
  UNIQUE KEY uq_card_product (card_id, product_code),
  UNIQUE KEY uq_card_department (card_id, department_name),

  CONSTRAINT fk_card_item_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE CASCADE,

  CONSTRAINT ck_card_item_target CHECK (
    (product_code IS NOT NULL AND department_name IS NULL) OR
    (product_code IS NULL AND department_name IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_stamps (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  card_id       INT UNSIGNED NOT NULL,
  member_id     INT UNSIGNED NOT NULL,

  document_id   INT UNSIGNED NULL,
  origin_site_id INT UNSIGNED NULL,
  stamp_seq     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  product_code  VARCHAR(32) NULL,

  completed     TINYINT(1) NOT NULL DEFAULT 0,
  voucher_id    BIGINT UNSIGNED NULL,

  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_stamp_member_card (member_id, card_id, created_at),
  KEY idx_stamp_document (origin_site_id, document_id),

  UNIQUE KEY uq_stamp_sale (card_id, origin_site_id, member_id, document_id, stamp_seq),

  CONSTRAINT fk_stamp_card FOREIGN KEY (card_id)
    REFERENCES loyalty_cards (id) ON DELETE CASCADE,
  CONSTRAINT fk_stamp_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS loyalty_vouchers (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  code              VARCHAR(30) NOT NULL,

  member_id         INT UNSIGNED NULL,

  reward_type       ENUM('free_item','value') NOT NULL DEFAULT 'value',
  reward_product_code VARCHAR(32) NULL,
  reward_value      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  description       VARCHAR(150) NOT NULL DEFAULT '',

  status            ENUM('issued','redeemed','expired','void') NOT NULL DEFAULT 'issued',

  issued_by         ENUM('card','manual','birthday','tier') NOT NULL DEFAULT 'manual',
  card_id           INT UNSIGNED NULL,

  expires_on        DATE NULL,

  redeemed_at       DATETIME(3) NULL,
  redeemed_doc_id   INT UNSIGNED NULL,
  redeemed_site_id  INT UNSIGNED NULL,
  redeemed_doc_number VARCHAR(40) NOT NULL DEFAULT '',

  user_id           INT UNSIGNED NULL,
  user_name         VARCHAR(120) NOT NULL DEFAULT '',

  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_voucher_code (code),
  KEY idx_voucher_member (member_id, status),
  KEY idx_voucher_status_expiry (status, expires_on),
  KEY idx_voucher_document (redeemed_site_id, redeemed_doc_id),

  CONSTRAINT fk_voucher_member FOREIGN KEY (member_id)
    REFERENCES loyalty_members (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The loyalty tenders stop requiring a customer ────────────────────────
--
-- The old 052 inserted both with requires_customer = 1, which was true while a
-- member WAS a customer. Left alone, the till would refuse to let a walk-in
-- member spend the points they had just earned — the exact case the member file
-- exists to serve. The new 052 inserts 0; this brings the databases that got
-- the old row into line.
--
-- Scoped to integration_key = 'loyalty', so it touches only the two rows 052
-- created and nothing a store added itself. Harmless where they already say 0.
UPDATE tender_types SET requires_customer = 0 WHERE integration_key = 'loyalty';
