-- ─────────────────────────────────────────────────────────────────────────
-- Restores `products` and `product_prices` after they were dropped out from
-- under a live site.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────
--
-- On 2026-08-11 ody10000_master answered every query with
--
--     Table ody10000_master.products doesnt exist
--
-- while 32 foreign keys in other tables still named products(id) as their
-- parent. InnoDB only permits that combination if the drop ran under
-- foreign_key_checks = 0, so this was a deliberate drop with checks disabled
-- rather than a migration that failed halfway.
--
-- 001_products.sql was still recorded in schema_migrations, so the runner in
-- scripts/site-migrate.mjs reported "already up to date" and would never have
-- put the tables back. That is the whole reason this file exists as its own
-- migration instead of a hand-run repair: the recovery has to be part of the
-- ordered sequence every site walks, or the next database in this state is
-- diagnosed from scratch all over again.
--
-- ── WHY IT IS SAFE ON A HEALTHY SITE ─────────────────────────────────────
--
-- Every statement is guarded. On a site that still has its products the two
-- CREATEs are no-ops and the INSERT selects nothing, because the placeholder
-- query only returns ids that are referenced by a child row AND missing from
-- products - which under an enforced foreign key is the empty set.
--
-- ── THE SHAPE ────────────────────────────────────────────────────────────
--
-- Not a fresh design. This is 001_products.sql carried through every ALTER
-- that has since touched the table, so a restored site ends up byte-identical
-- to one that walked the sequence:
--
--   006  the properties, weight, pack and scale columns
--   007  drops order_size
--   008  adds dimensions, 009 replaces it with length_mm/width_mm/height_mm
--   028  drops min_stock and max_stock (levels moved to product_location_stock)
--   034  adds show_online and ix_product_show_online
--   068  widens image_color to VARCHAR(32) for gradient tokens
--   070  the variant parent/child columns, keys and fk_product_parent
--   083  adds is_manufactured
--
-- Any future ALTER on products belongs in its own migration as usual. This
-- file must NOT be edited to keep up - it is a snapshot of the shape as at
-- 098, and later migrations will carry a restored site forward from here
-- exactly as they carry every other site.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS products (
  id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code                 VARCHAR(48)  NOT NULL,
  barcode              VARCHAR(64)  NULL,
  description          VARCHAR(190) NOT NULL,
  -- Rich text from the editor, stored as sanitised HTML.
  extra_description    MEDIUMTEXT   NULL,
  product_type         VARCHAR(30)  NOT NULL DEFAULT 'normal',
  is_manufactured      TINYINT(1)   NOT NULL DEFAULT 0,

  department_id        INT UNSIGNED NULL,
  brand_id             INT UNSIGNED NULL,

  -- Image is one of: an uploaded file, a named icon, or a colour/gradient tile.
  image_path           VARCHAR(255) NULL,
  image_icon           VARCHAR(64)  NULL,
  image_color          VARCHAR(32)  NULL,

  purchase_vat_rate_id INT UNSIGNED NULL,
  selling_vat_rate_id  INT UNSIGNED NULL,

  -- Both held EXCLUSIVE of VAT. Inclusive cost, markup, GP and exclusive
  -- selling price are all derived at read time from these plus the VAT rate.
  last_cost            DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  average_cost         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The site total. Per-room levels and quantities live in
  -- product_location_stock; min_stock and max_stock were dropped here by 028.
  stock_on_hand        DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  is_archived          TINYINT(1)   NOT NULL DEFAULT 0,

  -- last_edit_date is when a PERSON last saved the product. Distinct from
  -- updated_at, which any write touches - including a stock movement.
  last_edit_date       DATETIME     NULL,
  last_purchase_date   DATETIME     NULL,
  last_sold_date       DATETIME     NULL,
  last_adjust_date     DATETIME     NULL,

  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- ── Properties (006) ──────────────────────────────────────────────────
  visible_in_pos       TINYINT(1)    NOT NULL DEFAULT 1,
  change_description   TINYINT(1)    NOT NULL DEFAULT 0,
  ask_price_at_sale    TINYINT(1)    NOT NULL DEFAULT 0,
  allow_fractions      TINYINT(1)    NOT NULL DEFAULT 0,
  charge_pct_subtotal  TINYINT(1)    NOT NULL DEFAULT 0,
  non_gp_product       TINYINT(1)    NOT NULL DEFAULT 0,
  -- A percentage ceiling, not an amount: 0 means no discount is allowed.
  max_discount_pct     DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  -- What a variable barcode encodes for this product. 'none' when it has none.
  variable_type        VARCHAR(16)   NOT NULL DEFAULT 'none',
  -- Which figure survives a cost change: 'selling' holds the shelf price and
  -- lets margin move; 'markup' holds margin and moves the shelf price.
  price_calc           VARCHAR(16)   NOT NULL DEFAULT 'selling',

  -- ── Weight and size (006, 009) ────────────────────────────────────────
  pack_weight          DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  weight_description   VARCHAR(24)   NOT NULL DEFAULT 'Kg',
  pack_size            DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  pack_description     VARCHAR(24)   NOT NULL DEFAULT 'None',
  length_mm            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  width_mm             DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  height_mm            DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  prep_time_minutes    INT           NOT NULL DEFAULT 0,

  -- ── Scale properties (006) ────────────────────────────────────────────
  scale_item           TINYINT(1)    NOT NULL DEFAULT 0,
  label_scale_item     TINYINT(1)    NOT NULL DEFAULT 0,
  fixed_price_scale    TINYINT(1)    NOT NULL DEFAULT 0,
  expires_in_days      INT           NOT NULL DEFAULT 0,

  -- ── Storefront (034) ──────────────────────────────────────────────────
  show_online          TINYINT(1)    NOT NULL DEFAULT 0,

  -- ── Variants (070) ────────────────────────────────────────────────────
  -- NULL for a standalone product AND for a parent. Set only on a child, so
  -- "is a variant of something" is exactly parent_id IS NOT NULL.
  parent_id            INT UNSIGNED  NULL,
  has_variants         TINYINT(1)    NOT NULL DEFAULT 0,
  axis_1_value         VARCHAR(60)   NOT NULL DEFAULT '',
  axis_2_value         VARCHAR(60)   NOT NULL DEFAULT '',
  variant_sort         INT           NOT NULL DEFAULT 0,

  PRIMARY KEY (id),
  UNIQUE KEY uq_product_code (code),
  KEY ix_product_barcode (barcode),
  KEY ix_product_description (description),
  KEY ix_product_department (department_id),
  KEY ix_product_brand (brand_id),
  KEY ix_product_archived (is_archived, description),
  KEY ix_product_show_online (show_online, is_archived),
  KEY ix_product_parent (parent_id, variant_sort),
  KEY ix_product_has_variants (has_variants, is_archived),

  CONSTRAINT fk_product_dept    FOREIGN KEY (department_id)        REFERENCES departments (id) ON DELETE SET NULL,
  CONSTRAINT fk_product_brand   FOREIGN KEY (brand_id)             REFERENCES brands (id)      ON DELETE SET NULL,
  CONSTRAINT fk_product_vat_buy FOREIGN KEY (purchase_vat_rate_id) REFERENCES vat_rates (id)   ON DELETE SET NULL,
  CONSTRAINT fk_product_vat_sel FOREIGN KEY (selling_vat_rate_id)  REFERENCES vat_rates (id)   ON DELETE SET NULL,
  CONSTRAINT fk_product_parent  FOREIGN KEY (parent_id)            REFERENCES products (id)    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_prices (
  product_id         INT UNSIGNED NOT NULL,
  price_structure_id INT UNSIGNED NOT NULL,
  selling_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, price_structure_id),
  KEY ix_pp_structure (price_structure_id),
  CONSTRAINT fk_pp_product   FOREIGN KEY (product_id)         REFERENCES products (id)         ON DELETE CASCADE,
  CONSTRAINT fk_pp_structure FOREIGN KEY (price_structure_id) REFERENCES price_structures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────
-- Placeholders for the products the history still points at.
--
-- Recreating the table does not undo the drop: on ody10000_master, 156 rows
-- across seven tables reference product ids that no longer exist - 15 sales
-- lines, 3 purchase lines, 8 stock movements, 52 images, 54 location piles, 12
-- price-schedule lines and 12 stock-take lines.
--
-- Three things could be done with them and only one is defensible.
--
-- DELETING them is the tidiest schema and the worst outcome: posted sales and
-- purchase documents would silently lose lines and stop reconciling against
-- their own stored totals. A document that no longer adds up is a bigger
-- problem than a product that no longer exists.
--
-- LEAVING them dangling looks harmless until the next product is created. The
-- table restarts at id 1, so product 3 would inherit product 3s images, stock
-- piles and sales history from a completely unrelated item that was deleted -
-- a wrong answer presented with total confidence, which is worse than an
-- error. It also leaves 32 foreign keys that existing rows violate, so any
-- UPDATE touching one of them now fails.
--
-- So: one archived, plainly-labelled row per referenced id. Integrity is whole
-- again, history renders a name instead of a broken join, AUTO_INCREMENT lands
-- past the highest referenced id so no new product can be handed one, and
-- nobody reading "(deleted product #57)" on a sale can mistake it for a real
-- item. visible_in_pos and show_online are 0 and is_archived is 1, so these
-- never appear at the till, in the catalogue, or on the storefront.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO products (id, code, description, product_type, is_archived, visible_in_pos, show_online)
SELECT r.id,
       CONCAT('DELETED-', r.id),
       CONCAT('(deleted product #', r.id, ')'),
       'normal', 1, 0, 0
  FROM (
    -- Every column in the schema with a foreign key onto products(id). A
    -- referenced id missing from products is by definition an orphan, so this
    -- returns nothing at all on a site whose keys are intact.
    SELECT product_id AS id FROM commission_rules
    UNION SELECT product_id        FROM contract_lines
    UNION SELECT product_id        FROM instruction_options
    UNION SELECT reward_product_id FROM loyalty_cards
    UNION SELECT product_id        FROM loyalty_card_items
    UNION SELECT reward_product_id FROM loyalty_vouchers
    UNION SELECT product_id        FROM manufacturing_orders
    UNION SELECT product_id        FROM manufacturing_order_lines
    UNION SELECT product_id        FROM online_order_lines
    UNION SELECT product_id        FROM online_stock_holds
    UNION SELECT product_id        FROM pos_quick_keys
    UNION SELECT product_id        FROM price_schedule_lines
    UNION SELECT product_id        FROM product_images
    UNION SELECT product_id        FROM product_instruction_groups
    UNION SELECT product_id        FROM product_location_stock
    UNION SELECT component_id      FROM product_recipes
    UNION SELECT parent_id         FROM product_recipes
    UNION SELECT product_id        FROM product_refers
    UNION SELECT target_id         FROM product_refers
    UNION SELECT product_id        FROM product_reviews
    UNION SELECT product_id        FROM product_serials
    UNION SELECT product_id        FROM product_suppliers
    UNION SELECT product_id        FROM product_variant_axes
    UNION SELECT product_id        FROM purchase_document_lines
    UNION SELECT product_id        FROM sales_document_lines
    UNION SELECT product_id        FROM sales_document_line_instructions
    UNION SELECT product_id        FROM special_items
    UNION SELECT product_id        FROM stock_movements
    UNION SELECT product_id        FROM stock_take_lines
    UNION SELECT product_id        FROM stock_transfer_lines
    UNION SELECT product_id        FROM storefront_events
    UNION SELECT product_id        FROM supplier_prices
  ) r
 WHERE r.id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = r.id);
