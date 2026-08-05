-- ─────────────────────────────────────────────────────────────────────────
-- Serial-number tracking.
--
-- The third product type that has refused to sell since the beginning. A
-- serial product is an ordinary stocked item with one extra promise: every
-- individual unit is identifiable, and the shop can answer "who bought THIS
-- one" a year later when it comes back under warranty.
--
-- ── WHY A ROW PER UNIT, NOT A COUNT ──────────────────────────────────────
--
-- The whole point is the individual. A count cannot tell you which handset
-- went out on which invoice, and that question — asked by a customer holding
-- a faulty phone, or by an insurer after a burglary — is the only reason to
-- carry serials at all.
--
-- So stock_on_hand for a serial product must equal the number of rows here
-- that are still 'in_stock'. That is a second invariant alongside
-- Σ qty_change = stock_on_hand, and it is checkable the same way.
--
-- ── STATUS, NOT DELETION ─────────────────────────────────────────────────
--
-- A sold serial keeps its row and gains a status. Deleting it would destroy
-- the warranty trail, which is the asset. A returned one goes back to
-- 'in_stock' and keeps its history through the movement rows that reference
-- it.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS product_serials (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id    INT UNSIGNED NOT NULL,
  -- The number on the box. Unique per product, not globally: two different
  -- manufacturers legitimately use the same sequence, and a global unique
  -- would reject the second one for no reason.
  serial        VARCHAR(64)  NOT NULL,

  --   in_stock  on the shelf, sellable
  --   sold      gone, with the document that took it
  --   returned  came back and is NOT resellable (faulty, awaiting supplier)
  --   written_off  lost, stolen or scrapped
  --
  -- A resellable return goes straight back to 'in_stock' instead — the
  -- distinction is whether it can be sold again, because that is what decides
  -- if it counts toward stock_on_hand.
  status        ENUM('in_stock','sold','returned','written_off') NOT NULL DEFAULT 'in_stock',

  -- Where it came from. Both nullable: an opening-stock serial predates any
  -- GRV in this system.
  received_doc_id INT UNSIGNED NULL,
  received_at   DATETIME     NULL,
  cost_excl     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Where it went. The warranty trail: this is what answers "who bought it".
  sold_doc_id   INT UNSIGNED NULL,
  sold_line_id  INT UNSIGNED NULL,
  sold_at       DATETIME     NULL,
  customer_id   INT UNSIGNED NULL,

  -- Manufacturer warranty expiry, so the counter can say yes or no without
  -- phoning anyone.
  warranty_until DATE        NULL,
  note          VARCHAR(190) NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- Per product, for the reason in the column comment above.
  UNIQUE KEY uq_serial_product (product_id, serial),
  KEY ix_serial_status (product_id, status),
  -- Looking a serial up by number alone is what the warranty desk does, and
  -- they rarely know the product id.
  KEY ix_serial_number (serial),
  KEY ix_serial_sold_doc (sold_doc_id),
  CONSTRAINT fk_serial_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  -- SET NULL, not RESTRICT: a document may legitimately be removed in
  -- development, and losing the link is better than blocking it. The serial
  -- itself — the thing that matters — survives either way.
  CONSTRAINT fk_serial_sold_doc FOREIGN KEY (sold_doc_id) REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which serials went out on which line, so a credit note can put back exactly
-- the units that came back rather than guessing.
--
-- Separate from product_serials.sold_doc_id because a serial can be sold,
-- returned and sold again: the current state lives on the serial, the HISTORY
-- lives here.
CREATE TABLE IF NOT EXISTS serial_movements (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  serial_id     INT UNSIGNED NOT NULL,
  -- 'sold' | 'returned' | 'received' | 'written_off' | 'adjusted'
  action        VARCHAR(24)  NOT NULL,
  document_id   INT UNSIGNED NULL,
  document_line_id INT UNSIGNED NULL,
  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  note          VARCHAR(190) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_smove_serial (serial_id, created_at),
  KEY ix_smove_doc (document_id),
  CONSTRAINT fk_smove_serial FOREIGN KEY (serial_id) REFERENCES product_serials (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
