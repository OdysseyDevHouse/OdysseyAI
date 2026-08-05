-- Statement runs.
--
-- Sending 200 statements cannot happen inside a request: the connection would
-- time out somewhere in the middle, with no way to know which ones went. So a
-- run is a QUEUE — rows created up front, worked through afterwards, each
-- carrying its own outcome.
--
-- That shape is what makes the two things anyone actually asks for possible:
--
--   "Did Harbour Cafe get their statement?"  — one row, one status, one
--   timestamp, and the closing balance as it stood when it was sent.
--
--   "Send the six that failed again."        — filter the run, retry those,
--   and do not re-send the 194 that worked.
--
-- The closing balance is FROZEN on each item. A statement is a snapshot of a
-- moving figure, and "what did we tell them they owed" must stay answerable
-- after they have paid.

CREATE TABLE customer_statement_runs (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- What the statements cover. Stored so a re-send reproduces the same
  -- document rather than a fresher one.
  period_from   DATE         NOT NULL,
  period_to     DATE         NOT NULL,
  -- 'open-item' lists what is still unpaid; 'activity' lists every movement in
  -- the period. Both are renderings over the same ledger.
  format        ENUM('open-item','activity') NOT NULL DEFAULT 'open-item',

  --   pending   — created, nothing sent yet
  --   running   — the worker is going through it
  --   completed — every item reached a final state
  --   failed    — the run itself broke, as opposed to individual items
  status        ENUM('pending','running','completed','failed') NOT NULL DEFAULT 'pending',

  total_count   INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count    INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count  INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count INT UNSIGNED NOT NULL DEFAULT 0,

  user_id       INT UNSIGNED NULL,      -- cp2_users.id, control DB, no FK
  user_name     VARCHAR(120) NOT NULL DEFAULT '',
  started_at    DATETIME     NULL,
  finished_at   DATETIME     NULL,
  error         VARCHAR(400) NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_run_status (status, created_at),
  KEY ix_run_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_statement_items (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id         INT UNSIGNED NOT NULL,
  customer_id    INT UNSIGNED NOT NULL,
  -- Snapshots, so a renamed account does not rewrite what the run says it did.
  customer_code  VARCHAR(32)  NOT NULL,
  customer_name  VARCHAR(160) NOT NULL,
  -- Where it went. Captured at queue time: changing the account's email
  -- afterwards must not make the record claim it went somewhere it did not.
  email          VARCHAR(190) NULL,

  --   queued  — waiting for the worker
  --   sent    — accepted by the mail server
  --   failed  — the send was refused or errored; retryable
  --   skipped — nothing to send: no email on file, or nothing owed
  status         ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',

  -- What the statement said they owed, frozen at send time.
  closing_balance DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The overdue portion, which is the figure a chasing email leads with.
  overdue_amount  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  attempts       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  error          VARCHAR(400) NULL,
  sent_at        DATETIME     NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One item per account per run: queueing the same customer twice would send
  -- them two statements for the same period.
  UNIQUE KEY uq_item_run_customer (run_id, customer_id),
  KEY ix_item_status (run_id, status),
  -- "When did we last statement this account?" — asked on the account screen.
  KEY ix_item_customer (customer_id, sent_at),
  CONSTRAINT fk_item_run      FOREIGN KEY (run_id)      REFERENCES customer_statement_runs (id) ON DELETE CASCADE,
  -- RESTRICT: a customer that has been statemented is not deletable, and the
  -- database says so rather than trusting every code path to remember.
  CONSTRAINT fk_item_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
