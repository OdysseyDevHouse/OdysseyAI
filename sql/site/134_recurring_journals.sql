-- ============================================================================
-- 134 — Recurring journals
--
-- WHY
--
-- The monthly accrual, the prepayment release, the inter-department recharge:
-- journals that are the SAME entry every month, re-typed by hand — and the
-- month somebody forgets, the P&L is quietly wrong with nothing to notice it.
-- Recurring expenses solved this for bills in 042; this is the same design
-- for the ledger's own entries.
--
-- A TEMPLATE GENERATES A DRAFT, NEVER A POSTING (the 042 doctrine: the
-- schedule removes the TYPING, not the judgement). journal_batches has had a
-- 'draft' status since 045 with nothing writing it — generation is what it
-- was waiting for. A draft carries no number and moves no balances; posting
-- it is a person's deliberate act. auto_post is the per-schedule opt-out for
-- entries that truly never vary; a refused auto-post (locked period,
-- deactivated account) falls back to a draft rather than vanishing.
--
-- Lines carry no customer/supplier columns on purpose: control accounts are
-- refused for manual-style journals anyway, and a recurring entry against a
-- particular debtor is a recurring INVOICE — contracts already do that.
--
-- Generated batches carry source = 'recurring' and source_doc_id = the
-- schedule's id, extending 045's documented source list.
-- ============================================================================

CREATE TABLE IF NOT EXISTS recurring_journals (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name               VARCHAR(120) NOT NULL,
  frequency          ENUM('weekly','monthly','quarterly','annually') NOT NULL DEFAULT 'monthly',
  day_of_month       TINYINT UNSIGNED NULL,
  day_of_week        TINYINT UNSIGNED NULL,
  -- Becomes the generated batch's description, so the ledger reads well.
  description        VARCHAR(255) NOT NULL,
  reference          VARCHAR(60)  NULL,
  starts_on          DATE NOT NULL,
  ends_on            DATE NULL,
  -- The idempotence key: the last occurrence date this schedule produced.
  -- Stamped per occurrence, so a failure part-way repeats nothing. See 042.
  last_generated_for DATE NULL,
  auto_post          TINYINT(1) NOT NULL DEFAULT 0,
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  notes              VARCHAR(400) NULL,
  user_id            INT UNSIGNED NULL,
  user_name          VARCHAR(120) NOT NULL DEFAULT '',
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_recjnl_active (is_active, last_generated_for)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS recurring_journal_lines (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  recurring_id INT UNSIGNED NOT NULL,
  line_number  INT NOT NULL,
  account_id   INT UNSIGNED NOT NULL,
  -- Signed, the ledger's own convention: positive debit, negative credit.
  amount       DECIMAL(16,4) NOT NULL,
  description  VARCHAR(190) NULL,
  department_id INT UNSIGNED NULL,
  PRIMARY KEY (id),
  KEY ix_recjnl_lines (recurring_id, line_number),
  CONSTRAINT fk_recjnl_line FOREIGN KEY (recurring_id)
    REFERENCES recurring_journals (id) ON DELETE CASCADE,
  -- RESTRICT: an account named by a standing template must be deactivated,
  -- not deleted from under it.
  CONSTRAINT fk_recjnl_account FOREIGN KEY (account_id)
    REFERENCES gl_accounts (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
