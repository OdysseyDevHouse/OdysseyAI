-- OdysseyAI initial schema.
--
-- Tenancy model: ONE database, shared by every store. Each business row carries
-- a store_id and every query is scoped through lib/tenant.ts — there is no
-- per-store database routing. Unique keys are therefore composite on
-- (store_id, ...) rather than global, so two stores can both have a product
-- coded "MILK-1L" without collision.
--
-- Money is DECIMAL(12,4): four places so unit costs survive division (a case of
-- 24 at 199.99 is 8.3329 each) without float drift. Quantities are DECIMAL(12,3)
-- to allow weighed goods.

CREATE TABLE stores (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(32)  NOT NULL,
  name          VARCHAR(160) NOT NULL,
  trading_name  VARCHAR(160) NULL,
  email         VARCHAR(190) NULL,
  phone         VARCHAR(40)  NULL,
  address_line1 VARCHAR(160) NULL,
  address_line2 VARCHAR(160) NULL,
  city          VARCHAR(80)  NULL,
  postal_code   VARCHAR(20)  NULL,
  country       VARCHAR(80)  NOT NULL DEFAULT 'South Africa',
  vat_number    VARCHAR(40)  NULL,
  currency      CHAR(3)      NOT NULL DEFAULT 'ZAR',
  timezone      VARCHAR(64)  NOT NULL DEFAULT 'Africa/Johannesburg',
  status        ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stores_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Email is globally unique: login happens before we know the store, so the
-- address alone has to identify the account. Staff needing access to two stores
-- get two logins.
CREATE TABLE users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id      INT UNSIGNED NULL,        -- NULL = platform staff, sees all stores
  email         VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(120) NOT NULL,
  role          ENUM('platform_admin','owner','manager','clerk') NOT NULL DEFAULT 'clerk',
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY ix_users_store (store_id),
  CONSTRAINT fk_users_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE vat_rates (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id   INT UNSIGNED NOT NULL,
  code       VARCHAR(16)  NOT NULL,
  name       VARCHAR(80)  NOT NULL,
  rate       DECIMAL(6,3) NOT NULL DEFAULT 0.000,   -- percent, e.g. 15.000
  is_default TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vat_store_code (store_id, code),
  CONSTRAINT fk_vat_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE departments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id   INT UNSIGNED NOT NULL,
  parent_id  INT UNSIGNED NULL,
  code       VARCHAR(32)  NOT NULL,
  name       VARCHAR(120) NOT NULL,
  color      VARCHAR(9)   NULL,          -- #RRGGBB for tile/report tinting
  sort_order INT          NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_dept_store_code (store_id, code),
  KEY ix_dept_parent (parent_id),
  CONSTRAINT fk_dept_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE,
  CONSTRAINT fk_dept_parent FOREIGN KEY (parent_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE suppliers (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id           INT UNSIGNED NOT NULL,
  code               VARCHAR(32)  NOT NULL,
  name               VARCHAR(160) NOT NULL,
  contact_name       VARCHAR(120) NULL,
  email              VARCHAR(190) NULL,
  phone              VARCHAR(40)  NULL,
  address_line1      VARCHAR(160) NULL,
  address_line2      VARCHAR(160) NULL,
  city               VARCHAR(80)  NULL,
  postal_code        VARCHAR(20)  NULL,
  vat_number         VARCHAR(40)  NULL,
  account_number     VARCHAR(60)  NULL,
  payment_terms_days SMALLINT     NOT NULL DEFAULT 30,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  notes              TEXT         NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_store_code (store_id, code),
  KEY ix_supplier_store_name (store_id, name),
  CONSTRAINT fk_supplier_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id       INT UNSIGNED NOT NULL,
  code           VARCHAR(32)  NOT NULL,
  name           VARCHAR(160) NOT NULL,
  contact_name   VARCHAR(120) NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40)  NULL,
  address_line1  VARCHAR(160) NULL,
  address_line2  VARCHAR(160) NULL,
  city           VARCHAR(80)  NULL,
  postal_code    VARCHAR(20)  NULL,
  vat_number     VARCHAR(40)  NULL,
  loyalty_number VARCHAR(60)  NULL,
  credit_limit   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  balance        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,  -- positive = owes us
  on_hold        TINYINT(1)   NOT NULL DEFAULT 0,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  notes          TEXT         NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_store_code (store_id, code),
  KEY ix_customer_store_name (store_id, name),
  KEY ix_customer_store_loyalty (store_id, loyalty_number),
  CONSTRAINT fk_customer_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id       INT UNSIGNED NOT NULL,
  sku            VARCHAR(48)  NOT NULL,
  name           VARCHAR(190) NOT NULL,
  description    TEXT         NULL,
  department_id  INT UNSIGNED NULL,
  supplier_id    INT UNSIGNED NULL,
  vat_rate_id    INT UNSIGNED NULL,
  unit           VARCHAR(16)  NOT NULL DEFAULT 'each',
  cost_price     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,   -- excl. VAT
  selling_price  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,   -- incl. VAT
  track_stock    TINYINT(1)   NOT NULL DEFAULT 1,
  stock_on_hand  DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  reorder_level  DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  reorder_qty    DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_product_store_sku (store_id, sku),
  KEY ix_product_store_name (store_id, name),
  KEY ix_product_dept (department_id),
  KEY ix_product_supplier (supplier_id),
  -- Partial-stock reporting reads active + tracked rows constantly.
  KEY ix_product_store_active (store_id, is_active),
  CONSTRAINT fk_product_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE,
  CONSTRAINT fk_product_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_product_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL,
  CONSTRAINT fk_product_vat FOREIGN KEY (vat_rate_id) REFERENCES vat_rates (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A product can carry several scannable codes (singles, six-pack, case), each
-- with the quantity that code represents.
CREATE TABLE product_barcodes (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id   INT UNSIGNED NOT NULL,
  product_id INT UNSIGNED NOT NULL,
  barcode    VARCHAR(64)  NOT NULL,
  pack_size  DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  is_primary TINYINT(1)   NOT NULL DEFAULT 0,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_barcode_store_code (store_id, barcode),
  KEY ix_barcode_product (product_id),
  CONSTRAINT fk_barcode_store FOREIGN KEY (store_id) REFERENCES stores (id) ON DELETE CASCADE,
  CONSTRAINT fk_barcode_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only audit trail. entity/entity_id stay loose (no FK) so a log line
-- survives the record it describes being deleted.
CREATE TABLE activity_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  store_id   INT UNSIGNED NULL,
  user_id    INT UNSIGNED NULL,
  entity     VARCHAR(40)  NOT NULL,
  entity_id  INT UNSIGNED NULL,
  action     VARCHAR(40)  NOT NULL,
  detail     TEXT         NULL,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_log_store_created (store_id, created_at),
  KEY ix_log_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
