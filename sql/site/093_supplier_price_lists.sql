-- Supplier price lists.
--
-- RECONSTRUCTED 2026-08-11. This migration was recorded as applied in
-- ody10000_master on 2026-08-10 but its file was never committed, so the table
-- exists on that database and on no other. The shape below is taken verbatim
-- from SHOW CREATE TABLE against the live database; the original comments are
-- gone and what follows is inference from the columns, not the author intent.
--
-- No code in src/ reads or writes this table today. The screens that used it
-- were part of the work lost on 2026-08-09 (see RECOVERY-NOTES.md). The
-- migration is restored anyway so that a NEW site provisions the same schema
-- the master database already has, rather than quietly diverging from it.
--
-- What the shape says: a supplier quotes a cost for a product from a date, and
-- history is kept rather than overwritten - hence effective_from in the key
-- instead of one row per supplier/product pair. pack_size is here as well as on
-- products because a supplier can sell the same item in a different case size
-- to the one the shop stocks it in.
CREATE TABLE IF NOT EXISTS supplier_prices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id    INT UNSIGNED NOT NULL,
  product_id     INT UNSIGNED NOT NULL,

  -- The date the quoted cost starts applying. Part of the unique key, so a new
  -- price list adds rows rather than destroying what the previous one said.
  effective_from DATE NOT NULL,

  -- Exclusive of VAT, matching products.last_cost and products.average_cost.
  cost_excl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How many units the quoted cost covers, in the supplier own packing.
  pack_size      DECIMAL(12,3) NOT NULL DEFAULT 1.000,

  -- Where the figure came from: a list name, a quote number, a filename.
  list_reference VARCHAR(60)  NULL,
  note           VARCHAR(190) NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- One cost per supplier, per product, per start date. Re-importing the same
  -- list is then an update rather than a second contradictory row.
  UNIQUE KEY uq_supplier_price (supplier_id, product_id, effective_from),

  -- "What does this product cost, most recently" - the question purchasing and
  -- reorder suggestions ask.
  KEY ix_sprice_product (product_id, effective_from),

  CONSTRAINT fk_sprice_product  FOREIGN KEY (product_id)  REFERENCES products (id)  ON DELETE CASCADE,
  CONSTRAINT fk_sprice_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
