-- The debtors and creditors sub-ledger — what MONEY did.
--
-- activity_log (011) records what PEOPLE did. These tables record what money
-- did, and the two are deliberately separate: "who put this account on hold"
-- and "what is this balance made of" are different questions, answered on
-- different tabs.
--
-- OPEN ITEM, not balance forward. Every debit carries the amount of itself that
-- is still unpaid (`amount_outstanding`), and payments are matched to specific
-- invoices through the allocations table. Balance-forward cannot answer "which
-- invoice is unpaid" — and its age analysis has to guess, applying payments
-- FIFO against the oldest debt, which ages a disputed withheld invoice as
-- current and a settled one as 90 days. A balance-forward STATEMENT is still
-- available: it is a rendering choice over open-item data, so nothing is lost.
--
-- SIGN CONVENTION, stated once and relied on everywhere:
--   customer_transactions.amount_signed  positive = the customer owes us more
--   supplier_transactions.amount_signed  positive = we owe the supplier more
-- An invoice is therefore positive on both sides; a payment is negative on
-- both. Every aggregate is then a plain SUM with no CASE on doc_type, which is
-- what stops two reports disagreeing.

CREATE TABLE customer_transactions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id    INT UNSIGNED NOT NULL,

  --   invoice      — a sale on account. Debit. Ages.
  --   credit_note  — goods returned or an overcharge corrected. Credit.
  --   payment      — money received. Credit.
  --   journal      — a manual adjustment: a write-off, a correction. Either.
  --   opening      — the balance brought in at go-live. Debit, ages by its own date.
  --   interest     — charged on overdue balances. Debit.
  doc_type       ENUM('invoice','credit_note','payment','journal','opening','interest') NOT NULL,

  -- The document's own number (INV000041) once sales issues them. Free text
  -- for now because payments and journals are numbered by hand, and an opening
  -- balance has no document at all.
  doc_number     VARCHAR(32)  NULL,
  -- DATE, not DATETIME: an invoice belongs to a day, and the age analysis
  -- counts days. dateStrings:['DATE'] in db.ts means this arrives as a string.
  doc_date       DATE         NOT NULL,
  -- doc_date + the customer's terms at the time of posting. Snapshotted rather
  -- than derived, so changing an account's terms next year does not silently
  -- re-age every invoice already issued. NULL for credits and payments, which
  -- are not themselves due.
  due_date       DATE         NULL,

  -- Their reference: a remittance number, a deposit reference, a PO number.
  reference      VARCHAR(60)  NULL,
  description    VARCHAR(190) NULL,

  -- The VAT split, for the VAT report. Zero on a payment, which carries none.
  amount_gross   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  amount_vat     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  amount_net     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- The figure that moves the balance, signed per the convention above. Every
  -- balance and every aging bucket is built from this column alone.
  amount_signed  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- How much of this row is still unsettled, same sign as amount_signed.
  -- A debit starts at its full value and falls to zero as payments allocate to
  -- it; a credit starts at its full (negative) value and rises to zero as it is
  -- applied. Zero means fully matched. Maintained ONLY by the allocation code,
  -- inside the same transaction as the allocation row.
  amount_outstanding DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- What produced this row: 'sale' | 'manual' | 'import' | 'interest_run'.
  -- Kept so an import can be identified and undone, and so a manual journal is
  -- visibly distinct from something the till posted.
  source         VARCHAR(24)  NOT NULL DEFAULT 'manual',
  -- sales_documents.id once sales exists. No FK yet — that table does not
  -- exist; adding it later is an ALTER, whereas guessing the name now is a
  -- migration that fails.
  source_doc_id  INT UNSIGNED NULL,

  -- The row this one reverses, for a voided or credited document.
  reverses_id    INT UNSIGNED NULL,

  user_id        INT UNSIGNED NULL,      -- cp2_users.id, control DB, no FK
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The account's Transactions tab and its running balance.
  KEY ix_ctxn_customer_date (customer_id, doc_date, id),
  -- The age analysis: unsettled debits, oldest first.
  KEY ix_ctxn_outstanding (customer_id, due_date, amount_outstanding),
  KEY ix_ctxn_doc (doc_type, doc_number),
  KEY ix_ctxn_date (doc_date),
  KEY ix_ctxn_source (source, source_doc_id),
  -- RESTRICT, not CASCADE: deleting a customer must never silently delete
  -- their financial history. deleteCustomer() already refuses on a non-zero
  -- balance; this is the database making the same promise.
  CONSTRAINT fk_ctxn_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_ctxn_reverses FOREIGN KEY (reverses_id) REFERENCES customer_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which credit settled which debit, and by how much.
--
-- This table IS the open-item mechanism. Without it you know an account is
-- R4 000 short but not which invoice is unpaid, which is exactly the question a
-- customer disputes and an age analysis must answer.
CREATE TABLE customer_allocations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- The debit being settled (invoice, opening balance, interest).
  debit_txn_id  INT UNSIGNED NOT NULL,
  -- The credit doing the settling (payment, credit note, journal).
  credit_txn_id INT UNSIGNED NOT NULL,
  -- Always POSITIVE: the magnitude matched. The direction is implied by which
  -- side each row sits on, so a signed amount here would be a second, redundant
  -- source of truth that could disagree.
  amount        DECIMAL(12,4) NOT NULL,

  -- When the match was made, which is NOT the date of either document — a
  -- January invoice can be settled in March. An as-at age analysis has to roll
  -- back allocations made after the as-at date, and this is the column that
  -- makes that possible.
  allocated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- One credit may settle a debit only once; a bigger match is an UPDATE of the
  -- existing row, not a second one. Keeps "how much of invoice X did payment Y
  -- cover" a single lookup.
  UNIQUE KEY uq_alloc_pair (debit_txn_id, credit_txn_id),
  KEY ix_alloc_credit (credit_txn_id),
  KEY ix_alloc_when (allocated_at),
  -- CASCADE: an allocation describes a relationship between two rows and has
  -- no meaning once either is gone. Transactions are themselves RESTRICTed
  -- against customer deletion, so this cannot orphan history.
  CONSTRAINT fk_alloc_debit  FOREIGN KEY (debit_txn_id)  REFERENCES customer_transactions (id) ON DELETE CASCADE,
  CONSTRAINT fk_alloc_credit FOREIGN KEY (credit_txn_id) REFERENCES customer_transactions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Creditors ──────────────────────────────────────────────────────────
-- The mirror. Separate tables rather than one polymorphic ledger: the FKs point
-- at different masters, and a single table would need a nullable customer_id
-- AND a nullable supplier_id with a check constraint, plus a party filter on
-- every query that could be forgotten.

CREATE TABLE supplier_transactions (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  supplier_id    INT UNSIGNED NOT NULL,
  -- 'invoice' here is THEIR invoice to us; 'payment' is us paying them.
  doc_type       ENUM('invoice','credit_note','payment','journal','opening','interest') NOT NULL,
  doc_number     VARCHAR(32)  NULL,
  doc_date       DATE         NOT NULL,
  due_date       DATE         NULL,
  reference      VARCHAR(60)  NULL,
  description    VARCHAR(190) NULL,
  amount_gross   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  amount_vat     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  amount_net     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Positive = we owe them more.
  amount_signed  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  amount_outstanding DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  source         VARCHAR(24)  NOT NULL DEFAULT 'manual',
  source_doc_id  INT UNSIGNED NULL,
  reverses_id    INT UNSIGNED NULL,
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_stxn_supplier_date (supplier_id, doc_date, id),
  KEY ix_stxn_outstanding (supplier_id, due_date, amount_outstanding),
  KEY ix_stxn_doc (doc_type, doc_number),
  KEY ix_stxn_date (doc_date),
  KEY ix_stxn_source (source, source_doc_id),
  CONSTRAINT fk_stxn_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_stxn_reverses FOREIGN KEY (reverses_id) REFERENCES supplier_transactions (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE supplier_allocations (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  debit_txn_id  INT UNSIGNED NOT NULL,
  credit_txn_id INT UNSIGNED NOT NULL,
  amount        DECIMAL(12,4) NOT NULL,
  allocated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uq_salloc_pair (debit_txn_id, credit_txn_id),
  KEY ix_salloc_credit (credit_txn_id),
  KEY ix_salloc_when (allocated_at),
  CONSTRAINT fk_salloc_debit  FOREIGN KEY (debit_txn_id)  REFERENCES supplier_transactions (id) ON DELETE CASCADE,
  CONSTRAINT fk_salloc_credit FOREIGN KEY (credit_txn_id) REFERENCES supplier_transactions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
