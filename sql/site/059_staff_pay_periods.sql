-- Pay periods: so a figure somebody has been paid stops moving.
--
-- ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────
--
-- Everything the cost report reads is live: hours from `staff_time_entries`,
-- leave from `leave_ledger`, commission from `commission_entries`. Correct a
-- forgotten clock-out in June and June's cost changes — which is exactly what
-- you want right up until somebody has been paid on it, and exactly what you
-- do not want afterwards.
--
-- So a period locks. Open means the figures still move; locked means they are
-- what was paid, and a later correction lands in the next open period rather
-- than silently restating a month that is closed.
--
-- Same shape and same reasoning as `commission_runs` in 042. Deliberately the
-- same, so somebody who has understood one understands the other.
--
-- ── WHY NOT THE ACCOUNTING PERIOD LOCK ──────────────────────────────────
--
-- `period_locks` already exists and already guards sales, purchases, the
-- ledgers and stock. It is the wrong tool here: closing March for VAT and
-- closing March for wages are different decisions, made by different people,
-- at different times. A bookkeeper who locks February for VAT on the 7th must
-- not thereby freeze payroll corrections nobody has finished making.

CREATE TABLE staff_pay_periods (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Inclusive both ends, matching every other date range in this schema.
  period_start  DATE NOT NULL,
  period_end    DATE NOT NULL,

  status        ENUM('open','locked') NOT NULL DEFAULT 'open',

  -- When the figures were last worked out, so a screen can say whether what it
  -- is showing predates hours captured since.
  calculated_at DATETIME NULL,

  locked_at         DATETIME NULL,
  locked_by_user_id INT UNSIGNED NULL,
  locked_by_name    VARCHAR(120) NULL,

  -- Header totals, so a list screen needs no join. Snapshotted at lock time —
  -- see `staff_pay_lines` below for the per-person detail.
  total_cost    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  note          VARCHAR(400) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- Two periods covering the same day would pay the same hours twice.
  UNIQUE KEY uq_pay_period (period_start, period_end),
  KEY ix_pay_period_status (status, period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What each person cost, frozen ───────────────────────────────────────
--
-- Written when a period is CALCULATED and rewritten on every recalculation
-- while it is open. Once locked it is never touched again — which is what
-- makes it answerable in a year's time.
--
-- EVERYTHING IS SNAPSHOTTED, including the rate. A person's hourly rate is on
-- `user_employment` and changes when they get a raise; a locked period must
-- keep saying what it actually cost, not what the same hours would cost today.
-- Same reasoning as `commission_entries` in 042.
CREATE TABLE staff_pay_lines (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  period_id      INT UNSIGNED NOT NULL,

  user_id        INT UNSIGNED NOT NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',
  employee_number VARCHAR(32) NULL,

  -- The terms as they stood, so the arithmetic can be re-checked by hand.
  pay_basis      ENUM('hourly','salaried') NOT NULL DEFAULT 'hourly',
  hourly_rate    DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  monthly_salary DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Hours, banded as the timesheet banded them.
  ordinary_hours DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  overtime_hours DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  -- Sunday and public-holiday hours, which carry their own rate.
  premium_hours  DECIMAL(8,2) NOT NULL DEFAULT 0.00,
  leave_days     DECIMAL(8,2) NOT NULL DEFAULT 0.00,

  -- The money. Kept apart rather than as one total because payroll wants the
  -- parts, and a single figure cannot be checked against anything.
  ordinary_cost  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  overtime_cost  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  premium_cost   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  leave_cost     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  commission     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  total_cost     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- What they brought in, for the contribution figure. Two columns because
  -- "who rang it up" and "who sold it" are different questions — 047 exists
  -- precisely because they differ — and a report that silently picks one
  -- would be wrong for whichever store means the other.
  revenue_rung_up DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  revenue_sold    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  gross_profit    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pay_line (period_id, user_id),
  KEY ix_pay_line_user (user_id),
  CONSTRAINT fk_pay_line_period FOREIGN KEY (period_id)
    REFERENCES staff_pay_periods (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
