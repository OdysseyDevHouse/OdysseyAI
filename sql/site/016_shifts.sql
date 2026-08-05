-- Shifts and cash-up.
--
-- `sales_documents.shift_id` and `stock_movements.shift_id` have existed since
-- 015 as nullable columns with nothing to point at — added then precisely
-- because backfilling "whose cash-up owns this sale" across a year of invoices
-- is guesswork. This is the table they were waiting for.
--
-- A SHIFT is one person on one till between two moments. It is not a day and
-- not a session: two cashiers sharing a till across a lunch break are two
-- shifts, because the whole point is knowing whose drawer was short.
--
-- WHAT MAKES CASH-UP WORK is the distinction between what the system EXPECTED
-- and what the person COUNTED. Expected is derived from sales_tenders and is
-- never stored — deriving it means it cannot drift from the sales it came from.
-- Counted is typed in by a human. Variance is the difference, and it is the
-- only figure anyone actually cares about.

CREATE TABLE shifts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  terminal_id    INT UNSIGNED NOT NULL,
  terminal_code  VARCHAR(24)  NOT NULL,   -- snapshot, as everywhere else

  -- cp2_users.id from the control database. No FK is possible across databases,
  -- so the name is snapshotted for the same reason it is on a sale.
  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  opened_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at      DATETIME     NULL,

  -- What was in the drawer before trading. Counted, not assumed: a float that
  -- is wrong at the start makes every variance for the rest of the shift wrong
  -- in the same direction, and nobody can tell which end it came from.
  opening_float  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- What the person counted at the end, per tender type, in shift_counts. The
  -- header carries only the summary so a list screen needs no join.
  counted_total  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  expected_total DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- counted - expected. Negative is short. Stored at close so the figure on the
  -- report is the one that was signed off, even if a late sale lands afterwards
  -- (which the guards below make impossible, but stored figures outlive guards).
  variance       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Required when the variance is outside the tolerance. A short drawer with no
  -- explanation is the thing a manager needs to see.
  variance_note  VARCHAR(400) NULL,
  closed_by_user_id INT UNSIGNED NULL,
  closed_by_name VARCHAR(120) NULL,

  -- Holds the terminal id while the shift is open, and NULL once it closes.
  --
  -- This exists because a UNIQUE on (terminal_id, closed_at) would NOT do the
  -- job: MySQL permits any number of NULLs in a unique index, so every open
  -- shift would have closed_at = NULL and none of them would collide. A
  -- generated column that goes NULL on close inverts that — the unique index
  -- then constrains exactly the open ones, which is the rule we actually want.
  open_terminal_id INT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN closed_at IS NULL THEN terminal_id ELSE NULL END) STORED,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- One OPEN shift per till, enforced by the database. A second would split a
  -- drawer's takings across two cash-ups with no way to say which sale belonged
  -- to which.
  UNIQUE KEY uq_shift_open (open_terminal_id),
  KEY ix_shift_terminal (terminal_id, opened_at),
  KEY ix_shift_user (user_id, opened_at),
  KEY ix_shift_opened (opened_at),
  -- RESTRICT: a till with cash-up history is not deletable, and the database
  -- says so rather than trusting every code path to remember.
  CONSTRAINT fk_shift_terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What was counted, per tender type.
--
-- One row per tender the shift took, so a drawer that was R20 short on cash but
-- exact on card is reported as exactly that — rather than a single net figure
-- that hides which one to investigate.
CREATE TABLE shift_counts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  shift_id       INT UNSIGNED NOT NULL,
  tender_type_id INT UNSIGNED NOT NULL,
  tender_code    VARCHAR(24)  NOT NULL,
  tender_name    VARCHAR(60)  NOT NULL,

  -- Derived from sales_tenders at close, then FROZEN here. Recomputing it later
  -- would change a figure someone has already signed off.
  expected       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  counted        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  variance       DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_shift_tender (shift_id, tender_type_id),
  KEY ix_count_tender (tender_type_id),
  CONSTRAINT fk_count_shift  FOREIGN KEY (shift_id)       REFERENCES shifts (id)       ON DELETE CASCADE,
  CONSTRAINT fk_count_tender FOREIGN KEY (tender_type_id) REFERENCES tender_types (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Money in or out of the drawer that is not a sale.
--
-- A payout for milk, a float top-up, a banking drop. Without these a cash-up is
-- wrong every time someone takes a note out for anything, and the cashier gets
-- blamed for a variance that was a legitimate errand.
CREATE TABLE shift_movements (
  id         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  shift_id   INT UNSIGNED NOT NULL,
  -- 'payout'  — money leaving for an expense (negative)
  -- 'payin'   — money added that is not a sale (positive)
  -- 'drop'    — moved to the safe mid-shift (negative)
  movement_type ENUM('payout','payin','drop') NOT NULL,
  -- Signed, so the drawer position is a plain SUM.
  amount     DECIMAL(12,4) NOT NULL,
  reason     VARCHAR(190) NOT NULL,
  user_id    INT UNSIGNED NULL,
  user_name  VARCHAR(120) NOT NULL DEFAULT '',
  created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_smove_shift (shift_id, created_at),
  CONSTRAINT fk_smove_shift FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The variance a manager is happy to sign off without a note. Above it, a
-- reason is required. 0 would demand an explanation for every stray cent.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('cashup_variance_tolerance', '5.00');
