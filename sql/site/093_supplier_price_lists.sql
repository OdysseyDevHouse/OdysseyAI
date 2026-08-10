-- What a supplier has AGREED to charge, and from when.
--
-- product_suppliers.last_cost is what we happened to pay last time. That is a
-- fact about history, not a price: it moves every time a receipt is posted, it
-- carries whatever one-off deal or keying error came with that delivery, and
-- it cannot answer "what should this cost" before the goods arrive.
--
-- So an order goes out at last_cost and nobody notices when the supplier
-- invoices something else. The variance is only visible line by line on the
-- receiving screen, if anyone looks.
--
-- ── EFFECTIVE DATES, NOT A SINGLE FIGURE ─────────────────────────────────
--
-- A supplier says "these are the prices from 1 March". They send the list in
-- February. Storing one agreed cost per product would mean either keying the
-- new list on the morning it starts -- which nobody does -- or having February
-- price at March's rates.
--
-- So a row is (product, supplier, effective_from), and the price that applies
-- on a date is the LATEST row not in the future. Tomorrow's list can be
-- captured today and simply starts working tomorrow.
--
-- ── WHY NOT A COLUMN ON product_suppliers ────────────────────────────────
--
-- That table is one row per relationship and holds what is true NOW: their
-- code for it, the pack size, the last cost. A price with a date is a series,
-- and a series does not fit in a row that has to keep being overwritten. The
-- two live side by side: product_suppliers says who supplies it, this says
-- what they charge.
CREATE TABLE IF NOT EXISTS supplier_prices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id    INT UNSIGNED NOT NULL,
  product_id     INT UNSIGNED NOT NULL,

  -- The day this price starts applying. A list captured in advance simply has
  -- a future date and is ignored until then.
  effective_from DATE NOT NULL,

  -- EXCLUSIVE of VAT, like every other purchase figure in this schema.
  cost_excl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How many of OUR units come in one of THEIR cases, at this price. Repeated
  -- from product_suppliers rather than read from it because a supplier who
  -- changes their case size is changing their price list, and last year's
  -- orders should still show the case size they were placed at.
  pack_size      DECIMAL(12,3) NOT NULL DEFAULT 1.000,

  -- Their reference for the list this line came off, quoted when querying it.
  list_reference VARCHAR(60)  NULL,
  note           VARCHAR(190) NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One price per product per supplier per START DATE. Re-keying the same list
  -- corrects the row rather than stacking a second one behind it, which is
  -- what the upsert in supplierPrices.ts relies on.
  UNIQUE KEY uq_supplier_price (supplier_id, product_id, effective_from),
  -- "What does this product cost, from whom" -- the ordering direction, and
  -- the one the effective-date lookup drives.
  KEY ix_sprice_product (product_id, effective_from),
  CONSTRAINT fk_sprice_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE CASCADE,
  CONSTRAINT fk_sprice_product FOREIGN KEY (product_id)
    REFERENCES products (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
