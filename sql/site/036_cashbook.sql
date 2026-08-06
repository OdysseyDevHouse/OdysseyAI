-- The cashbook — what the MONEY did, as opposed to what the LEDGERS say.
--
-- 014 records that a customer paid and that we owe a supplier less. Neither
-- records that money arrived in a bank account, and until it does the system
-- cannot answer the two questions a business actually runs on: "what is our
-- cash position" and "has this payment cleared".
--
-- ── WHY THIS IS A SEPARATE LEDGER ────────────────────────────────────────
--
-- A customer payment and a bank deposit are DIFFERENT EVENTS that usually,
-- but not always, correspond. A cheque is received on Monday and clears on
-- Thursday. A card batch settles net of fees two days later. A customer's EFT
-- lands before anyone knows which account it belongs to. Folding the two into
-- one row forces a choice of date and loses the other, and the difference
-- between them IS the bank reconciliation.
--
-- So: customer_transactions says the debtor paid. bank_transactions says the
-- bank received. cashbook_links ties them together, and anything unlinked on
-- either side is a reconciling item. That is the whole design.
--
-- ── SIGN CONVENTION ──────────────────────────────────────────────────────
--
--   bank_transactions.amount_signed  positive = money INTO the account
--
-- Stated once, relied on everywhere, matching 014's style. A receipt is
-- positive, a payment negative, and a balance is a plain SUM with no CASE.

CREATE TABLE bank_accounts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Short handle used on screens and in imports: 'FNB-CHQ', 'PETTY'.
  code           VARCHAR(24)  NOT NULL,
  name           VARCHAR(120) NOT NULL,

  --   bank  — a real account at a bank, reconciled against a statement
  --   cash  — a till float or petty cash tin, counted rather than reconciled
  --   card  — a card acquirer's settlement account, where fees are deducted
  -- The type decides whether a reconciliation screen makes sense for it, not
  -- how the money is stored: all three are just signed rows.
  account_type   ENUM('bank','cash','card') NOT NULL DEFAULT 'bank',

  bank_name      VARCHAR(120) NULL,
  account_number VARCHAR(40)  NULL,
  branch_code    VARCHAR(20)  NULL,

  -- What the account held at go-live, before any transaction was captured.
  -- The running balance is this plus SUM(amount_signed) — the same
  -- stored-plus-movements shape customers.balance uses, for the same reason:
  -- a balance nobody has to recompute is a balance a list screen can sort by.
  opening_balance DECIMAL(14,4) NOT NULL DEFAULT 0.0000,
  opening_date    DATE          NULL,

  -- Maintained by the posting code, in the same transaction as the row it
  -- moves. reconcileBankBalances() proves the promise held, exactly as
  -- reconcileBalances() does for debtors.
  balance        DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  -- The last date a completed reconciliation covered, and what the bank said
  -- the balance was on that date. Together they are the starting point of the
  -- next reconciliation, and the honest answer to "when was this last checked".
  last_reconciled_date DATE          NULL,
  last_reconciled_balance DECIMAL(14,4) NULL,

  -- Where till takings are banked by default, and which account a supplier
  -- payment run draws on. Exactly one of each may be set; enforced in code
  -- rather than by a constraint, because "unset it on the others" is an UPDATE
  -- the database cannot express as a CHECK.
  is_default_receipts BOOLEAN NOT NULL DEFAULT FALSE,
  is_default_payments BOOLEAN NOT NULL DEFAULT FALSE,

  status         ENUM('active','closed') NOT NULL DEFAULT 'active',
  sort_order     INT UNSIGNED NOT NULL DEFAULT 0,
  notes          VARCHAR(400) NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_bank_code (code),
  KEY ix_bank_status (status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every movement of money through an account.
--
-- Rows arrive three ways, and `source` says which:
--   'manual'      — someone captured it
--   'import'      — read off a bank statement file
--   'receipt'     — posted alongside a customer payment
--   'payment_run' — posted alongside a supplier payment run
--   'cashup'      — a till's takings banked
--   'transfer'    — the other leg of an account-to-account move
--
-- An imported row and a captured row for the SAME movement is the normal case,
-- not an error: one is what we think happened, the other is what the bank says
-- happened. Matching them is reconciliation; see cashbook_links.
CREATE TABLE bank_transactions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_account_id INT UNSIGNED NOT NULL,

  -- The date the money moved, per whoever is telling us. For an imported row
  -- this is the bank's date, which is the one a reconciliation must use.
  txn_date       DATE         NOT NULL,

  -- Positive into the account, negative out. See the convention above.
  amount_signed  DECIMAL(14,4) NOT NULL,

  -- What the bank statement called it, verbatim. Kept unmodified because it is
  -- the evidence: it is what a matching rule reads, and what someone squints at
  -- when a match looks wrong.
  description    VARCHAR(255) NULL,
  -- Their reference — a deposit slip number, an EFT beneficiary reference.
  -- This is the field that most often identifies WHICH customer paid.
  reference      VARCHAR(120) NULL,

  --   unreconciled — captured or imported, not yet agreed to the other side
  --   reconciled   — matched, and included in a completed reconciliation
  --   void         — captured in error; kept, never deleted, per 014's rule
  status         ENUM('unreconciled','reconciled','void') NOT NULL DEFAULT 'unreconciled',

  -- Which reconciliation finalised this row. NULL until one does. Set rather
  -- than derived so "what was on the March statement" survives later matching.
  reconciliation_id INT UNSIGNED NULL,

  source         VARCHAR(24)  NOT NULL DEFAULT 'manual',
  -- The row in ANOTHER table that produced this one — a shift, a payment run.
  -- No FK: it points at different tables depending on source, exactly as
  -- customer_transactions.source_doc_id does.
  source_doc_id  INT UNSIGNED NULL,

  -- Set on imported rows only. The bank's own unique id for the line where the
  -- format provides one (OFX FITID), otherwise a hash of the line's contents.
  -- This is what stops importing the same statement twice from duplicating
  -- every row — see uq_bank_import below.
  import_key     VARCHAR(120) NULL,
  import_batch_id INT UNSIGNED NULL,

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The account's transaction list, and its running balance.
  KEY ix_btxn_account_date (bank_account_id, txn_date, id),
  -- The reconciliation screen: what is still outstanding on this account.
  KEY ix_btxn_unrec (bank_account_id, status, txn_date),
  KEY ix_btxn_source (source, source_doc_id),
  KEY ix_btxn_recon (reconciliation_id),
  -- Re-importing an overlapping statement must be a no-op, not a duplicate.
  -- Scoped to the account because two banks can hand out the same FITID.
  UNIQUE KEY uq_bank_import (bank_account_id, import_key),
  CONSTRAINT fk_btxn_account FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which bank movement corresponds to which sub-ledger transaction.
--
-- THIS TABLE IS THE RECONCILIATION. A bank row with no link is money the bank
-- has that the ledgers do not explain; a ledger payment with no link is money
-- we think we have that the bank has not confirmed. Both lists are produced by
-- a LEFT JOIN against this table, and both are exactly what a reconciliation
-- screen must show.
--
-- Deliberately many-to-many. One deposit routinely settles three customers'
-- payments, and one customer's debit order can be split across two bank lines
-- when it bounces and re-presents. A nullable FK on either side could express
-- neither.
CREATE TABLE cashbook_links (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_txn_id    INT UNSIGNED NOT NULL,

  -- Exactly ONE of these two is set. Which one says whether this is money from
  -- a customer or money to a supplier. Enforced in code: MySQL 5.7 has no
  -- usable CHECK constraint, and the alternative — a polymorphic party_type
  -- column — makes every join conditional.
  customer_txn_id INT UNSIGNED NULL,
  supplier_txn_id INT UNSIGNED NULL,

  -- Always POSITIVE, like customer_allocations.amount, for the same reason:
  -- the direction is already implied by the rows being linked, and a second
  -- source of truth for it is a second thing that can disagree.
  amount         DECIMAL(14,4) NOT NULL,

  -- How the link was made: 'auto' by the matcher, 'manual' by a person.
  -- Kept so a suspicious reconciliation can be filtered to just the guesses.
  match_type     ENUM('auto','manual') NOT NULL DEFAULT 'manual',
  -- 0-100. What the matcher thought of its own guess; 100 for a manual link.
  -- Surfaced on screen so a 62% match is visibly different from a certain one.
  confidence     TINYINT UNSIGNED NOT NULL DEFAULT 100,

  linked_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  KEY ix_link_bank (bank_txn_id),
  -- A given sub-ledger payment may be linked once only; a bigger match is an
  -- UPDATE, mirroring uq_alloc_pair in 014.
  UNIQUE KEY uq_link_customer (bank_txn_id, customer_txn_id),
  UNIQUE KEY uq_link_supplier (bank_txn_id, supplier_txn_id),
  KEY ix_link_ctxn (customer_txn_id),
  KEY ix_link_stxn (supplier_txn_id),
  CONSTRAINT fk_link_bank FOREIGN KEY (bank_txn_id) REFERENCES bank_transactions (id) ON DELETE CASCADE,
  CONSTRAINT fk_link_ctxn FOREIGN KEY (customer_txn_id) REFERENCES customer_transactions (id) ON DELETE CASCADE,
  CONSTRAINT fk_link_stxn FOREIGN KEY (supplier_txn_id) REFERENCES supplier_transactions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A completed bank reconciliation: "on this date, the bank said X, we said Y,
-- and here is why they differ."
--
-- Stored rather than recomputed because the answer CHANGES. A transaction
-- captured next week with last month's date would silently alter a
-- reconciliation that was correct when it was signed off. Freezing the figures
-- is what makes it evidence.
CREATE TABLE bank_reconciliations (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_account_id INT UNSIGNED NOT NULL,

  -- The statement being reconciled to.
  statement_date  DATE          NOT NULL,
  statement_balance DECIMAL(14,4) NOT NULL,

  -- What our books said on that date, at the moment of sign-off.
  book_balance    DECIMAL(14,4) NOT NULL,

  -- Money we have recorded that the bank has not yet: uncleared payments and
  -- deposits in transit. book + these = statement, when it balances.
  unreconciled_total DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  -- statement_balance - book_balance - unreconciled_total. Zero when it
  -- reconciles. Stored so an out-of-balance sign-off is visible in the list
  -- rather than only inside the screen.
  difference      DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  --   draft     — being worked on; matches are being made
  --   completed — signed off; its rows are frozen as reconciled
  status          ENUM('draft','completed') NOT NULL DEFAULT 'draft',

  matched_count   INT UNSIGNED NOT NULL DEFAULT 0,
  notes           VARCHAR(400) NULL,

  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',
  completed_at    DATETIME     NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_recon_account (bank_account_id, statement_date),
  CONSTRAINT fk_recon_account FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One statement import, so it can be identified and undone.
--
-- Imports go wrong in a specific way: the wrong account is chosen, or a date
-- format is misread and every row lands in the wrong month. Both are only
-- obvious afterwards, which makes "undo that import" a requirement rather than
-- a nicety — and that needs the batch to be a thing with an id.
CREATE TABLE bank_import_batches (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  bank_account_id INT UNSIGNED NOT NULL,

  filename       VARCHAR(255) NULL,
  format         ENUM('csv','ofx') NOT NULL DEFAULT 'csv',

  -- The span the file covered, read from the rows themselves. Shown before
  -- committing, because "this file is for February" is the check that catches
  -- the wrong file being picked.
  period_from    DATE         NULL,
  period_to      DATE         NULL,

  row_count      INT UNSIGNED NOT NULL DEFAULT 0,
  imported_count INT UNSIGNED NOT NULL DEFAULT 0,
  -- Rows already present by import_key. A high number here is the signal that
  -- an overlapping statement was re-imported, which is normal and safe.
  duplicate_count INT UNSIGNED NOT NULL DEFAULT 0,
  -- Rows the matcher linked without being asked.
  auto_matched_count INT UNSIGNED NOT NULL DEFAULT 0,

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_batch_account (bank_account_id, created_at),
  CONSTRAINT fk_batch_account FOREIGN KEY (bank_account_id) REFERENCES bank_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The FK from a bank row back to the reconciliation that froze it. Added after
-- both tables exist, because each references the other.
ALTER TABLE bank_transactions
  ADD CONSTRAINT fk_btxn_recon FOREIGN KEY (reconciliation_id)
      REFERENCES bank_reconciliations (id) ON DELETE SET NULL;

ALTER TABLE bank_transactions
  ADD CONSTRAINT fk_btxn_batch FOREIGN KEY (import_batch_id)
      REFERENCES bank_import_batches (id) ON DELETE SET NULL;

-- A default cash account, so a fresh site can bank a cash-up without first
-- visiting a setup screen. Named generically because the store will rename it.
INSERT INTO bank_accounts (code, name, account_type, is_default_receipts, sort_order)
VALUES ('CASH', 'Cash on hand', 'cash', TRUE, 10);
