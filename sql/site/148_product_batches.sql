-- Batch / lot / expiry tracking -- the per-lot analogue of serials (021/027).
--
-- THE INVARIANTS, stated the way 021 states S1:
--   (T1) for a batch product, SUM(qty_remaining) over its lots equals
--        products.stock_on_hand;
--   (T2) per location, SUM(qty_remaining) at L equals
--        product_location_stock.stock_on_hand at L (T2 implies T1);
--   (T3) per lot, qty_remaining equals the sum of its batch_movements.
--
-- The hook that keeps these true lives inside recordMovement -- the single
-- gate every stock change passes through -- so every caller present and
-- future is covered by construction. The UNTRACKED bucket (batch_no = the
-- empty string, at most one per product and location under the unique key)
-- absorbs quantity that arrives without lot data and may go negative on an
-- oversell, exactly as stock_on_hand itself may: hiding an over-commitment
-- is worse than showing it.
--
-- seedOpeningStock writes movements directly and bypasses the hook; that is
-- go-live seeding, before types are set, and the type-conversion seeder
-- closes the gap the moment a product becomes batch-tracked.

CREATE TABLE IF NOT EXISTS product_batches (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id      INT UNSIGNED NOT NULL,
  location_id     INT UNSIGNED NOT NULL,
  -- The lot identity. Empty string is the UNTRACKED bucket -- NULL would
  -- let the unique key admit duplicates in MariaDB.
  batch_no        VARCHAR(64)  NOT NULL DEFAULT '',
  expiry_date     DATE         NULL,
  qty_received    DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  -- May go negative on the bucket row only; see the header.
  qty_remaining   DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  cost_excl       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The first GRV that brought the lot in. Plain column, no FK, matching
  -- product_serials.received_doc_id.
  received_doc_id INT UNSIGNED NULL,
  received_at     DATETIME     NULL,
  note            VARCHAR(190) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_identity (product_id, location_id, batch_no),
  KEY ix_batch_fefo (product_id, location_id, expiry_date),
  KEY ix_batch_expiry (expiry_date),
  KEY ix_batch_received_doc (received_doc_id),
  CONSTRAINT fk_batch_product  FOREIGN KEY (product_id)  REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_batch_location FOREIGN KEY (location_id) REFERENCES stock_locations (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per slice of a movement that touched a lot -- the audit that makes
-- T3 checkable and a recall traceable in both directions.
CREATE TABLE IF NOT EXISTS batch_movements (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id         INT UNSIGNED NOT NULL,
  -- The stock_movements row this slice belongs to. Plain column, not an FK:
  -- movements are immutable and never deleted.
  movement_id      INT UNSIGNED NULL,
  action           VARCHAR(24)  NOT NULL,
  qty_change       DECIMAL(12,3) NOT NULL,
  document_id      INT UNSIGNED NULL,
  document_line_id INT UNSIGNED NULL,
  -- Which table document_id names, copied from the movement.
  source           VARCHAR(30)  NOT NULL DEFAULT '',
  user_id          INT UNSIGNED NULL,
  user_name        VARCHAR(120) NOT NULL DEFAULT '',
  note             VARCHAR(190) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_bmove_batch (batch_id, created_at),
  KEY ix_bmove_movement (movement_id),
  KEY ix_bmove_doc (document_id),
  KEY ix_bmove_line (document_line_id),
  CONSTRAINT fk_bmove_batch FOREIGN KEY (batch_id) REFERENCES product_batches (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
