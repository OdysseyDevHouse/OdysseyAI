-- Every price write, on the record.
--
-- Until now only a SCHEDULED change kept its own before/after snapshot; the
-- editor, the import, a bulk reprice and the linked-store fan-out changed
-- prices silently. This table is written by writePriceRows -- the one
-- definition of a price write -- so every path records who moved what.
--
-- CASCADE, unlike stock_movements RESTRICT: a price history row is a note
-- about a catalogue entry, not a financial transaction, and it must not newly
-- block deleting a never-traded product.
CREATE TABLE IF NOT EXISTS product_price_history (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id         INT UNSIGNED NOT NULL,
  price_structure_id INT UNSIGNED NOT NULL,
  -- NULL means the product had no price under this structure before.
  old_price_incl     DECIMAL(12,4) NULL,
  -- NULL means the price row was DELETED (a schedule revert of a first fill).
  new_price_incl     DECIMAL(12,4) NULL,
  -- editor | import | reprice | schedule | revert | fanout
  source             VARCHAR(24)  NOT NULL DEFAULT 'editor',
  -- The schedule or origin behind the write, when there is one.
  source_doc_id      INT UNSIGNED NULL,
  user_name          VARCHAR(120) NOT NULL DEFAULT '',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_pph_product (product_id, created_at),
  KEY ix_pph_structure (product_id, price_structure_id, created_at),
  CONSTRAINT fk_pph_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_pph_structure FOREIGN KEY (price_structure_id)
    REFERENCES price_structures (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
