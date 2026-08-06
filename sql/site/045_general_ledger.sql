-- The general ledger — one set of books the subledgers roll up into.
--
-- Everything before this migration is a SUBLEDGER: debtors (014), creditors
-- (014), cashbook (036), expenses (042), stock (001). Each answers its own
-- question correctly and none of them tie together, so the system can say what
-- customers owe and what is in the bank but not whether the business made
-- money, or what it is worth.
--
-- ── THE GOVERNING DECISION: THE GL IS A DERIVED MIRROR ───────────────────
--
-- The subledgers remain the SOURCE OF TRUTH. customers.balance is still moved
-- by customer_transactions and nothing else; bank_accounts.balance is still
-- moved by bank_transactions. The GL is posted ALONGSIDE those writes, never
-- instead of them, and it is reconciled back to them.
--
-- The alternative — making the GL primary and deriving the subledgers from it —
-- is how a real accounting package is built, and it is the wrong choice HERE
-- for three reasons:
--
--   1. Every posting path in this system already maintains a subledger
--      invariant that is tested and trusted. Inverting that is a rewrite of
--      sales, purchasing, cashbook and expenses, not an addition.
--   2. A till must be able to post a sale when the GL mapping for a new tender
--      type has not been configured. Subledger-primary degrades (the sale
--      posts, the GL entry is missing and reported); GL-primary refuses the
--      sale.
--   3. The failure mode is visible either way, but subledger-primary fails
--      SAFE — a missing journal is a reporting gap, whereas a missing sale is
--      lost revenue.
--
-- The price is that the two can drift, so `reconcileControlAccounts()` exists
-- to prove they have not, exactly as reconcileBalances() does for debtors.
--
-- ── DOUBLE ENTRY, ENFORCED ───────────────────────────────────────────────
--
-- Every journal's lines must sum to zero. Not "should" — the posting code
-- refuses otherwise, and journal_batches stores the proof so an out-of-balance
-- batch cannot exist even if a future writer forgets.

CREATE TABLE gl_accounts (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The account number. Conventionally grouped by type in SA practice, which
  -- is what the seed follows:
  --   1000-1999 assets       2000-2999 liabilities    3000-3999 equity
  --   4000-4999 income       5000-5999 cost of sales  6000-7999 expenses
  account_code  VARCHAR(16)  NOT NULL,
  name          VARCHAR(120) NOT NULL,

  --   asset      — what the business owns. Debit balance.
  --   liability  — what it owes. Credit balance.
  --   equity     — the owners' stake. Credit balance.
  --   income     — revenue. Credit balance.
  --   expense    — costs, including cost of sales. Debit balance.
  --
  -- THE TYPE DECIDES EVERYTHING DOWNSTREAM: which statement the account
  -- appears on (income and expense → P&L; the rest → balance sheet), whether
  -- it closes off at year end, and which side is its "normal" balance.
  account_type  ENUM('asset','liability','equity','income','expense') NOT NULL,

  -- Finer grouping WITHIN a type, for statement subtotals: current vs
  -- non-current assets, cost of sales vs operating expenses. Free text rather
  -- than an enum because every accountant groups slightly differently and a
  -- new subtotal should be data, not a migration.
  subtype       VARCHAR(40)  NULL,

  parent_id     INT UNSIGNED NULL,

  -- ── CONTROL ACCOUNTS ─────────────────────────────────────────────────
  --
  -- An account whose balance is OWNED by a subledger. Debtors control equals
  -- the sum of customers.balance; bank control equals a bank account's
  -- balance. Journals may not be posted to one by hand — the subledger posts
  -- it — because a manual entry would put the two permanently out of step with
  -- nothing to explain the difference.
  --
  --   NULL        — an ordinary account, freely postable
  --   debtors     — customer_transactions
  --   creditors   — supplier_transactions
  --   bank        — one bank_accounts row, named by control_ref_id
  --   stock       — products.qty_on_hand × cost
  --   vat_input / vat_output — the VAT control accounts
  control_type  ENUM('debtors','creditors','bank','stock','vat_input','vat_output') NULL,
  -- Which specific record this controls, where the type needs one: a bank
  -- control account belongs to exactly one bank_accounts row.
  control_ref_id INT UNSIGNED NULL,

  -- Whether journals may be posted here directly. FALSE on control accounts
  -- and on any header account that only exists to group its children.
  is_postable   BOOLEAN      NOT NULL DEFAULT TRUE,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,

  -- The running balance, signed by the DEBIT convention: positive means a net
  -- debit. Maintained by the posting code in the same transaction as the lines
  -- that move it, exactly as customers.balance is. reconcileAccountBalances()
  -- proves the promise held.
  balance       DECIMAL(16,4) NOT NULL DEFAULT 0.0000,

  sort_order    INT          NOT NULL DEFAULT 0,
  notes         VARCHAR(400) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_gl_code (account_code),
  KEY ix_gl_type (account_type, account_code),
  KEY ix_gl_control (control_type, control_ref_id),
  KEY ix_gl_parent (parent_id, sort_order),
  CONSTRAINT fk_gl_parent FOREIGN KEY (parent_id) REFERENCES gl_accounts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A journal: one balanced set of entries describing one event.
--
-- A batch exists rather than loose lines because "these entries belong
-- together and balance as a set" is the whole claim double entry makes. A line
-- on its own is meaningless; the batch is the unit that must sum to zero, the
-- unit that gets reversed, and the unit an auditor asks to see.
CREATE TABLE journal_batches (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  journal_number VARCHAR(32) NULL,      -- NULL until posted, as everywhere else
  journal_date  DATE         NOT NULL,

  --   draft   — being captured. Moves nothing.
  --   posted  — in the ledger. Balances have moved.
  --   void    — reversed. Kept, never deleted.
  status        ENUM('draft','posted','void') NOT NULL DEFAULT 'draft',

  -- What produced it. 'manual' is a human at the journal screen; everything
  -- else is a subledger event mirrored into the GL by glPosting.ts.
  --   sale | credit_note | grv | supplier_return | receipt | payment |
  --   expense | interest | write_off | opening | year_end | manual
  source        VARCHAR(24)  NOT NULL DEFAULT 'manual',
  -- The row in the source table, so a journal can be traced back to the
  -- document that caused it — and so a document can find its journal.
  source_doc_id INT UNSIGNED NULL,

  description   VARCHAR(255) NOT NULL,
  reference     VARCHAR(60)  NULL,

  -- The proof of balance, stored rather than recomputed. Both must be equal
  -- and both are written by the posting code from the lines it just inserted.
  -- A stored total that disagrees with its own lines is findable by a single
  -- query; a recomputed one hides the bug.
  total_debit   DECIMAL(16,4) NOT NULL DEFAULT 0.0000,
  total_credit  DECIMAL(16,4) NOT NULL DEFAULT 0.0000,

  -- The batch this one reverses.
  reverses_id   INT UNSIGNED NULL,

  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  posted_at     DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_journal_number (journal_number),
  KEY ix_journal_date (journal_date, id),
  KEY ix_journal_status (status, journal_date),
  -- "Which journal did this GRV produce" — asked from the document side.
  KEY ix_journal_source (source, source_doc_id),
  CONSTRAINT fk_journal_reverses FOREIGN KEY (reverses_id) REFERENCES journal_batches (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One side of one entry.
--
-- SIGN CONVENTION, stated once and relied on everywhere:
--   amount  positive = DEBIT, negative = CREDIT
--
-- One signed column rather than separate debit and credit columns. Two columns
-- means every aggregate is SUM(debit) - SUM(credit), every insert must decide
-- which column gets the zero, and a row with values in both is expressible and
-- meaningless. One signed column makes "does this batch balance" a plain
-- SUM() = 0 — which is the check the whole system rests on.
--
-- Debits are positive because that matches the account balance convention
-- above: an asset with a positive balance holds something, which is what a
-- non-accountant expects when they look at the number.
CREATE TABLE journal_lines (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id      INT UNSIGNED NOT NULL,
  line_number   SMALLINT UNSIGNED NOT NULL DEFAULT 1,

  account_id    INT UNSIGNED NOT NULL,
  -- Snapshotted, like every other document line here: renaming an account next
  -- year must not restate what a posted journal said.
  account_code  VARCHAR(16)  NULL,
  account_name  VARCHAR(120) NULL,

  amount        DECIMAL(16,4) NOT NULL,

  description   VARCHAR(190) NULL,
  -- Which department bore it, so a P&L can be run per department.
  department_id INT UNSIGNED NULL,

  -- Who this line is about, where it has a party. Lets the debtors control
  -- account be broken down by customer without joining back through the
  -- source document.
  customer_id   INT UNSIGNED NULL,
  supplier_id   INT UNSIGNED NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_jline_batch (batch_id, line_number),
  -- The account's own ledger, and every statement query.
  KEY ix_jline_account (account_id, id),
  KEY ix_jline_dept (department_id),
  KEY ix_jline_customer (customer_id),
  KEY ix_jline_supplier (supplier_id),
  -- CASCADE: a line has no meaning without its batch, and a posted batch is
  -- never deleted — it is reversed.
  CONSTRAINT fk_jline_batch FOREIGN KEY (batch_id) REFERENCES journal_batches (id) ON DELETE CASCADE,
  CONSTRAINT fk_jline_account FOREIGN KEY (account_id) REFERENCES gl_accounts (id) ON DELETE RESTRICT,
  CONSTRAINT fk_jline_dept FOREIGN KEY (department_id) REFERENCES departments (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which GL account a thing posts to.
--
-- The mapping layer between the subledgers and the ledger. Without it every
-- posting path would hard-code account codes, and a store that renumbers its
-- chart would need a code change.
--
-- Deliberately a KV table rather than columns on each source table: the set of
-- mappings grows (a new tender type, a new expense category) and each addition
-- would otherwise be a migration.
CREATE TABLE gl_mappings (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  --   sales_income      — where a sale's revenue goes, per department or default
  --   cost_of_sales     — where a sale's cost goes
  --   stock_control     — the stock asset account
  --   debtors_control   — customers
  --   creditors_control — suppliers
  --   vat_output        — VAT charged on sales
  --   vat_input         — VAT paid on purchases
  --   tender            — where a tender type's money lands, per tender
  --   expense_category  — where an expense category posts, per category
  --   bank_account      — the GL account for one bank_accounts row
  --   rounding          — cash rounding differences
  --   retained_earnings — where the year-end result closes to
  mapping_key   VARCHAR(40)  NOT NULL,
  -- The specific record this mapping is for, where the key needs one: a
  -- department id for sales_income, a tender_types id for tender. NULL is the
  -- DEFAULT mapping for that key, used when no specific one exists.
  ref_id        INT UNSIGNED NULL,

  account_id    INT UNSIGNED NOT NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One mapping per key+ref. MySQL treats NULLs as distinct in a unique index,
  -- so the default row is enforced in code — see setMapping().
  UNIQUE KEY uq_mapping (mapping_key, ref_id),
  KEY ix_mapping_account (account_id),
  CONSTRAINT fk_mapping_account FOREIGN KEY (account_id) REFERENCES gl_accounts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A closed financial year.
--
-- Year end does one irreversible-looking thing: it moves every income and
-- expense balance into retained earnings so the next year starts from zero.
-- Recording it as a row — rather than just posting the journal — is what makes
-- it reversible, and what stops it being run twice.
CREATE TABLE gl_year_ends (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  year_start    DATE         NOT NULL,
  year_end      DATE         NOT NULL,

  -- The closing journal. Reversing it reopens the year.
  batch_id      INT UNSIGNED NULL,

  -- What was closed off, for the record.
  total_income  DECIMAL(16,4) NOT NULL DEFAULT 0.0000,
  total_expense DECIMAL(16,4) NOT NULL DEFAULT 0.0000,
  net_result    DECIMAL(16,4) NOT NULL DEFAULT 0.0000,

  status        ENUM('closed','reopened') NOT NULL DEFAULT 'closed',
  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_year (year_start, year_end),
  CONSTRAINT fk_yearend_batch FOREIGN KEY (batch_id) REFERENCES journal_batches (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── A starting chart of accounts ─────────────────────────────────────────
--
-- Seeded so the ledger works on day one. Designing a chart of accounts from
-- nothing is the task that stops people using an accounting system at all, and
-- every row here can be renamed, renumbered or deactivated.
--
-- Control accounts are NOT postable: their balances are owned by the
-- subledgers that feed them, and a hand-written journal would put the two out
-- of step with nothing to explain the difference.

INSERT INTO gl_accounts (account_code, name, account_type, subtype, control_type, is_postable, sort_order) VALUES
  -- Assets
  ('1000', 'Bank and cash',            'asset', 'current_asset', NULL,        TRUE,  100),
  ('1100', 'Debtors control',          'asset', 'current_asset', 'debtors',   FALSE, 110),
  ('1200', 'Stock on hand',            'asset', 'current_asset', 'stock',     FALSE, 120),
  ('1300', 'VAT input',                'asset', 'current_asset', 'vat_input', FALSE, 130),
  ('1400', 'Deposits and prepayments', 'asset', 'current_asset', NULL,        TRUE,  140),
  ('1500', 'Equipment',                'asset', 'fixed_asset',   NULL,        TRUE,  200),
  ('1510', 'Equipment — depreciation', 'asset', 'fixed_asset',   NULL,        TRUE,  210),
  ('1600', 'Vehicles',                 'asset', 'fixed_asset',   NULL,        TRUE,  220),
  ('1610', 'Vehicles — depreciation',  'asset', 'fixed_asset',   NULL,        TRUE,  230),

  -- Liabilities
  ('2000', 'Creditors control',        'liability', 'current_liability', 'creditors',  FALSE, 300),
  ('2100', 'VAT output',               'liability', 'current_liability', 'vat_output', FALSE, 310),
  ('2200', 'Customer deposits',        'liability', 'current_liability', NULL,         TRUE,  320),
  ('2300', 'Salaries payable',         'liability', 'current_liability', NULL,         TRUE,  330),
  ('2400', 'Loans',                    'liability', 'long_term_liability', NULL,       TRUE,  400),

  -- Equity
  ('3000', 'Owner capital',            'equity', 'equity', NULL, TRUE, 500),
  ('3100', 'Owner drawings',           'equity', 'equity', NULL, TRUE, 510),
  -- Where the year-end result closes to. Never posted to by hand.
  ('3200', 'Retained earnings',        'equity', 'equity', NULL, TRUE, 520),

  -- Income
  ('4000', 'Sales',                    'income', 'revenue', NULL, TRUE, 600),
  ('4100', 'Sales returns',            'income', 'revenue', NULL, TRUE, 610),
  ('4200', 'Discounts allowed',        'income', 'revenue', NULL, TRUE, 620),
  ('4900', 'Other income',             'income', 'other_income', NULL, TRUE, 690),

  -- Cost of sales
  ('5000', 'Cost of sales',            'expense', 'cost_of_sales', NULL, TRUE, 700),
  ('5100', 'Stock adjustments',        'expense', 'cost_of_sales', NULL, TRUE, 710),
  ('5200', 'Freight in',               'expense', 'cost_of_sales', NULL, TRUE, 720),

  -- Operating expenses. These mirror the expense categories seeded in 042 —
  -- the codes are deliberately the same numbers, so mapping one to the other
  -- is obvious to whoever configures it.
  ('6000', 'Rent',                     'expense', 'operating', NULL, TRUE, 800),
  ('6010', 'Electricity and water',    'expense', 'operating', NULL, TRUE, 810),
  ('6020', 'Telephone and internet',   'expense', 'operating', NULL, TRUE, 820),
  ('6030', 'Salaries and wages',       'expense', 'operating', NULL, TRUE, 830),
  ('6040', 'Insurance',                'expense', 'operating', NULL, TRUE, 840),
  ('6050', 'Repairs and maintenance',  'expense', 'operating', NULL, TRUE, 850),
  ('6060', 'Motor vehicle expenses',   'expense', 'operating', NULL, TRUE, 860),
  ('6070', 'Fuel',                     'expense', 'operating', NULL, TRUE, 870),
  ('6080', 'Cleaning and consumables', 'expense', 'operating', NULL, TRUE, 880),
  ('6090', 'Printing and stationery',  'expense', 'operating', NULL, TRUE, 890),
  ('6100', 'Advertising and marketing','expense', 'operating', NULL, TRUE, 900),
  ('6110', 'Accounting and legal fees','expense', 'operating', NULL, TRUE, 910),
  ('6120', 'Security',                 'expense', 'operating', NULL, TRUE, 920),
  ('6130', 'Software and subscriptions','expense','operating', NULL, TRUE, 930),
  ('6140', 'Staff welfare and training','expense','operating', NULL, TRUE, 940),
  ('6150', 'Entertainment',            'expense', 'operating', NULL, TRUE, 950),
  ('6160', 'Travel and accommodation', 'expense', 'operating', NULL, TRUE, 960),
  ('6170', 'Licences and permits',     'expense', 'operating', NULL, TRUE, 970),
  ('6180', 'Depreciation',             'expense', 'operating', NULL, TRUE, 980),
  ('6900', 'Sundry expenses',          'expense', 'operating', NULL, TRUE, 990),

  -- Financial costs
  ('7000', 'Bank charges',             'expense', 'financial', NULL, TRUE, 1000),
  ('7010', 'Interest paid',            'expense', 'financial', NULL, TRUE, 1010),
  ('7020', 'Bad debts written off',    'expense', 'financial', NULL, TRUE, 1020),
  -- Cash rounding on till sales. Tiny, but it must land somewhere or the
  -- journal for a rounded sale will not balance.
  ('7030', 'Cash rounding',            'expense', 'financial', NULL, TRUE, 1030);

-- ── Default mappings ─────────────────────────────────────────────────────
--
-- The minimum set needed for the subledgers to post. Everything specific — a
-- department's own income account, a tender's own bank account — is configured
-- on the mapping screen and falls back to these.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'sales_income',      NULL, id FROM gl_accounts WHERE account_code = '4000'
UNION ALL SELECT 'sales_returns',     NULL, id FROM gl_accounts WHERE account_code = '4100'
UNION ALL SELECT 'cost_of_sales',     NULL, id FROM gl_accounts WHERE account_code = '5000'
UNION ALL SELECT 'stock_control',     NULL, id FROM gl_accounts WHERE account_code = '1200'
UNION ALL SELECT 'debtors_control',   NULL, id FROM gl_accounts WHERE account_code = '1100'
UNION ALL SELECT 'creditors_control', NULL, id FROM gl_accounts WHERE account_code = '2000'
UNION ALL SELECT 'vat_output',        NULL, id FROM gl_accounts WHERE account_code = '2100'
UNION ALL SELECT 'vat_input',         NULL, id FROM gl_accounts WHERE account_code = '1300'
UNION ALL SELECT 'tender',            NULL, id FROM gl_accounts WHERE account_code = '1000'
UNION ALL SELECT 'bank_account',      NULL, id FROM gl_accounts WHERE account_code = '1000'
UNION ALL SELECT 'expense_category',  NULL, id FROM gl_accounts WHERE account_code = '6900'
UNION ALL SELECT 'rounding',          NULL, id FROM gl_accounts WHERE account_code = '7030'
UNION ALL SELECT 'interest_received',  NULL, id FROM gl_accounts WHERE account_code = '4900'
UNION ALL SELECT 'bad_debts',         NULL, id FROM gl_accounts WHERE account_code = '7020'
UNION ALL SELECT 'retained_earnings', NULL, id FROM gl_accounts WHERE account_code = '3200';

-- Expense categories map to the GL account with the SAME trailing digits where
-- one exists (042's 5000 Freight in → 5200; 5000-series operating → 6000-series).
-- Done here rather than by hand because the seeds were designed to line up.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'expense_category', c.id, a.id
  FROM expense_categories c
  JOIN gl_accounts a
    ON a.account_code = CASE
         WHEN c.account_code = '4000' THEN '5200'   -- freight in
         WHEN c.account_code = '4010' THEN '5000'   -- subcontractors → cost of sales
         WHEN c.account_code = '6000' THEN '7000'   -- bank charges
         WHEN c.account_code = '6010' THEN '7010'   -- interest paid
         WHEN c.account_code = '7000' THEN '1500'   -- equipment (capital)
         WHEN c.account_code = '7010' THEN '1600'   -- vehicles (capital)
         -- 5000-5900 operating expenses shift to the 6000 series.
         WHEN c.account_code BETWEEN '5000' AND '5999'
           THEN CAST(CAST(c.account_code AS UNSIGNED) + 1000 AS CHAR)
         ELSE NULL
       END
 WHERE a.id IS NOT NULL;

-- The numbering sequence for manual journals.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period)
VALUES ('journal', 'JNL', 1, 6, 'none');
