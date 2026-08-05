-- Payment runs — paying suppliers.
--
-- The mirror of a statement run, and deliberately a DIFFERENT workflow rather
-- than the same one pointed the other way. A statement run says "here is what
-- you owe us" to many customers at once; a payment run says "here is what we
-- are paying you, against these invoices" — and the second half of that
-- sentence is the part that matters.
--
-- ── WHY THE ALLOCATION IS THE POINT ──────────────────────────────────────
--
-- A supplier who receives R14 320.55 with no explanation has to guess which of
-- their invoices it settles, and will guess differently from us. That
-- disagreement is what a remittance advice exists to prevent, which is why a
-- payment run records WHICH invoices each payment covers rather than just a
-- total per supplier.
--
-- The allocation itself lives in supplier_allocations, exactly as it does on
-- the debtors side. This table is the batch that produced it.

CREATE TABLE supplier_payment_runs (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The date the money leaves. Distinct from created_at: a run is usually
  -- prepared the day before it is released to the bank.
  payment_date  DATE         NOT NULL,
  -- Free text, because it is whatever the bank calls the batch.
  reference     VARCHAR(60)  NULL,

  --   draft     — being prepared; nothing has been paid
  --   posted    — payments posted to the ledger and allocated
  --   cancelled — abandoned before posting
  status        ENUM('draft','posted','cancelled') NOT NULL DEFAULT 'draft',

  total_amount  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  supplier_count INT UNSIGNED NOT NULL DEFAULT 0,

  user_id       INT UNSIGNED NULL,      -- cp2_users.id, control DB, no FK
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  posted_at     DATETIME     NULL,
  notes         VARCHAR(400) NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_prun_status (status, payment_date),
  KEY ix_prun_date (payment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per supplier being paid in the run.
CREATE TABLE supplier_payment_items (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id         INT UNSIGNED NOT NULL,
  supplier_id    INT UNSIGNED NOT NULL,
  supplier_code  VARCHAR(32)  NOT NULL,   -- snapshots, as everywhere else
  supplier_name  VARCHAR(160) NOT NULL,
  email          VARCHAR(190) NULL,

  amount         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The ledger row this created, once posted. Lets the remittance be rebuilt
  -- from the payment rather than recomputed from a moving balance.
  transaction_id INT UNSIGNED NULL,

  -- Whether the remittance advice reached them. Separate from the payment
  -- itself: the money can be sent successfully and the email still bounce.
  remittance_status ENUM('none','queued','sent','failed') NOT NULL DEFAULT 'none',
  remittance_error  VARCHAR(400) NULL,
  remittance_sent_at DATETIME    NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One line per supplier per run: paying the same supplier twice in one batch
  -- would produce two payments the bank cannot tell apart.
  UNIQUE KEY uq_pitem_run_supplier (run_id, supplier_id),
  KEY ix_pitem_supplier (supplier_id),
  CONSTRAINT fk_pitem_run      FOREIGN KEY (run_id)      REFERENCES supplier_payment_runs (id) ON DELETE CASCADE,
  -- RESTRICT: a supplier that has been paid is not deletable.
  CONSTRAINT fk_pitem_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which invoices each payment settles.
--
-- Captured BEFORE posting, so the remittance can be shown for review, and used
-- to drive the actual allocation when the run is posted. Without this the run
-- would have to guess at posting time, and a guess is exactly what the
-- remittance exists to replace.
CREATE TABLE supplier_payment_allocations (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id      INT UNSIGNED NOT NULL,
  -- The supplier invoice being settled.
  txn_id       INT UNSIGNED NOT NULL,
  -- Their invoice number, snapshotted: it is what appears on the remittance
  -- and what they will look for on their own system.
  doc_number   VARCHAR(32)  NULL,
  doc_date     DATE         NULL,
  -- What the invoice was for, and what this run is putting against it. A
  -- part-payment is normal, so these are not the same figure.
  doc_amount   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  amount       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_palloc_item_txn (item_id, txn_id),
  KEY ix_palloc_txn (txn_id),
  CONSTRAINT fk_palloc_item FOREIGN KEY (item_id) REFERENCES supplier_payment_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_palloc_txn  FOREIGN KEY (txn_id)  REFERENCES supplier_transactions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
