-- ============================================================================
-- 131 — Budgets
--
-- WHY
--
-- The income statement records what happened; a budget states what was
-- EXPECTED, and the comparison between the two is what turns a P&L from a
-- record into a management tool. Every accounting package carries this.
--
-- One row per account per calendar month. Month is a CHAR(7) 'YYYY-MM' —
-- the same key depreciation_runs.period_month uses — because a budget is a
-- monthly discipline, and a fiscal-year grid is just twelve of these. A
-- non-calendar fiscal year is a future option on the reading side, not a
-- schema change.
--
-- SIGN CONVENTION: amount is the DISPLAY figure — positive means the
-- expected amount of the thing the account names (budgeted sales 480 000,
-- budgeted rent 12 000). It is compared against displayBalance(actual),
-- never against raw debit-signed movements: nobody budgets "-480 000 of
-- revenue", and a table that stored it that way would put a sign error one
-- keystroke away on every screen that reads it.
--
-- A zero is DELETED on save rather than stored: "no budget" and "budgeted
-- at zero" read the same on the statement, and a grid of stored zeros is
-- noise the copy-forward would then faithfully replicate forever.
-- ============================================================================

CREATE TABLE IF NOT EXISTS gl_budgets (
  id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id   INT UNSIGNED NOT NULL,
  period_month CHAR(7)      NOT NULL,
  amount       DECIMAL(16,4) NOT NULL DEFAULT 0,
  user_id      INT UNSIGNED NULL,
  user_name    VARCHAR(120) NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_budget (account_id, period_month),
  KEY ix_budget_month (period_month),
  CONSTRAINT fk_budget_account FOREIGN KEY (account_id)
    REFERENCES gl_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
