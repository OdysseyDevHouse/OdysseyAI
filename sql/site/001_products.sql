-- OdysseyAI site database — products and their supporting tables.
--
-- This database belongs to ONE site, so nothing here carries a site_id; the
-- connection itself is the tenancy boundary (see cp2_site_databases).
--
-- Money is DECIMAL(12,4): four places so a unit cost survives division (a case
-- of 24 at 199.99 is 8.3329 each) without the drift a float would introduce.
-- Quantities are DECIMAL(12,3) so weighed goods work.

-- ── Departments ────────────────────────────────────────────────────────
-- An arbitrary-depth tree rather than fixed Major/Sub1/Sub2 columns, so a
-- fourth level never needs a schema change. The UI walks it as cascading
-- selects; depth is whatever the data has.
CREATE TABLE departments (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  parent_id  INT UNSIGNED NULL,
  name       VARCHAR(120) NOT NULL,
  code       VARCHAR(32)  NULL,
  color      VARCHAR(9)   NULL,          -- #RRGGBB for tiles and reports
  sort_order INT          NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_dept_parent (parent_id, sort_order),
  -- RESTRICT, not CASCADE: deleting a parent must not silently delete a whole
  -- branch of departments that products still point at.
  CONSTRAINT fk_dept_parent FOREIGN KEY (parent_id) REFERENCES departments (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE brands (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name       VARCHAR(120) NOT NULL,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_brand_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── VAT ────────────────────────────────────────────────────────────────
-- Split by type: a product carries one rate for what you pay a supplier and a
-- separate one for what you charge a customer. They are not always the same.
CREATE TABLE vat_rates (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  vat_type   ENUM('sales','purchase') NOT NULL,
  code       VARCHAR(16)  NOT NULL,
  name       VARCHAR(60)  NOT NULL,
  rate       DECIMAL(6,3) NOT NULL DEFAULT 0.000,   -- percent, e.g. 15.000
  is_default TINYINT(1)   NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_vat_type_code (vat_type, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Price structures ───────────────────────────────────────────────────
-- Retail, Wholesale, Online, … Each product may hold one selling price per
-- structure; `position` is the display order and the stable external handle.
CREATE TABLE price_structures (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  position   INT          NOT NULL,
  name       VARCHAR(60)  NOT NULL,
  is_default TINYINT(1)   NOT NULL DEFAULT 0,
  is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_price_position (position),
  UNIQUE KEY uq_price_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Products ───────────────────────────────────────────────────────────
CREATE TABLE products (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                 VARCHAR(48)  NOT NULL,
  barcode              VARCHAR(64)  NULL,
  description          VARCHAR(190) NOT NULL,
  -- Rich text from the editor, stored as sanitised HTML.
  extra_description    MEDIUMTEXT   NULL,
  product_type         VARCHAR(30)  NOT NULL DEFAULT 'normal',

  department_id        INT UNSIGNED NULL,
  brand_id             INT UNSIGNED NULL,

  -- Image is one of: an uploaded file, a named icon, or a plain colour tile.
  image_path           VARCHAR(255) NULL,
  image_icon           VARCHAR(64)  NULL,
  image_color          VARCHAR(9)   NULL,

  purchase_vat_rate_id INT UNSIGNED NULL,
  selling_vat_rate_id  INT UNSIGNED NULL,

  -- Both held EXCLUSIVE of VAT. Inclusive cost, markup, GP and exclusive
  -- selling price are all derived at read time from these plus the VAT rate —
  -- storing them too would let the copies drift apart.
  last_cost            DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  average_cost         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  stock_on_hand        DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  min_stock            DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  max_stock            DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- Archived products stay queryable for history; they are hidden from normal
  -- operations rather than deleted.
  is_archived          TINYINT(1)   NOT NULL DEFAULT 0,

  -- last_edit_date is when a PERSON last saved the product. Distinct from
  -- updated_at, which any write touches — including a stock movement, which is
  -- not an edit anyone made.
  last_edit_date       DATETIME     NULL,
  last_purchase_date   DATETIME     NULL,
  last_sold_date       DATETIME     NULL,
  last_adjust_date     DATETIME     NULL,

  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_product_code (code),
  KEY ix_product_barcode (barcode),
  KEY ix_product_description (description),
  KEY ix_product_department (department_id),
  KEY ix_product_brand (brand_id),
  -- The product list filters on archived state constantly.
  KEY ix_product_archived (is_archived, description),
  CONSTRAINT fk_product_dept    FOREIGN KEY (department_id)        REFERENCES departments (id)  ON DELETE SET NULL,
  CONSTRAINT fk_product_brand   FOREIGN KEY (brand_id)             REFERENCES brands (id)       ON DELETE SET NULL,
  CONSTRAINT fk_product_vat_buy FOREIGN KEY (purchase_vat_rate_id) REFERENCES vat_rates (id)    ON DELETE SET NULL,
  CONSTRAINT fk_product_vat_sel FOREIGN KEY (selling_vat_rate_id)  REFERENCES vat_rates (id)    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One selling price per structure, held INCLUSIVE of VAT — that is the figure
-- on the shelf and at the till, so it must be exact rather than reconstructed.
CREATE TABLE product_prices (
  product_id         INT UNSIGNED NOT NULL,
  price_structure_id INT UNSIGNED NOT NULL,
  selling_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, price_structure_id),
  KEY ix_pp_structure (price_structure_id),
  CONSTRAINT fk_pp_product   FOREIGN KEY (product_id)         REFERENCES products (id)         ON DELETE CASCADE,
  CONSTRAINT fk_pp_structure FOREIGN KEY (price_structure_id) REFERENCES price_structures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ───────────────────────────────────────────────────────────
CREATE TABLE settings (
  setting_key   VARCHAR(60)  NOT NULL,
  setting_value VARCHAR(255) NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed ───────────────────────────────────────────────────────────────
INSERT INTO vat_rates (vat_type, code, name, rate, is_default) VALUES
  ('sales',    'STD',  'Standard rate', 15.000, 1),
  ('sales',    'ZERO', 'Zero rated',     0.000, 0),
  ('purchase', 'STD',  'Standard rate', 15.000, 1),
  ('purchase', 'ZERO', 'Zero rated',     0.000, 0);

INSERT INTO price_structures (position, name, is_default) VALUES
  (1, 'Retail', 1);

-- Which cost figure drives margin and valuation. 'average' or 'last'.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('cost_basis', 'average');
