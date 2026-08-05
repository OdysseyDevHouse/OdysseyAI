-- ─────────────────────────────────────────────────────────────────────────
-- Recipe and refer products.
--
-- Two product types that have existed in productTypes.ts since the beginning
-- and refused to sell, because the tables they need were never built. The
-- till says so honestly today ("Recipe products need their component list,
-- which is not built yet"). This is that list.
--
-- Both answer the same question — "when this sells, what actually leaves the
-- shelf?" — and answer it differently:
--
--   recipe  a made item consumes SEVERAL other products in fixed quantities.
--           A burger takes a patty, a bun and a slice of cheese. Selling one
--           moves three stock lines and none of its own.
--
--   refer   one product IS another, counted differently. A six-pack is six
--           singles. Selling one six-pack takes six off the singles. Its own
--           stock is never carried, because there is only one pile of stock
--           and it is measured in singles.
--
-- DDL auto-commits, so every statement here is re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Recipes ──────────────────────────────────────────────────────────────
-- The component list for a 'recipe' product. One row per ingredient.
--
-- qty is per ONE of the parent: a burger needing two patties stores 2.000,
-- and selling three burgers deducts six patties. Storing "per batch" instead
-- would need a batch size column and a division on every sale, and the first
-- person to change the batch size would silently rescale every past figure.
CREATE TABLE IF NOT EXISTS product_recipes (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The made item — always a product whose product_type is 'recipe'.
  parent_id     INT UNSIGNED NOT NULL,
  -- What it consumes. Any stocked product, including another recipe: nesting
  -- is allowed and resolved recursively at sale time, with a depth cap so a
  -- cycle cannot hang the till.
  component_id  INT UNSIGNED NOT NULL,
  qty           DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  -- Wastage as a percentage on top of qty. Trimming loses some of the cut,
  -- and a kitchen that ignores it slowly drifts short on every stock take.
  wastage_pct   DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  position      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One row per component per parent: two rows for the same ingredient is
  -- always a mistake, and silently summing them hides it.
  UNIQUE KEY uq_recipe_line (parent_id, component_id),
  KEY ix_recipe_component (component_id),
  CONSTRAINT fk_recipe_parent    FOREIGN KEY (parent_id)    REFERENCES products (id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: deleting an ingredient that a recipe depends on
  -- must fail loudly rather than quietly leaving a burger with no patty.
  CONSTRAINT fk_recipe_component FOREIGN KEY (component_id) REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Refers ───────────────────────────────────────────────────────────────
-- A 'refer' product points at the product that actually carries the stock.
--
-- 1:1 with the referring product, so it is keyed on it. The factor is how
-- many of the target one of these is: a six-pack referring to a single
-- stores 6.000, and selling one six-pack moves six singles.
CREATE TABLE IF NOT EXISTS product_refers (
  product_id    INT UNSIGNED NOT NULL,
  -- The product that holds the stock and the cost.
  target_id     INT UNSIGNED NOT NULL,
  -- How many of the target make up one of these. Six for a six-pack.
  factor        DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (product_id),
  KEY ix_refer_target (target_id),
  CONSTRAINT fk_refer_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_refer_target  FOREIGN KEY (target_id)  REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
