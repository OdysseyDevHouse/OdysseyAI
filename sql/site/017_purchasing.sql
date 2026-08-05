-- Purchasing — orders and goods received.
--
-- The MIRROR of sales_documents, and deliberately its own table. The two face
-- opposite ways in every dimension a query touches:
--
--                      sale                    purchase
--   counterparty       customer (debtor)       supplier (creditor)
--   ledger             customer_transactions   supplier_transactions
--   stock              decreases               INCREASES
--   money figure       selling price INCL VAT  cost EXCLUDING VAT
--   VAT rate           vat_type = 'sales'      vat_type = 'purchase'
--   cost side effect   none                    MOVES average_cost
--
-- Forcing both into one table would mean a nullable customer_id AND a nullable
-- supplier_id guarded by a check constraint, two price columns of which one is
-- always NULL, and a CASE on doc_type in every report. That is the
-- polymorphic-table mistake, and it is worse than the five-separate-tables one
-- avoided on the sales side.
--
-- WHAT IS SHARED is the machinery, not the table: documentMath, sequences,
-- stock_movements and the posting-transaction shape are all reused unchanged.
--
-- THE COST RULE: a GRV is the ONLY thing that moves products.average_cost.
-- That column has been non-writable by the product form since 001_products.sql,
-- with a comment saying it is "a consequence of purchases and stock movements".
-- This is that consequence.

CREATE TABLE purchase_documents (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  --   purchase_order   — what we asked for. Moves nothing.
  --   grv              — goods received. Moves stock and cost.
  --   supplier_return  — goods sent back. The mirror of a credit note.
  doc_type        ENUM('purchase_order','grv','supplier_return') NOT NULL,

  --   draft     — being captured
  --   issued    — an order sent to the supplier. Still moves nothing.
  --   finalised — received. Stock in, cost moved, ledger posted, number issued.
  --   void      — received in error, reversed the same day.
  --   cancelled — an order abandoned. Never had a number.
  status          ENUM('draft','issued','finalised','void','cancelled')
                  NOT NULL DEFAULT 'draft',

  -- NULL until finalise, exactly as on a sale: MySQL permits many NULLs in a
  -- unique index, which is the property being used.
  document_number VARCHAR(32)  NULL,
  document_date   DATE         NOT NULL,
  -- document_date + the supplier's terms, snapshotted at posting. Changing
  -- their terms next year must not re-age an invoice already booked.
  due_date        DATE         NULL,

  supplier_id     INT UNSIGNED NOT NULL,
  supplier_code   VARCHAR(32)  NULL,      -- snapshot, as everywhere else
  supplier_name   VARCHAR(160) NULL,

  -- THEIR invoice number, which is what a query about this delivery quotes and
  -- what the payment run matches against. Distinct from our own GRV number.
  supplier_invoice_no VARCHAR(60) NULL,

  user_id         INT UNSIGNED NULL,      -- cp2_users.id, control DB, no FK
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  -- Totals held EXCLUSIVE of VAT, because that is how a supplier invoice is
  -- written and how stock is valued. The opposite of a sale, which stores the
  -- inclusive figure the customer agreed to.
  subtotal_excl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_total       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  total_incl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Delivery, freight and the like, spread across the lines at receipt so the
  -- cost of an item reflects what it actually cost to get onto the shelf.
  charges_excl    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- A GRV points at the order it fulfils; a return points at the GRV it
  -- reverses. Same shape as converted_from_id / reverses_id on a sale.
  ordered_from_id INT UNSIGNED NULL,
  reverses_id     INT UNSIGNED NULL,

  reference       VARCHAR(60)  NULL,
  notes           VARCHAR(400) NULL,
  internal_note   VARCHAR(400) NULL,
  void_reason     VARCHAR(190) NULL,
  voided_at       DATETIME     NULL,
  finalised_at    DATETIME     NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pdoc_number (doc_type, document_number),
  KEY ix_pdoc_supplier (supplier_id, document_date),
  KEY ix_pdoc_date (document_date, id),
  KEY ix_pdoc_status (doc_type, status, document_date),
  KEY ix_pdoc_invoice (supplier_invoice_no),
  -- RESTRICT: a supplier with purchase history is not deletable, and the
  -- database says so rather than trusting every code path to remember.
  CONSTRAINT fk_pdoc_supplier FOREIGN KEY (supplier_id)     REFERENCES suppliers (id)          ON DELETE RESTRICT,
  CONSTRAINT fk_pdoc_order    FOREIGN KEY (ordered_from_id) REFERENCES purchase_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_pdoc_reverses FOREIGN KEY (reverses_id)     REFERENCES purchase_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Lines.
--
-- SNAPSHOT EVERYTHING, for the same reason a sale line does: a GRV is a record
-- of what was received at what price, and it must not change when the product
-- file does.
CREATE TABLE purchase_document_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id     INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  product_id      INT UNSIGNED NULL,
  product_code    VARCHAR(48)  NULL,
  -- THEIR code for it, which is what appears on the order and their invoice.
  supplier_code   VARCHAR(48)  NULL,
  description     VARCHAR(190) NOT NULL,
  product_type    VARCHAR(30)  NOT NULL DEFAULT 'normal',
  department_id   INT UNSIGNED NULL,

  qty_ordered     DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  -- What actually arrived. Partial deliveries are the normal case, not the
  -- exception, so an order stays open until this catches up.
  qty_received    DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- EXCLUSIVE of VAT — how a supplier invoice is written, and what
  -- products.average_cost is measured in.
  unit_cost_excl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  discount_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,

  line_total_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_vat        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_total_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- This line's share of the document's freight and charges, apportioned at
  -- receipt. Added to the unit cost so the shelf cost is the LANDED cost —
  -- a case that cost R500 plus R60 delivery cost R560, and pricing off R500
  -- quietly understates every margin it feeds.
  charge_excl     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- unit_cost_excl + apportioned charges, per unit. What average_cost blends.
  landed_cost_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_pline_document (document_id, line_number),
  KEY ix_pline_product (product_id),
  CONSTRAINT fk_pline_document FOREIGN KEY (document_id) REFERENCES purchase_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_pline_product  FOREIGN KEY (product_id)  REFERENCES products (id)           ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Order-only facts, 1:1 with a purchase_order row.
--
-- Kept out of purchase_documents so a GRV does not carry columns that can only
-- ever be NULL — the same reasoning as sales_order_details.
CREATE TABLE purchase_order_details (
  document_id       INT UNSIGNED NOT NULL,
  expected_date     DATE         NULL,
  fulfilment_status ENUM('open','part_received','received','cancelled') NOT NULL DEFAULT 'open',
  -- Their reference for our order, quoted when chasing a late delivery.
  supplier_order_no VARCHAR(60)  NULL,
  PRIMARY KEY (document_id),
  CONSTRAINT fk_porder_doc FOREIGN KEY (document_id) REFERENCES purchase_documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Numbering, alongside the sales sequences in the same table.
INSERT INTO document_sequences (doc_type, prefix, next_number, padding) VALUES
  ('purchase_order',  'PO',  1, 6),
  ('grv',             'GRV', 1, 6),
  ('supplier_return', 'SRT', 1, 6);
