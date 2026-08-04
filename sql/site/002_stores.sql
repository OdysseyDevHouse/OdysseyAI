-- Stores, and the per-store values that used to live on `products`.
--
-- MODEL: shared default + per-store override.
--
-- The columns already on `products` (last_cost, stock_on_hand, min_stock,
-- max_stock) and the rows in `product_prices` stay exactly as they are and
-- become the SHARED value — what the screen shows as "All stores". A store
-- only gets a row in the override tables below when it has opted out of
-- following the shared value.
--
-- Storing overrides rather than a row per (product, store) is deliberate:
--   * existing data stays correct with no backfill — one value per product IS
--     the shared value, which is what every store currently uses;
--   * a 10,000-product, 50-store site does not immediately grow 500,000 rows
--     to say "same as everyone else";
--   * changing the shared cost keeps working the way it does today, which is
--     the behaviour the "update cost on all branches" flag describes.
--
-- Stock on hand is the exception and is NOT an override — see below.

-- ── Stores ─────────────────────────────────────────────────────────────
-- A trading location within this site. Distinct from cp2_sites in the CONTROL
-- database: a site is one customer's whole dataset (one database), a store is
-- one branch inside it. One site, many stores.
CREATE TABLE stores (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code          VARCHAR(24)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  position      INT          NOT NULL DEFAULT 0,
  -- The store that stands in for "the business" where one store is implied,
  -- and the store a new session opens on. Exactly one should carry this.
  is_default    TINYINT(1)   NOT NULL DEFAULT 0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  -- When 1, this store follows the shared cost / selling price and any
  -- override rows are ignored. Turning it off is what makes a store appear as
  -- its own row on the product screen.
  follows_shared_cost    TINYINT(1) NOT NULL DEFAULT 1,
  follows_shared_selling TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stores_code (code),
  KEY ix_stores_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Per-store cost override ────────────────────────────────────────────
-- Present only for a store that does not follow the shared cost. Absent means
-- "use products.last_cost".
CREATE TABLE product_store_costs (
  product_id   INT UNSIGNED NOT NULL,
  store_id     INT UNSIGNED NOT NULL,
  last_cost    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- average_cost is a consequence of THIS store's purchases, so it is genuinely
  -- per-store data rather than an override of a shared figure.
  average_cost DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, store_id),
  KEY ix_psc_store (store_id),
  CONSTRAINT fk_psc_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_psc_store   FOREIGN KEY (store_id)   REFERENCES stores (id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Per-store selling price override ───────────────────────────────────
-- Keyed by structure as well as store: a store may override its Retail price
-- while still following the shared Wholesale price.
CREATE TABLE product_store_prices (
  product_id         INT UNSIGNED NOT NULL,
  store_id           INT UNSIGNED NOT NULL,
  price_structure_id INT UNSIGNED NOT NULL,
  selling_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, store_id, price_structure_id),
  KEY ix_psp_store (store_id),
  KEY ix_psp_structure (price_structure_id),
  CONSTRAINT fk_psp_product   FOREIGN KEY (product_id)         REFERENCES products (id)         ON DELETE CASCADE,
  CONSTRAINT fk_psp_store     FOREIGN KEY (store_id)           REFERENCES stores (id)           ON DELETE CASCADE,
  CONSTRAINT fk_psp_structure FOREIGN KEY (price_structure_id) REFERENCES price_structures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Per-store inventory ────────────────────────────────────────────────
-- NOT an override. Stock on hand is a physical fact about one location and can
-- never be shared, and reorder levels follow it — a level is meaningless
-- except against the stock it governs. A store with no row here simply has no
-- stock and no levels set, which is the correct reading of "absent".
CREATE TABLE product_store_inventory (
  product_id    INT UNSIGNED NOT NULL,
  store_id      INT UNSIGNED NOT NULL,
  stock_on_hand DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  min_stock     DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  max_stock     DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, store_id),
  KEY ix_psi_store (store_id),
  CONSTRAINT fk_psi_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_psi_store   FOREIGN KEY (store_id)   REFERENCES stores (id)   ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seed ───────────────────────────────────────────────────────────────
-- Every existing site is single-store today, so create that one store and give
-- it the stock and levels currently held on `products`. Cost and prices are NOT
-- copied: this store follows the shared value, which is exactly where they
-- already live.
INSERT INTO stores (code, name, position, is_default) VALUES
  ('MAIN', 'Main store', 1, 1);

INSERT INTO product_store_inventory (product_id, store_id, stock_on_hand, min_stock, max_stock)
SELECT p.id, s.id, p.stock_on_hand, p.min_stock, p.max_stock
  FROM products p
  CROSS JOIN stores s
 WHERE s.code = 'MAIN';
