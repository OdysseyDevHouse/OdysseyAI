-- ─────────────────────────────────────────────────────────────────────────
-- Lay-bys.
--
-- Goods put aside and paid off in instalments. Governed in South Africa by
-- section 62 of the Consumer Protection Act 68 of 2008, and the statute
-- decides most of the design here — this is not a place to be inventive.
--
-- ── WHAT THE LAW SAYS, AND WHAT IT MEANS FOR THIS SCHEMA ─────────────────
--
-- 1. "Money paid remains the property of the consumer until delivery."
--
--    So a lay-by payment is NOT a debtor transaction. It never goes in
--    customer_transactions, because every row there moves customers.balance
--    and flows into the age analysis and the credit limit. A customer with
--    R2 000 on lay-by owes the shop NOTHING — the shop is holding THEIR
--    money. Recording it as debtor credit would let it be allocated against
--    an unrelated invoice, which is spending money belonging to someone else.
--
--    Hence layby_payments: a separate table, deliberately.
--
-- 2. The supplier keeps possession until paid in full.
--
--    So stock is RESERVED, not moved. Same derived-figure mechanism sales
--    orders use — Σ stock_movements.qty_change still equals stock_on_hand,
--    because a reservation moves nothing.
--
-- 3. VAT time of supply falls on DELIVERY, not on deposit.
--
--    A deposit sits outside the VAT system until it is applied to the price
--    or forfeited. So no invoice and no VAT until the final payment, at
--    which point an ordinary invoice is raised through the ordinary posting
--    path. A forfeited deposit IS consideration and does attract VAT, which
--    is why cancellation writes its own document rather than just closing
--    the row.
--
-- 4. Cancellation charges are capped at 1% of the FULL purchase price, may
--    only be levied once the customer is 60 business days past the agreed
--    completion date, and may not be charged at all on death or
--    hospitalisation, or if the penalty was not disclosed up front.
--
--    Hence cancellation_fee, fee_waived_reason, and the settings that carry
--    the disclosed percentage for the store.
--
-- 5. Failing to deliver after full payment costs the shop DOUBLE the amount
--    paid, and a stock shortage is explicitly not an excuse.
--
--    Hence the reservation being real rather than advisory.
--
-- DDL auto-commits, so every statement here is re-runnable.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS laybys (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  layby_number      VARCHAR(32)  NULL,
  customer_id       INT UNSIGNED NOT NULL,

  --   open       being paid off
  --   completed  paid in full and the goods handed over
  --   cancelled  ended early; goods released, money refunded less any fee
  --   expired    past its date and swept; kept distinct from cancelled so the
  --              exception report can tell "customer asked" from "we swept it"
  status            ENUM('open','completed','cancelled','expired') NOT NULL DEFAULT 'open',

  -- The agreed total, VAT INCLUSIVE, fixed when the lay-by is taken out.
  -- Snapshotted like a document line: a price rise next month must not change
  -- what this customer agreed to pay.
  total_incl        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- What has actually been handed over. Denormalised from layby_payments for
  -- the same reason customers.balance is: the list screen sorts and filters on
  -- it. reconcileLaybys proves the two agree.
  paid_total        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The date the customer agreed to finish paying. The 60-business-day
  -- penalty clock starts here, not at the start of the lay-by.
  due_date          DATE         NULL,

  -- Set when it completes: the invoice finally raised. NULL until then, which
  -- is the whole VAT point.
  invoice_doc_id    INT UNSIGNED NULL,
  completed_at      DATETIME     NULL,

  -- Cancellation. fee_pct is snapshotted from the setting at the moment of
  -- cancellation, because the store may change its disclosed percentage later
  -- and this row must keep saying what was actually charged.
  cancelled_at      DATETIME     NULL,
  cancel_reason     VARCHAR(190) NULL,
  cancellation_fee  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  cancellation_fee_pct DECIMAL(6,3) NOT NULL DEFAULT 0.000,
  -- Why no fee was charged when one otherwise applied — death, hospitalisation
  -- or non-disclosure. Recorded rather than assumed, so the exception report
  -- can show a fee was consciously waived rather than forgotten.
  fee_waived_reason VARCHAR(190) NULL,

  terminal_id       INT UNSIGNED NULL,
  user_id           INT UNSIGNED NULL,
  user_name         VARCHAR(120) NOT NULL DEFAULT '',
  note              VARCHAR(400) NULL,

  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_layby_number (layby_number),
  KEY ix_layby_customer (customer_id, status),
  KEY ix_layby_status (status, due_date),
  CONSTRAINT fk_layby_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_layby_invoice  FOREIGN KEY (invoice_doc_id) REFERENCES sales_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What is being put aside.
--
-- Snapshots everything, exactly as sales_document_lines does and for exactly
-- the same reason: this is a record of what was agreed, not a live view of the
-- product file.
CREATE TABLE IF NOT EXISTS layby_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  layby_id        INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  product_id      INT UNSIGNED NULL,
  product_code    VARCHAR(48)  NULL,
  description     VARCHAR(190) NOT NULL,
  product_type    VARCHAR(24)  NOT NULL DEFAULT 'normal',
  department_id   INT UNSIGNED NULL,
  qty             DECIMAL(12,3) NOT NULL DEFAULT 1.000,
  unit_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  discount_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  discount_incl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  line_total_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_total_excl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_vat        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  unit_cost_excl  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_layby_line_layby (layby_id),
  KEY ix_layby_line_product (product_id),
  CONSTRAINT fk_layby_line_layby FOREIGN KEY (layby_id) REFERENCES laybys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The money belonging to the customer, held.
--
-- NOTE: no apostrophes in comments in this file. The runner sends it as one
-- multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
--
-- NOT customer_transactions. See the note at the top of this file: every row
-- there moves the debtor balance, and this money is not a debt — it belongs to
-- the customer until the goods are handed over.
--
-- The tender type is recorded because these payments DO go through the till
-- and must appear in the cash-up. Money physically arrived in the drawer even
-- though no sale has been made.
CREATE TABLE IF NOT EXISTS layby_payments (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  layby_id       INT UNSIGNED NOT NULL,
  --   deposit   the first payment, taken when the lay-by is opened
  --   instalment  every payment after that
  --   refund    money given back on cancellation (negative amount)
  --   forfeit   the cancellation fee kept by the shop (negative amount)
  kind           ENUM('deposit','instalment','refund','forfeit') NOT NULL DEFAULT 'instalment',
  -- Positive takes money in, negative gives it back. Σ amount = paid_total.
  amount         DECIMAL(12,4) NOT NULL,
  tender_type_id INT UNSIGNED NULL,
  tender_name    VARCHAR(60)  NOT NULL DEFAULT '',
  reference      VARCHAR(120) NULL,
  paid_on        DATE         NOT NULL,
  terminal_id    INT UNSIGNED NULL,
  shift_id       INT UNSIGNED NULL,
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  note           VARCHAR(190) NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_layby_pay_layby (layby_id, paid_on),
  KEY ix_layby_pay_shift (shift_id),
  CONSTRAINT fk_layby_pay_layby FOREIGN KEY (layby_id) REFERENCES laybys (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Numbering ────────────────────────────────────────────────────────────
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('layby', 'LAY', 1, 6, 'none');

-- ── Settings ─────────────────────────────────────────────────────────────
-- The cancellation fee the store has DISCLOSED. Defaults to zero: a fee may
-- only be charged if the customer was told about it before signing, and a
-- system that defaults to charging one would put every store in breach on
-- their first lay-by.
--
-- The 1% ceiling is enforced in code (laybyRules.ts) rather than here, so the
-- refusal can explain itself rather than silently truncating.
--   layby_cancellation_fee_pct  capped at 1% by the CPA, and only chargeable
--                               if disclosed to the customer up front
--   layby_default_days          how long a customer has to pay it off
--   layby_terms_text            printed on the customer copy; the fee must be
--                               disclosed here for it to be chargeable at all
INSERT IGNORE INTO settings (setting_key, setting_value)
VALUES
  ('layby_cancellation_fee_pct', '0'),
  ('layby_default_days', '90'),
  ('layby_terms_text', '');
