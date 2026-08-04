-- Per-product sharing overrides.
--
-- Whether a product's cost and selling price are shared across the linked
-- stores defaults to the group membership setting (cp2_store_group_members in
-- odyssey_tickets). A product that needs to differ carries a row here.
--
-- This lives in the STORE's own master database rather than the ticketing
-- database on purpose: it is keyed by product code, and product codes are
-- per-store data. Keeping it here also means a store that leaves the group
-- keeps working with no cleanup in a shared database.
--
-- Absent row = follow the group default. Only a deliberate per-product choice
-- creates one, so this table stays small.
CREATE TABLE IF NOT EXISTS product_share_settings (
  -- Product CODE, not id: ids increment independently in each store's database,
  -- so only the code identifies "the same product" across them.
  product_code   VARCHAR(48) NOT NULL,
  shares_cost    TINYINT(1)  NOT NULL DEFAULT 1,
  shares_selling TINYINT(1)  NOT NULL DEFAULT 1,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
