-- Four things the sub-ledger was designed for but never given: interest on
-- overdue debtors, settlement discount on creditors, period locking, and a
-- write-off with a reason attached.
--
-- 014 already reserved doc_type 'interest' and anticipated source
-- 'interest_run'. This migration builds what fills them.

-- ── Interest ─────────────────────────────────────────────────────────────
--
-- Charging interest is a decision per account, not a system-wide switch: most
-- accounts never attract it, a few are on a signed agreement that specifies a
-- rate, and charging the wrong one is a legal problem rather than a rounding
-- one. So the rate lives on the customer, defaulting to nothing.
--
-- NCA note: interest on a trade account is capped and must be agreed in
-- writing. The default of 0 and `interest_enabled = FALSE` means a site that
-- never configures this never charges anything — the same conservative
-- default 024 took for lay-by cancellation fees, for the same reason.

ALTER TABLE customers
  -- Annual nominal rate, e.g. 15.5000 for 15.5% per year. Annual rather than
  -- monthly because that is how an agreement states it and how the NCA caps
  -- it; the run divides down to the period it is charging for.
  ADD COLUMN interest_rate_pct DECIMAL(7,4) NOT NULL DEFAULT 0.0000 AFTER credit_limit,
  -- Explicit opt-in, separate from the rate. A rate of 0 with the flag on is a
  -- deliberate "agreed, but currently nil"; the flag off means the account was
  -- never signed up, and those must stay distinguishable.
  ADD COLUMN interest_enabled BOOLEAN NOT NULL DEFAULT FALSE AFTER interest_rate_pct,
  -- Days past due before interest begins. A store that allows a week's grace
  -- beyond terms sets 7 here rather than lengthening the terms, which would
  -- also move the age analysis.
  ADD COLUMN interest_grace_days SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER interest_enabled;

-- The same three on the group, as defaults for accounts that inherit.
ALTER TABLE customer_groups
  ADD COLUMN default_interest_rate_pct DECIMAL(7,4) NOT NULL DEFAULT 0.0000,
  ADD COLUMN default_interest_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN default_interest_grace_days SMALLINT UNSIGNED NOT NULL DEFAULT 0;

-- An interest run, shaped like a statement run: proposed, reviewed, posted.
--
-- Review is not optional here. Interest is the charge most likely to be
-- disputed and least likely to be noticed before it goes out, so the run sits
-- as a draft showing exactly what each account will be charged and on what,
-- and posts only when someone says so.
CREATE TABLE interest_runs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Interest is charged on balances overdue AS AT this date, for the period
  -- ending here. Both stored: the run is reproducible, and a re-run of the
  -- same month must not silently use today's balances.
  as_at_date     DATE         NOT NULL,
  -- The window interest accrued over. Usually a calendar month.
  period_from    DATE         NOT NULL,
  period_to      DATE         NOT NULL,

  status         ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',

  -- What the run will charge in total, and to how many accounts. Frozen at
  -- proposal so the review screen and the posting agree.
  total_amount   DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  account_count  INT UNSIGNED NOT NULL DEFAULT 0,
  posted_count   INT UNSIGNED NOT NULL DEFAULT 0,

  -- Below this, interest is not worth the argument or the postage. Applied per
  -- account at proposal time; stored so the threshold used is visible later.
  minimum_charge DECIMAL(10,4) NOT NULL DEFAULT 0.0000,

  notes          VARCHAR(400) NULL,
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  posted_at      DATETIME     NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_irun_status (status, as_at_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One account's interest, with the workings kept.
--
-- The workings are the point. "Why am I being charged R47.32" is the first
-- question every interest charge produces, and an answer of "the system
-- calculated it" loses the customer. Base, rate, days and the resulting figure
-- are all stored so the screen can show the arithmetic.
CREATE TABLE interest_run_items (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id         INT UNSIGNED NOT NULL,
  customer_id    INT UNSIGNED NOT NULL,
  customer_code  VARCHAR(32)  NOT NULL,
  customer_name  VARCHAR(190) NOT NULL,

  -- The overdue amount interest was charged on, past the grace period.
  base_amount    DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  -- The rate and span actually applied to this account, snapshotted: changing
  -- the customer's rate next month must not re-explain last month's charge.
  rate_pct       DECIMAL(7,4)  NOT NULL DEFAULT 0.0000,
  days           SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  --   pending  — proposed, not yet charged
  --   posted   — a customer_transactions row exists
  --   skipped  — below the minimum, or the account opted out
  status         ENUM('pending','posted','skipped') NOT NULL DEFAULT 'pending',
  skip_reason    VARCHAR(190) NULL,

  -- The interest transaction this produced. NULL until posted.
  transaction_id INT UNSIGNED NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_iitem_run (run_id, customer_name),
  KEY ix_iitem_customer (customer_id),
  CONSTRAINT fk_iitem_run FOREIGN KEY (run_id) REFERENCES interest_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_iitem_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_iitem_txn FOREIGN KEY (transaction_id) REFERENCES customer_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settlement discount ──────────────────────────────────────────────────
--
-- "2/10 net 30": pay within 10 days and take 2% off, otherwise the full amount
-- in 30. The terms are already on the supplier's invoice; without them here
-- the system cannot tell anyone that paying six invoices by Thursday saves
-- R4 200 — which is the single most valuable thing a creditors ledger knows.

ALTER TABLE suppliers
  -- Pay within this many days of the invoice date to earn the discount.
  ADD COLUMN settlement_discount_days SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER payment_terms_days,
  -- The percentage earned. Both must be non-zero for a discount to exist.
  ADD COLUMN settlement_discount_pct DECIMAL(6,4) NOT NULL DEFAULT 0.0000 AFTER settlement_discount_days;

-- Discount actually taken on a payment run item, so the saving is reportable
-- rather than merely predicted.
--
-- The discount is a CREDIT NOTE on the supplier's account, not a smaller
-- payment: the invoice was for the full amount and must settle in full, or the
-- open-item ledger is left with pennies outstanding on every discounted
-- invoice forever. discount_txn_id points at that credit note.
ALTER TABLE supplier_payment_items
  ADD COLUMN discount_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER amount,
  ADD COLUMN discount_txn_id INT UNSIGNED NULL AFTER transaction_id,
  ADD CONSTRAINT fk_spitem_disc FOREIGN KEY (discount_txn_id)
      REFERENCES supplier_transactions (id) ON DELETE SET NULL;

-- Per-invoice, so a remittance can show the discount line by line.
ALTER TABLE supplier_payment_allocations
  ADD COLUMN discount_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER amount;

-- ── Period locking ───────────────────────────────────────────────────────
--
-- settings.vat_period_locked_to already locks everything up to one date, and
-- sales checks it. That is the right idea with two limits: it cannot express
-- "February is closed but March is open", and it says nothing about WHO closed
-- a period or when — the first question after "why can't I post this".
--
-- This table supersedes it for new code. The setting stays as the fallback so
-- existing sales checks keep working; isPeriodLocked() consults both.
CREATE TABLE period_locks (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Inclusive span. A month is the usual unit but nothing requires it.
  period_from    DATE         NOT NULL,
  period_to      DATE         NOT NULL,

  --   soft — posting warns but is allowed, for a period being finalised
  --   hard — posting is refused outright, for a period already declared
  -- Soft exists because the week between "we think it is closed" and "the
  -- return is filed" is real, and a hard lock during it just gets unlocked.
  lock_type      ENUM('soft','hard') NOT NULL DEFAULT 'hard',

  -- What it covers. 'all' is the common case; the narrower scopes let a VAT
  -- period close while stock adjustments continue.
  scope          ENUM('all','sales','purchases','ledger','stock') NOT NULL DEFAULT 'all',

  reason         VARCHAR(190) NULL,

  -- An unlocked row is kept rather than deleted: "who reopened February, and
  -- when" is exactly the question an auditor asks, and a DELETE cannot answer.
  locked_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_by      VARCHAR(120) NOT NULL DEFAULT '',
  unlocked_at    DATETIME     NULL,
  unlocked_by    VARCHAR(120) NULL,
  unlock_reason  VARCHAR(190) NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- The hot query: "is this date locked", asked on every posting path.
  KEY ix_lock_span (unlocked_at, period_from, period_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Write-offs ───────────────────────────────────────────────────────────
--
-- Mechanically a write-off is a journal, and 014 can already post one. What it
-- cannot do is answer "how much bad debt did we write off last year, who
-- approved it, and why" — which is what an auditor asks and what a policy
-- threshold needs. So the journal still carries the money; this row carries
-- the story, and points at it.
CREATE TABLE debt_write_offs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id    INT UNSIGNED NOT NULL,

  -- The journal that actually moved the balance. The money lives there; this
  -- table never duplicates it.
  transaction_id INT UNSIGNED NULL,

  amount         DECIMAL(12,4) NOT NULL,
  write_off_date DATE          NOT NULL,

  --   bad_debt   — the customer will not pay
  --   small_bal  — a few cents left after a rounding difference
  --   dispute    — written off to settle an argument
  --   goodwill   — deliberate concession
  --   other      — reason free text carries it
  category       ENUM('bad_debt','small_bal','dispute','goodwill','other') NOT NULL DEFAULT 'bad_debt',
  reason         VARCHAR(400) NOT NULL,

  -- Above the policy threshold a second person must agree. Both names are
  -- stored: "approved by" being equal to "requested by" is itself a finding.
  requires_approval BOOLEAN  NOT NULL DEFAULT FALSE,
  approved_by    VARCHAR(120) NULL,
  approved_at    DATETIME     NULL,

  --   pending  — waiting for approval; nothing posted yet
  --   posted   — the journal exists and the balance has moved
  --   rejected — declined; kept so the request is on record
  status         ENUM('pending','posted','rejected') NOT NULL DEFAULT 'pending',

  -- If the customer later pays, the write-off is reversed rather than deleted.
  recovered_at   DATETIME     NULL,
  recovered_txn_id INT UNSIGNED NULL,

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_wo_customer (customer_id, write_off_date),
  KEY ix_wo_status (status, write_off_date),
  CONSTRAINT fk_wo_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_wo_txn FOREIGN KEY (transaction_id) REFERENCES customer_transactions (id) ON DELETE SET NULL,
  CONSTRAINT fk_wo_recovered FOREIGN KEY (recovered_txn_id) REFERENCES customer_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
