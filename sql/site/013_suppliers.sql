-- Suppliers — the creditors book.
--
-- The mirror of customers, and deliberately its own table rather than one
-- "parties" table with a type column: the two differ in most of the columns
-- that matter (credit limit and loyalty here, bank details and lead time
-- there), and every query would carry a type filter it could forget.
--
-- The sign convention is the mirror too: on a customer, a positive balance
-- means they owe us. Here, a positive balance means WE owe THEM. Stated once,
-- in both schemas, because a reporting module that gets this backwards is
-- extremely hard to spot.

CREATE TABLE suppliers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(32)  NOT NULL,
  name           VARCHAR(160) NOT NULL,

  -- Same four states as a customer, same reasoning (see 012_customers.sql).
  -- 'on_hold' here means "do not raise new orders" rather than "do not sell to
  -- them" — a supplier under dispute is still owed whatever is already booked.
  status         ENUM('active','on_hold','inactive','closed') NOT NULL DEFAULT 'active',
  status_reason  VARCHAR(190) NULL,

  contact_name   VARCHAR(120) NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40)  NULL,
  address_line1  VARCHAR(190) NULL,
  address_line2  VARCHAR(190) NULL,
  city           VARCHAR(120) NULL,
  postal_code    VARCHAR(20)  NULL,
  vat_number     VARCHAR(40)  NULL,

  -- OUR account number with THEM — the reference that appears on their
  -- invoices and on a remittance we send back.
  account_number VARCHAR(60)  NULL,

  -- Days from their invoice date to when we must pay. Drives the payables age
  -- analysis and the payment run.
  payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  -- Typical days from order to delivery. Ordering, not accounting — kept here
  -- because it is a fact about the supplier, and it is what a reorder
  -- suggestion needs once purchasing lands.
  lead_time_days SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  -- What they will not deliver below. Purchasing reads it; nothing else does.
  minimum_order  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- For paying them. Not encrypted: these are the details printed on their own
  -- invoices, not a secret. Card and login credentials would be different and
  -- do not belong on this table.
  bank_name      VARCHAR(120) NULL,
  bank_branch    VARCHAR(60)  NULL,
  bank_account   VARCHAR(60)  NULL,

  category       VARCHAR(60)  NULL,

  -- Positive = we owe them. Moves ONLY through posted transactions, in the
  -- same transaction as the ledger row — see the balance comment in
  -- 012_customers.sql, which applies here unchanged.
  balance        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  notes          TEXT         NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_supplier_code (code),
  KEY ix_supplier_name (name),
  KEY ix_supplier_status (status, name),
  KEY ix_supplier_category (category),
  KEY ix_supplier_balance (balance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which supplier a product is bought from, and at what code.
--
-- A separate table rather than products.supplier_id because a product is
-- routinely available from more than one supplier, at different codes and
-- costs, and "who else can supply this" is the question purchasing asks when
-- the usual one is out. `is_preferred` marks the default.
CREATE TABLE product_suppliers (
  product_id     INT UNSIGNED NOT NULL,
  supplier_id    INT UNSIGNED NOT NULL,
  -- Their code for it, which is what goes on the order — rarely ours.
  supplier_code  VARCHAR(48)  NULL,
  -- Last cost from THIS supplier, EXCLUSIVE of VAT to match products.last_cost.
  -- Purchasing writes it on receipt; nothing else may.
  last_cost      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- How many of our units come in one of their cases.
  pack_size      DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  is_preferred   TINYINT(1)   NOT NULL DEFAULT 0,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, supplier_id),
  KEY ix_prodsupp_supplier (supplier_id),
  KEY ix_prodsupp_code (supplier_code),
  -- CASCADE on both: this row describes a relationship, and it has no meaning
  -- once either side is gone.
  CONSTRAINT fk_prodsupp_product  FOREIGN KEY (product_id)  REFERENCES products (id)  ON DELETE CASCADE,
  CONSTRAINT fk_prodsupp_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
