-- Expenses — what the business spends that is NOT stock.
--
-- Purchasing (017) can only record a supplier invoice as a GRV against
-- products: it moves stock, it moves average_cost, and every line needs a
-- product_id. Rent, salaries, insurance, the electricity bill and the
-- accountant's fee are none of those things, so until now they could not be
-- recorded at all — which means the system has never known what the business
-- actually spends, only what it buys to resell.
--
-- ── WHY NOT REUSE purchase_documents ─────────────────────────────────────
--
-- The same reasoning 017 gives for not reusing sales_documents. A GRV line has
-- a product, a quantity, a unit cost and a stock consequence; an expense line
-- has a category and an amount and no stock consequence at all. Folding them
-- together means a nullable product_id, a nullable location_id, a quantity that
-- is always 1, and a CASE on doc_type in every stock query — with the standing
-- risk that an expense accidentally moves average_cost.
--
-- WHAT IS SHARED is the machinery: documentMath's VAT split, sequences,
-- supplier_transactions, period locks and the cashbook are all reused unchanged.
--
-- ── THE CATEGORY IS THE FUTURE CHART OF ACCOUNTS ─────────────────────────
--
-- expense_categories carries an `account_code` from the day it is created, even
-- though there is no general ledger yet. When the GL lands, these rows become
-- the expense section of the chart of accounts and every expense already posted
-- has somewhere to go. Adding the code later would mean back-filling every
-- historical expense by hand, which is the migration nobody ever finishes.

CREATE TABLE expense_categories (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The account code this maps to. Free text now, the GL's account number
  -- later. Conventionally 4000-5999 for expenses in South African practice,
  -- which is what the seed below follows.
  account_code  VARCHAR(16)  NOT NULL,
  name          VARCHAR(120) NOT NULL,

  -- Nesting, so "Motor vehicle expenses" can hold fuel, repairs and licences
  -- and the P&L can report either level. Same shape as departments (001).
  parent_id     INT UNSIGNED NULL,

  --   operating — the ordinary running costs: rent, salaries, electricity
  --   cost_of_sales — bought to resell but not stocked: freight in, subcontract
  --   capital   — an asset rather than an expense; excluded from the P&L and
  --               picked up by the fixed-asset register when that exists
  --   other     — interest paid, bank charges, anything below the line
  -- This decides which section of the P&L a category lands in, and capital is
  -- separated NOW because booking an asset as an expense is the single most
  -- common bookkeeping error and the hardest to unpick a year later.
  category_type ENUM('operating','cost_of_sales','capital','other')
                NOT NULL DEFAULT 'operating',

  -- Most expenses carry VAT at the standard rate, but salaries, bank interest
  -- and payments to non-vendors carry none. Defaulting per category is what
  -- stops someone claiming input VAT on a salary — which is an assessment.
  default_vat_rate_id INT UNSIGNED NULL,
  -- Whether input VAT may be claimed on this category at all. Entertainment
  -- and passenger vehicles are denied by section 17(2) of the VAT Act
  -- regardless of the invoice, so this is a hard flag rather than a default.
  vat_claimable BOOLEAN      NOT NULL DEFAULT TRUE,

  -- A running total kept for the category list, so the setup screen does not
  -- need a correlated subquery per row. Maintained by the posting code.
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order    INT          NOT NULL DEFAULT 0,
  notes         VARCHAR(400) NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_expcat_code (account_code),
  KEY ix_expcat_parent (parent_id, sort_order),
  KEY ix_expcat_active (is_active, sort_order),
  -- RESTRICT: deleting a parent must not silently delete a branch that
  -- expenses still point at. Same rule as departments.
  CONSTRAINT fk_expcat_parent FOREIGN KEY (parent_id) REFERENCES expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expcat_vat FOREIGN KEY (default_vat_rate_id) REFERENCES vat_rates (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One expense: a bill received, or money simply spent.
--
-- ── PAID vs PAYABLE, AND WHY BOTH ────────────────────────────────────────
--
-- Two genuinely different events wear the same word "expense":
--
--   A BILL from a supplier on account. It creates a liability now and is paid
--   later, so it must hit supplier_transactions and appear on the age
--   analysis and in a payment run.
--
--   A DIRECT payment — the card at the petrol station, the cash for parking.
--   There is no liability; money left the bank the moment it happened.
--
-- Forcing the second through a supplier account would invent a creditor for
-- every petrol station. Forcing the first to be paid immediately would lose the
-- liability. So `payment_type` distinguishes them and the posting code branches
-- once, in one place.
CREATE TABLE expenses (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  --   draft     — being captured, moves nothing
  --   finalised — posted: the ledger and/or the bank have moved
  --   void      — reversed. Kept, never deleted, per 014's rule.
  status          ENUM('draft','finalised','void') NOT NULL DEFAULT 'draft',

  -- Our own reference. NULL until finalised, exactly as on a sale or GRV:
  -- MySQL permits many NULLs in a unique index, which is the property used.
  document_number VARCHAR(32)  NULL,
  expense_date    DATE         NOT NULL,
  -- expense_date + the supplier's terms, snapshotted at posting. Only set for
  -- an on-account bill; a direct payment is not due, it is done.
  due_date        DATE         NULL,

  --   on_account — a bill; posts to supplier_transactions, paid later
  --   direct     — money already gone; posts straight to the cashbook
  payment_type    ENUM('on_account','direct') NOT NULL DEFAULT 'direct',

  -- Set for an on-account bill, and optionally for a direct payment where the
  -- payee happens to be a supplier we know. NULL for a one-off payee.
  supplier_id     INT UNSIGNED NULL,
  supplier_name   VARCHAR(160) NULL,      -- snapshot, or a free-text payee
  -- THEIR invoice number. What a query about this bill quotes, and what stops
  -- the same invoice being captured twice — see ix_exp_supplier_invoice.
  supplier_invoice_no VARCHAR(60) NULL,

  -- Which account the money came out of, for a direct payment. NULL on a bill,
  -- which is paid later through a payment run.
  bank_account_id INT UNSIGNED NULL,
  -- The bank_transactions row this created, so a void can back it out.
  bank_txn_id     INT UNSIGNED NULL,
  -- The supplier_transactions row this created, for an on-account bill.
  supplier_txn_id INT UNSIGNED NULL,

  -- Totals, computed from the lines by documentMath and stored, exactly as
  -- sales and purchase documents do. Recomputing at read time would let a
  -- rounding change silently restate a historical document.
  subtotal_excl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_total       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  total_incl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The portion of vat_total that may actually be claimed, after the
  -- per-category vat_claimable flag. The VAT return reads THIS, not vat_total.
  vat_claimable   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  reference       VARCHAR(60)  NULL,
  description     VARCHAR(190) NULL,
  notes           TEXT         NULL,

  -- Set when this was raised by a recurring template, so the schedule can show
  -- what it has produced and skip a period already generated.
  recurring_id    INT UNSIGNED NULL,

  -- The expense this one reverses, for a void.
  reverses_id     INT UNSIGNED NULL,

  user_id         INT UNSIGNED NULL,      -- cp2_users.id, control DB, no FK
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  finalised_at    DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_exp_number (document_number),
  KEY ix_exp_date (expense_date, id),
  KEY ix_exp_status (status, expense_date),
  KEY ix_exp_supplier (supplier_id, expense_date),
  KEY ix_exp_bank (bank_account_id),
  KEY ix_exp_recurring (recurring_id),
  -- Capturing the same supplier invoice twice is the commonest expense error
  -- and the one that silently overstates costs. Not UNIQUE — a supplier may
  -- legitimately reuse a number across years — but indexed so the capture
  -- screen can warn.
  KEY ix_exp_supplier_invoice (supplier_id, supplier_invoice_no),
  CONSTRAINT fk_exp_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_exp_bank_txn FOREIGN KEY (bank_txn_id) REFERENCES bank_transactions (id) ON DELETE SET NULL,
  CONSTRAINT fk_exp_supplier_txn FOREIGN KEY (supplier_txn_id) REFERENCES supplier_transactions (id) ON DELETE SET NULL,
  CONSTRAINT fk_exp_reverses FOREIGN KEY (reverses_id) REFERENCES expenses (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The split. One expense may hit several categories — a hardware store slip
-- that is part repairs and part consumables — and the P&L needs each part
-- under its own heading rather than the whole slip under one.
CREATE TABLE expense_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  expense_id      INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  category_id     INT UNSIGNED NOT NULL,
  -- Snapshotted, like every other document line in this system: renaming a
  -- category next year must not restate what a historical expense said.
  category_code   VARCHAR(16)  NULL,
  category_name   VARCHAR(120) NULL,

  description     VARCHAR(190) NULL,

  -- Which department or cost centre bore this. Optional, but it is what turns
  -- "we spent R40 000 on electricity" into "the workshop used R31 000 of it".
  department_id   INT UNSIGNED NULL,

  -- Amounts, split by documentMath's rule: VAT by SUBTRACTION so that
  -- excl + vat == incl exactly, always. See splitVat in ledger.ts.
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  line_excl       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_vat        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_incl       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- False where the category denies it — entertainment, passenger vehicles.
  -- Snapshotted per line because the rule may change and a filed return must
  -- stay explicable.
  vat_claimable   BOOLEAN       NOT NULL DEFAULT TRUE,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_expline_expense (expense_id, line_number),
  KEY ix_expline_category (category_id),
  KEY ix_expline_dept (department_id),
  -- CASCADE: a line has no meaning without its expense, and the expense itself
  -- is never deleted once finalised — it is voided.
  CONSTRAINT fk_expline_expense FOREIGN KEY (expense_id) REFERENCES expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_expline_category FOREIGN KEY (category_id) REFERENCES expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_expline_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Recurring expenses ───────────────────────────────────────────────────
--
-- Rent on the first, the insurance debit order on the fifteenth, the
-- accountant's retainer every quarter. Re-keying these is both tedious and
-- unreliable: the month somebody forgets, the P&L is simply wrong and nothing
-- reports it.
--
-- A template GENERATES a draft expense; it never posts one. The distinction is
-- deliberate — an amount that changed, a bill that did not arrive, a lease that
-- ended are all things a person must see before money moves. What the schedule
-- removes is the typing, not the judgement.
CREATE TABLE recurring_expenses (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name            VARCHAR(120) NOT NULL,

  --   monthly    — every month on `day_of_month`
  --   weekly     — every week on `day_of_week`
  --   quarterly  — every three months
  --   annually   — once a year
  frequency       ENUM('weekly','monthly','quarterly','annually') NOT NULL DEFAULT 'monthly',
  -- 1-31. A 31 in a short month falls back to the last day, handled in code
  -- because MySQL has no clean way to express it.
  day_of_month    TINYINT UNSIGNED NULL,
  -- 1 = Monday … 7 = Sunday, for a weekly schedule.
  day_of_week     TINYINT UNSIGNED NULL,

  -- The template's own copy of what an expense needs. Deliberately duplicated
  -- rather than pointing at a specimen expense: editing last month's rent must
  -- not silently change what next month generates.
  payment_type    ENUM('on_account','direct') NOT NULL DEFAULT 'direct',
  supplier_id     INT UNSIGNED NULL,
  supplier_name   VARCHAR(160) NULL,
  bank_account_id INT UNSIGNED NULL,
  description     VARCHAR(190) NULL,
  reference       VARCHAR(60)  NULL,

  -- What it usually comes to. Copied onto the generated draft as a starting
  -- point; the person confirming it corrects the figure when the bill differs.
  total_incl      DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  starts_on       DATE         NOT NULL,
  -- NULL means it runs until switched off. A lease with an end date sets it,
  -- so the schedule stops on its own rather than generating for ever.
  ends_on         DATE         NULL,
  -- The last period actually generated. THE idempotence key: generating twice
  -- for the same month must not produce two rent bills.
  last_generated_for DATE      NULL,

  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  notes           VARCHAR(400) NULL,

  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_recur_active (is_active, starts_on),
  CONSTRAINT fk_recur_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL,
  CONSTRAINT fk_recur_bank FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The template's own line split, copied onto each generated expense.
CREATE TABLE recurring_expense_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  recurring_id    INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  category_id     INT UNSIGNED NOT NULL,
  description     VARCHAR(190) NULL,
  department_id   INT UNSIGNED NULL,
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,
  line_incl       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  PRIMARY KEY (id),
  KEY ix_recurline_parent (recurring_id, line_number),
  CONSTRAINT fk_recurline_parent FOREIGN KEY (recurring_id) REFERENCES recurring_expenses (id) ON DELETE CASCADE,
  CONSTRAINT fk_recurline_category FOREIGN KEY (category_id) REFERENCES expense_categories (id) ON DELETE RESTRICT,
  CONSTRAINT fk_recurline_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The FK from an expense back to the template that produced it. Added after
-- both tables exist, because each references the other.
ALTER TABLE expenses
  ADD CONSTRAINT fk_exp_recurring FOREIGN KEY (recurring_id)
      REFERENCES recurring_expenses (id) ON DELETE SET NULL;

-- ── A starting chart of expense accounts ─────────────────────────────────
--
-- Seeded so a store can capture its first expense without designing a chart of
-- accounts first — the task that stops most people using an accounting system
-- at all. The codes follow ordinary South African practice (4000-5999 for
-- expenses) and every one of them can be renamed, deactivated or added to.
--
-- vat_claimable = FALSE where the VAT Act denies the input deduction outright:
-- salaries and wages carry no VAT at all, and entertainment is denied by
-- section 17(2)(a) however the invoice is worded.

INSERT INTO expense_categories (account_code, name, category_type, vat_claimable, sort_order) VALUES
  ('4000', 'Cost of sales — freight in',   'cost_of_sales', TRUE,  10),
  ('4010', 'Cost of sales — subcontractors','cost_of_sales', TRUE, 20),

  ('5000', 'Rent',                          'operating', TRUE,  100),
  ('5010', 'Electricity and water',         'operating', TRUE,  110),
  ('5020', 'Telephone and internet',        'operating', TRUE,  120),
  ('5030', 'Salaries and wages',            'operating', FALSE, 130),
  ('5040', 'Insurance',                     'operating', TRUE,  140),
  ('5050', 'Repairs and maintenance',       'operating', TRUE,  150),
  ('5060', 'Motor vehicle expenses',        'operating', TRUE,  160),
  ('5070', 'Fuel',                          'operating', TRUE,  170),
  ('5080', 'Cleaning and consumables',      'operating', TRUE,  180),
  ('5090', 'Printing and stationery',       'operating', TRUE,  190),
  ('5100', 'Advertising and marketing',     'operating', TRUE,  200),
  ('5110', 'Accounting and legal fees',     'operating', TRUE,  210),
  ('5120', 'Security',                      'operating', TRUE,  220),
  ('5130', 'Software and subscriptions',    'operating', TRUE,  230),
  ('5140', 'Staff welfare and training',    'operating', TRUE,  240),
  -- Denied by section 17(2)(a) of the VAT Act, whatever the invoice says.
  ('5150', 'Entertainment',                 'operating', FALSE, 250),
  ('5160', 'Travel and accommodation',      'operating', TRUE,  260),
  ('5170', 'Licences and permits',          'operating', TRUE,  270),
  ('5900', 'Sundry expenses',               'operating', TRUE,  900),

  ('6000', 'Bank charges',                  'other', TRUE,  1000),
  -- Interest is a financial cost, not an operating one, and carries no VAT.
  ('6010', 'Interest paid',                 'other', FALSE, 1010),

  -- Capital, kept OUT of the P&L. A laptop booked to expenses instead of here
  -- is the commonest bookkeeping error there is, and the hardest to unpick.
  ('7000', 'Equipment purchases (capital)', 'capital', TRUE, 2000),
  ('7010', 'Vehicle purchases (capital)',   'capital', TRUE, 2010);
