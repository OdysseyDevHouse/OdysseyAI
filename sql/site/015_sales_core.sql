-- Sales — documents, lines, tenders, and the machinery around them.
--
-- ONE table holds every kind of sales document: quote, sales order, invoice and
-- credit note. They share the same lines, the same tenders, the same customer
-- and the same totals; five tables would mean five copies of every query and a
-- union on every report. `doc_type` says what it is, `status` says where it is
-- in its life.
--
-- Purchase orders and GRVs are NOT here. They face the other way in every
-- dimension a query touches — supplier not customer, stock in not out, cost
-- excluding VAT not selling price including it, and they move average_cost.
-- They get purchase_documents when purchasing is built.
--
-- THE MONEY RULE, carried through from 001_products.sql: a line stores the
-- selling price INCLUSIVE of VAT, because that is the figure the customer
-- agreed to. Exclusive and VAT are derived from it by SUBTRACTION, never
-- computed independently — see documentMath.ts.
--
-- SIGN CONVENTION: a credit note carries NEGATIVE quantities and NEGATIVE
-- money. Every aggregate is then a plain SUM. The alternative — positive
-- quantities with a CASE on doc_type in every report — is how two reports end
-- up disagreeing.

-- ── Terminals ──────────────────────────────────────────────────────────
-- A till. Registered here first, then claimed by a machine, so a manager can
-- see every till in the store, revoke one, or move it to another counter
-- without touching the machine itself.
CREATE TABLE terminals (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code         VARCHAR(24)  NOT NULL,   -- 'TILL01' — prints on the slip, groups reports
  name         VARCHAR(60)  NOT NULL,   -- 'Front counter'
  location     VARCHAR(60)  NULL,

  -- The machine currently claiming this terminal. NULL means registered but
  -- unclaimed. Cleared to hand the till to a replacement machine.
  device_id    VARCHAR(64)  NULL,
  device_label VARCHAR(120) NULL,       -- what the machine called itself, for support

  is_active    TINYINT(1)   NOT NULL DEFAULT 1,
  claimed_at   DATETIME     NULL,
  last_seen_at DATETIME     NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_terminal_code (code),
  -- One machine holds at most one terminal, so a mis-registration surfaces as
  -- a refusal rather than two tills silently sharing an identity.
  UNIQUE KEY uq_terminal_device (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Tender types ───────────────────────────────────────────────────────
-- How a sale is paid for. Every site gets card / cash / account / EFT seeded
-- and adds its own — a spaza has three, a franchise with Yoco, SnapScan and a
-- loyalty wallet has ten. That is why these are ROWS and not an ENUM: a new
-- payment method must never need a schema change or a deploy.
--
-- The columns fall into two groups and the split matters. BEHAVIOUR flags are
-- read by the tender engine and change what the system DOES. PRESENTATION only
-- decides how the button looks. Anything that cannot be justified as "the
-- engine branches on this" belongs in the integration config, not here.
CREATE TABLE tender_types (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- `code` is the stable handle the engine matches on ('CASH'); `name` is what
  -- the cashier sees and may be renamed to "Kontant" without breaking a rule.
  code          VARCHAR(24)  NOT NULL,
  name          VARCHAR(60)  NOT NULL,

  -- ── BEHAVIOUR: the engine branches on every one of these ─────────────
  -- Posts to the debtor ledger instead of settling the sale. An account tender
  -- brings no money in; it moves the balance onto the customer's card.
  posts_to_debtor       TINYINT(1) NOT NULL DEFAULT 0,
  -- Meaningless without a customer, so the till must refuse it for a walk-in.
  requires_customer     TINYINT(1) NOT NULL DEFAULT 0,
  -- Physically in the drawer, so the cash-up counts it.
  counts_as_drawer_cash TINYINT(1) NOT NULL DEFAULT 0,
  opens_cash_drawer     TINYINT(1) NOT NULL DEFAULT 0,
  -- Can be over-tendered and give change. Cash can; a card settles exactly.
  allows_change         TINYINT(1) NOT NULL DEFAULT 0,
  allows_split          TINYINT(1) NOT NULL DEFAULT 1,
  allows_refund         TINYINT(1) NOT NULL DEFAULT 1,
  -- A deposit is worthless without its reference — it is the only way the money
  -- is ever matched to this sale on the bank statement.
  requires_reference    TINYINT(1) NOT NULL DEFAULT 0,
  reference_label       VARCHAR(40) NULL,
  -- Rounds the TENDER (not the invoice) to the nearest cash denomination.
  rounds_to_cash_denomination TINYINT(1) NOT NULL DEFAULT 0,
  -- Card machines with a R20 floor; merchants passing on the acquirer fee.
  min_amount    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  max_amount    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,   -- 0 = no ceiling
  surcharge_pct DECIMAL(6,3)  NOT NULL DEFAULT 0.000,

  -- Points at tender_integrations. NULL for the seeded four, which never touch
  -- that table — the common case pays nothing.
  integration_key VARCHAR(40) NULL,

  -- ── PRESENTATION ─────────────────────────────────────────────────────
  icon          VARCHAR(40)  NULL,       -- a name from components/ui/icons
  color         VARCHAR(20)  NULL,       -- a tile-swatch token, never a hex
  position      INT          NOT NULL DEFAULT 0,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  -- Seeded rows the engine assumes exist. Editable, but not deletable.
  is_system     TINYINT(1)   NOT NULL DEFAULT 0,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tender_code (code),
  KEY ix_tender_active (is_active, position)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Credentials and settings for a payment provider, referenced by
-- tender_types.integration_key. Separate from tender_types because secrets must
-- never be read by the setup list query, and because two tender buttons
-- ("Yoco tap", "Yoco card") legitimately share one merchant account.
CREATE TABLE tender_integrations (
  integration_key VARCHAR(40) NOT NULL,
  provider        VARCHAR(40) NOT NULL,   -- 'yoco' | 'payfast' | 'loyalty' | …
  display_name    VARCHAR(80) NOT NULL,
  -- Non-secret provider settings: terminal id, environment, webhook url. JSON
  -- because every provider wants different keys and the app treats this as an
  -- opaque bag handed to that provider's adapter.
  config          JSON        NULL,
  -- AES-256-GCM enc:v1 envelopes from lib/crypto/secrets.ts, as one JSON blob.
  -- LONGTEXT not JSON so nothing tempts a query to reach inside; it is only
  -- ever decrypted whole, server-side.
  secrets_enc     LONGTEXT    NULL,
  is_active       TINYINT(1)  NOT NULL DEFAULT 1,
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (integration_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Document numbering ─────────────────────────────────────────────────
-- One row per document type. `last_issued_number` holds the value just
-- consumed and `next_number` the one after it, so issuing needs no arithmetic
-- and no future reader has to wonder whether it is next-1 or next.
--
-- The increment MUST be the atomic `UPDATE … SET next_number = next_number + 1`
-- in sequences.ts. A SELECT-then-UPDATE double-issues under concurrency — and
-- not rarely: under REPEATABLE READ a plain SELECT takes no lock at all, so two
-- tills read 41, both write 42, and both print INV000041.
CREATE TABLE document_sequences (
  doc_type           VARCHAR(24)  NOT NULL,
  prefix             VARCHAR(12)  NOT NULL DEFAULT '',
  next_number        INT UNSIGNED NOT NULL DEFAULT 1,
  last_issued_number INT UNSIGNED NULL,
  padding            TINYINT UNSIGNED NOT NULL DEFAULT 6,
  -- 'none' or 'yearly'. A yearly reset restarts at 1 and stamps period_key, all
  -- inside the same atomic statement, so two tills crossing midnight on 1
  -- January cannot both perform "the" reset.
  reset_period       ENUM('none','yearly') NOT NULL DEFAULT 'none',
  period_key         VARCHAR(8)   NULL,
  last_issued_at     DATETIME     NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (doc_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Sales documents ────────────────────────────────────────────────────
CREATE TABLE sales_documents (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  doc_type        ENUM('quote','sales_order','invoice','credit_note') NOT NULL,

  --   draft     — being captured; nothing has happened.
  --   parked    — saved and recalled later. Still nothing has happened.
  --   issued    — a quote or order sent to the customer. Not a tax document.
  --   finalised — posted. Stock moved, the ledger moved, a number was issued.
  --   void      — finalised then reversed the same day. Keeps its number.
  --   cancelled — a quote or order abandoned. Never had a number.
  status          ENUM('draft','parked','issued','finalised','void','cancelled')
                  NOT NULL DEFAULT 'draft',

  -- NULL until finalise. Not '' or 'PENDING': MySQL permits many NULLs in a
  -- unique index, which is exactly the property being used to let every
  -- unfinalised document coexist under one unique key.
  document_number VARCHAR(32)  NULL,
  document_date   DATE         NOT NULL,
  due_date        DATE         NULL,

  -- NULL for a walk-in. A cash sale does not create a debtor account; the
  -- snapshots below carry whatever the customer gave us, so the debtors book
  -- stays a list of real accounts rather than a dumping ground.
  customer_id     INT UNSIGNED NULL,
  customer_code   VARCHAR(32)  NULL,     -- snapshot: renaming must not rewrite history
  customer_name   VARCHAR(160) NULL,
  customer_vat_no VARCHAR(40)  NULL,
  customer_phone  VARCHAR(40)  NULL,
  customer_address VARCHAR(400) NULL,

  price_structure_id INT UNSIGNED NULL,

  -- cp2_users.id from the CONTROL database — no FK is possible across
  -- databases. The name is snapshotted for the same reason as the customer's.
  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  -- Which till and which shift. Nullable and unused today: the moment a store
  -- has two tills, "which register rang this" and "whose cash-up owns it"
  -- become unanswerable, and backfilling a year of invoices is guesswork. Two
  -- columns cost nothing now and are impossible to add meaningfully later.
  terminal_id     INT UNSIGNED NULL,
  terminal_code   VARCHAR(24)  NULL,     -- snapshot, same reasoning
  shift_id        INT UNSIGNED NULL,

  -- Totals, all VAT-INCLUSIVE except subtotal_excl. Stored rather than derived
  -- so a finalised document reports the same figures forever, even if a VAT
  -- rate changes next year.
  subtotal_excl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_total       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  discount_total  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  total_incl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- 5c cash rounding, applied to the TENDER and never to the invoice. The
  -- invoice says R432.47, the drawer takes R432.45, this holds -0.02. Rounding
  -- the invoice instead would make declared VAT wrong on every cash sale.
  rounding_adj    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- What the customer actually handed over, less change. Reconciles the drawer.
  tendered_total  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  change_given    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- A quote converts by creating a LINKED new document, keeping the quote
  -- intact; a credit note points at the invoice it reverses.
  converted_from_id INT UNSIGNED NULL,
  reverses_id       INT UNSIGNED NULL,

  reference       VARCHAR(60)  NULL,     -- the customer's own order number
  notes           VARCHAR(400) NULL,     -- prints on the document
  internal_note   VARCHAR(400) NULL,     -- never printed
  void_reason     VARCHAR(190) NULL,
  voided_at       DATETIME     NULL,
  voided_by_user_id INT UNSIGNED NULL,
  finalised_at    DATETIME     NULL,
  print_count     INT UNSIGNED NOT NULL DEFAULT 0,
  last_printed_at DATETIME     NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The backstop. Even if every argument in sequences.ts turned out to be
  -- wrong, the database itself refuses a duplicate invoice number.
  UNIQUE KEY uq_doc_number (doc_type, document_number),
  KEY ix_doc_date (document_date, id),
  KEY ix_doc_customer (customer_id, document_date),
  KEY ix_doc_status (doc_type, status, document_date),
  KEY ix_doc_terminal (terminal_id, document_date),
  KEY ix_doc_user (user_id, document_date),
  -- RESTRICT: a customer with sales history is not deletable, and the database
  -- says so rather than trusting every code path to remember.
  CONSTRAINT fk_sdoc_customer  FOREIGN KEY (customer_id)  REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_sdoc_terminal  FOREIGN KEY (terminal_id)  REFERENCES terminals (id) ON DELETE SET NULL,
  CONSTRAINT fk_sdoc_converted FOREIGN KEY (converted_from_id) REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_sdoc_reverses  FOREIGN KEY (reverses_id)  REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Order-only facts, 1:1 with a sales_documents row of doc_type='sales_order'.
-- Kept out of sales_documents so an invoice does not carry four columns that
-- can only ever be NULL, and so adding a fulfilment field later touches one
-- small table instead of the busiest one in the database.
CREATE TABLE sales_order_details (
  document_id       INT UNSIGNED NOT NULL,
  delivery_date     DATE         NULL,
  fulfilment_status ENUM('open','part_delivered','delivered','cancelled') NOT NULL DEFAULT 'open',
  -- Reservation is a DERIVED figure, not a stock movement: stock_movements
  -- records actual movement only, so Σ qty_change still equals stock_on_hand.
  -- Reserved = Σ(qty - qty_delivered) over open order lines.
  reserves_stock    TINYINT(1)   NOT NULL DEFAULT 1,
  reserved_at       DATETIME     NULL,
  expires_at        DATETIME     NULL,   -- stale orders release their reservation
  customer_order_no VARCHAR(60)  NULL,
  PRIMARY KEY (document_id),
  CONSTRAINT fk_order_details_doc FOREIGN KEY (document_id) REFERENCES sales_documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Lines ──────────────────────────────────────────────────────────────
-- SNAPSHOT EVERYTHING. description, product_code, unit_price_incl, vat_rate_pct
-- and unit_cost_excl are copied here at sale time. An invoice must not change
-- when a product's price changes next week.
--
-- Someone will later see the duplication and want to normalise it away. Do not.
-- The whole point of an invoice is that it is a record of what was agreed, not
-- a live view of the product file.
CREATE TABLE sales_document_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id     INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- NULL for a free-text line ("Delivery", "Callout fee"). SET NULL rather than
  -- RESTRICT: products are archived, not deleted, once sales history exists —
  -- but if one ever is, the line keeps its snapshot and stays readable.
  product_id      INT UNSIGNED NULL,
  product_code    VARCHAR(48)  NULL,
  description     VARCHAR(190) NOT NULL,
  product_type    VARCHAR(30)  NOT NULL DEFAULT 'normal',
  department_id   INT UNSIGNED NULL,     -- snapshot, so a re-filed product does
                                         -- not rewrite last year's department report

  -- Negative on a credit note. See the sign convention at the top.
  qty             DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  -- How much of an ordered qty has been delivered. Only moves on a sales order;
  -- an invoice line never leaves zero.
  qty_delivered   DECIMAL(12,3) NOT NULL DEFAULT 0.000,

  -- INCLUSIVE of VAT — the figure on the shelf and the one the customer agreed
  -- to. Everything else on the line is derived from it.
  unit_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  discount_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  discount_incl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,

  -- Computed by documentMath.ts and stored. line_vat is line_incl - line_excl,
  -- BY SUBTRACTION: computing it independently disagrees by a cent about one
  -- time in fifty, and then the document total stops equalling net + VAT.
  line_total_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_total_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_vat        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Cost at the moment of sale, EXCLUSIVE of VAT, for the GP report. Copied
  -- from the product; a credit note copies it from the original invoice line so
  -- returning at today's higher cost cannot manufacture phantom margin.
  unit_cost_excl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_line_document (document_id, line_number),
  KEY ix_line_product (product_id),
  KEY ix_line_department (department_id),
  CONSTRAINT fk_line_document FOREIGN KEY (document_id) REFERENCES sales_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_line_product  FOREIGN KEY (product_id)  REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Tenders ────────────────────────────────────────────────────────────
-- What was handed over, NOT what was owed.
--
-- R100 cash on an R87.50 sale is a R100 tender with R12.50 change. Store the
-- net and the drawer is short R12.50 at every cash-up and nobody will know why.
CREATE TABLE sales_tenders (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id     INT UNSIGNED NOT NULL,
  tender_type_id  INT UNSIGNED NOT NULL,
  tender_code     VARCHAR(24)  NOT NULL,   -- snapshot: a renamed tender must not
  tender_name     VARCHAR(60)  NOT NULL,   -- rewrite what the slip said

  amount          DECIMAL(12,4) NOT NULL DEFAULT 0.0000,  -- gross, as handed over
  change_given    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  surcharge       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  reference       VARCHAR(60)  NULL,       -- deposit ref, card auth code

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_tender_document (document_id),
  -- Bank reconciliation reads this: takings by tender type by day.
  KEY ix_tender_type_date (tender_type_id, created_at),
  CONSTRAINT fk_stender_document FOREIGN KEY (document_id)    REFERENCES sales_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_stender_type     FOREIGN KEY (tender_type_id) REFERENCES tender_types (id)    ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Stock movements ────────────────────────────────────────────────────
-- Every quantity change in the business, from any source, in ONE place.
--
-- This is what makes Σ qty_change = products.stock_on_hand provable — the same
-- promise reconcileBalances makes about the debtor ledger. Purchasing will
-- write here too; splitting it per module would destroy the one invariant that
-- proves stock is right.
--
-- Reservations are NOT movements. A reserved item has not moved.
CREATE TABLE stock_movements (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id    INT UNSIGNED NOT NULL,

  --   sale         — sold, reduces stock
  --   sale_return  — credited back, increases it
  --   opening      — the position at go-live; without one per product,
  --                  Σ qty_change ≠ stock_on_hand from day one
  --   receipt      — a GRV (purchasing)
  --   adjustment   — a stock take or a write-off
  --   transfer_in / transfer_out — between sites
  movement_type ENUM('sale','sale_return','opening','receipt','adjustment',
                     'transfer_in','transfer_out') NOT NULL,

  -- Signed: negative takes stock out. Always the DELTA, never a new total.
  qty_change    DECIMAL(12,3) NOT NULL,
  -- On hand immediately after this movement, for reconstructing a position at a
  -- past date without replaying the whole table.
  qty_after     DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  -- Cost EXCLUSIVE of VAT at the moment of movement, for stock valuation.
  unit_cost_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  source        VARCHAR(24)  NOT NULL DEFAULT 'sale',
  source_doc_id INT UNSIGNED NULL,
  source_line_id INT UNSIGNED NULL,

  terminal_id   INT UNSIGNED NULL,
  shift_id      INT UNSIGNED NULL,
  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  note          VARCHAR(190) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_move_product (product_id, created_at),
  KEY ix_move_source (source, source_doc_id),
  KEY ix_move_type_date (movement_type, created_at),
  KEY ix_move_terminal (terminal_id, created_at),
  -- RESTRICT: stock history outlives the product record. deleteProduct() flips
  -- to archive-on-reference precisely because of this.
  CONSTRAINT fk_move_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Document audit ─────────────────────────────────────────────────────
-- Before/after for anything that changes a finalised document. Distinct from
-- activity_log: that records master-file edits, this records what happened to a
-- tax document, and an auditor asks about them separately.
CREATE TABLE document_audit (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id INT UNSIGNED NOT NULL,
  action      VARCHAR(40)  NOT NULL,     -- 'finalised' | 'void' | 'reprinted' | 'edited'
  detail      VARCHAR(400) NULL,
  before_json JSON         NULL,
  after_json  JSON         NULL,
  user_id     INT UNSIGNED NULL,
  user_name   VARCHAR(120) NOT NULL DEFAULT '',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_docaudit_document (document_id, created_at),
  CONSTRAINT fk_docaudit_document FOREIGN KEY (document_id) REFERENCES sales_documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Role capabilities ──────────────────────────────────────────────────
-- The minimum viable permission model. Role-level only: users live in the
-- control database, and a per-user table here goes stale the day someone is
-- removed upstream with nothing to notice.
CREATE TABLE role_capabilities (
  site_role  ENUM('owner','manager','staff') NOT NULL,
  capability VARCHAR(60) NOT NULL,
  allowed    TINYINT(1)  NOT NULL DEFAULT 0,
  PRIMARY KEY (site_role, capability)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Seeds ──────────────────────────────────────────────────────────────

-- The four every ZA store has. is_system so they cannot be deleted out from
-- under the engine; everything about them is still editable.
INSERT INTO tender_types
  (code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash, opens_cash_drawer,
   allows_change, allows_split, allows_refund, requires_reference, reference_label,
   rounds_to_cash_denomination, position, icon, color, is_system)
VALUES
  -- CASH: the only tender physically in the drawer, so the only one the cash-up
  -- counts and the only one that gives change. Rounds because 1c and 2c coins
  -- no longer circulate.
  ('CASH', 'Cash', 0, 0, 1, 1, 1, 1, 1, 0, NULL, 1, 1, 'Banknote', 'tile-2', 1),
  -- CARD: settled by the terminal for the exact amount, so no change and no
  -- drawer cash. The drawer still opens — the slip goes in it.
  ('CARD', 'Card', 0, 0, 0, 1, 0, 1, 1, 0, NULL, 0, 2, 'CreditCard', 'tile-1', 1),
  -- ACCOUNT: no money changes hands. It moves the balance onto the customer's
  -- debtor card, which is meaningless without a customer.
  ('ACCOUNT', 'Account', 1, 1, 0, 0, 0, 1, 1, 0, NULL, 0, 3, 'Users', 'tile-4', 1),
  -- EFT: the money arrives at the bank later. The reference is mandatory
  -- because it is the ONLY way the deposit is matched to this sale on the
  -- statement. Not refundable at the till — that is a treasury action.
  ('EFT', 'Direct deposit', 0, 0, 0, 0, 0, 1, 0, 1, 'Deposit reference', 0, 4, 'Building2', 'tile-5', 1);

-- Numbering. Separate sequences so an invoice number is never a quote number,
-- and padding to 6 so INV000041 sorts as text in the order it was issued.
INSERT INTO document_sequences (doc_type, prefix, next_number, padding) VALUES
  ('invoice',     'INV', 1, 6),
  ('credit_note', 'CRN', 1, 6),
  ('quote',       'QUO', 1, 6),
  ('sales_order', 'SO',  1, 6);

-- Sensible defaults. An owner can do everything; staff can sell but not undo.
INSERT INTO role_capabilities (site_role, capability, allowed) VALUES
  ('owner',   'sales.void',               1),
  ('owner',   'sales.credit_note',        1),
  ('owner',   'sales.edit_finalised',     1),
  ('owner',   'sales.discount_override',  1),
  ('owner',   'sales.price_override',     1),
  ('manager', 'sales.void',               1),
  ('manager', 'sales.credit_note',        1),
  ('manager', 'sales.edit_finalised',     0),
  ('manager', 'sales.discount_override',  1),
  ('manager', 'sales.price_override',     1),
  ('staff',   'sales.void',               0),
  ('staff',   'sales.credit_note',        0),
  ('staff',   'sales.edit_finalised',     0),
  ('staff',   'sales.discount_override',  0),
  ('staff',   'sales.price_override',     0);

-- Sales settings. The KV table already exists (001_products.sql).
INSERT INTO settings (setting_key, setting_value) VALUES
  -- 5c rounding at the drawer. Applies to the TENDER, never the invoice.
  ('sales_cash_rounding', '0.05'),
  -- A date before which nothing may be voided, edited or backdated. Empty means
  -- no period is locked. MUST be set before supervisor edit is ever enabled.
  ('vat_period_locked_to', ''),
  -- Whether a finalised invoice may be corrected at all. Off until the
  -- reverse-and-repost path is built and proven.
  ('sales_allow_finalised_edit', '0'),
  -- Scale/variable barcodes. Formats vary by scale vendor, so these are
  -- settings rather than constants — a store with Avery scales and one with
  -- Bizerba need different numbers and neither should need a deploy.
  ('barcode_variable_prefix', '2'),
  ('barcode_plu_length', '5'),
  ('barcode_value_divisor', '100');
