-- Additional barcodes per product -- the aliases.
--
-- products.barcode STAYS the primary (it is what every screen, the export,
-- the offline index and the shelf labels print); this table holds the extra
-- codes a product answers to: the 6-pack code, the old supplier code, the
-- imported duplicate. No is_primary column -- primary is already a column on
-- products, and duplicating that fact invites the two to disagree.
--
-- STRICTLY UNIQUE, unlike products.barcode (which is legally shared across
-- products on real sites). No backfill, for exactly that reason: aliases are
-- new data, so the uniqueness that makes an alias scan deterministic can hold
-- from day one.
CREATE TABLE IF NOT EXISTS product_barcodes (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT UNSIGNED NOT NULL,
  barcode    VARCHAR(48)  NOT NULL,
  -- What this code is: 6-pack, old supplier code. Display only.
  note       VARCHAR(60)  NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pbarcode (barcode),
  KEY ix_pbarcode_product (product_id),
  CONSTRAINT fk_pbarcode_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
