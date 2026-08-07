-- Leave: what a person is entitled to, what they have asked for, and what is
-- left.
--
-- ── WHY A LEDGER AND NOT A BALANCE COLUMN ───────────────────────────────
--
-- A `days_remaining` column is a number nobody can explain. The first time an
-- employee says "I should have fourteen days, not eleven", the only honest
-- answer a balance column can give is "that is what the field says".
--
-- Movements can be listed: accrued 1.25 in March, took 3 in April, adjusted +2
-- when the previous system was migrated. The balance is then the sum, and every
-- part of it is arguable on its own terms — which is what survives a
-- disagreement with somebody about their own leave.
--
-- ── THE BCEA MINIMUMS ARE DEFAULTS, NOT CEILINGS ────────────────────────
--
-- The seeded types below are the statutory floor. A store may be more generous
-- and many are; nothing here stops that. What the seed does is mean a store
-- that configures nothing is still compliant on its first day, rather than
-- starting from an empty table and inventing something short of the Act.

-- ── Leave types ─────────────────────────────────────────────────────────
CREATE TABLE leave_types (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(60)  NOT NULL,
  code           VARCHAR(24)  NOT NULL,

  -- Whether the employer pays for it. Maternity is deliberately FALSE below —
  -- see the seed.
  is_paid        TINYINT(1)   NOT NULL DEFAULT 1,

  -- How entitlement arrives.
  --   none         — no entitlement accrues; unpaid leave, and the type used
  --                  when somebody has exhausted everything else.
  --   monthly      — a fixed number of days each month worked (annual leave).
  --   annual_grant — the whole year's allowance on the cycle anniversary.
  --   cycle_36m    — a block per 36-month cycle, which is how the BCEA
  --                  measures sick leave and nothing else in the Act.
  accrual_method ENUM('none','monthly','annual_grant','cycle_36m') NOT NULL DEFAULT 'none',

  -- Days per accrual event, given the method above.
  accrual_days   DECIMAL(6,3) NOT NULL DEFAULT 0.000,

  -- For cycle_36m, how long the cycle runs. 36 in the Act.
  cycle_months   INT UNSIGNED NOT NULL DEFAULT 12,

  -- A ceiling on the balance, for a store that does not want unlimited
  -- carry-over. NULL means no cap.
  --
  -- Note the Act forbids a store from making annual leave simply vanish —
  -- section 20(4) requires it to be granted, and section 40(b) requires it to
  -- be paid out on termination. A cap here is a house rule about accrual, not
  -- permission to erase what somebody has earned.
  max_balance_days DECIMAL(6,2) NULL,

  -- Seeded by this migration. Renaming or re-rating one is fine; this only
  -- stops the delete that would leave a store with no way to record sick leave.
  is_system      TINYINT(1)   NOT NULL DEFAULT 0,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order     INT          NOT NULL DEFAULT 0,
  notes          VARCHAR(400) NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_leave_type_code (code),
  KEY ix_leave_type_active (is_active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Requests ────────────────────────────────────────────────────────────
CREATE TABLE leave_requests (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- No FK, name snapshotted — the house convention. A leave record is evidence
  -- and must outlive the user row being tidied away.
  user_id       INT UNSIGNED NOT NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',

  leave_type_id INT UNSIGNED NOT NULL,
  leave_type_name VARCHAR(60) NOT NULL DEFAULT '',

  period_from     DATE NOT NULL,
  period_to       DATE NOT NULL,

  -- Working days in the range, COMPUTED AT REQUEST TIME and then stored.
  --
  -- Not derived on read: it is worked out from the store's working week as it
  -- stood when the request was made, and a store that later moves to a
  -- six-day week must not silently restate leave already taken.
  days          DECIMAL(6,2) NOT NULL DEFAULT 0.00,

  -- Half days are the common exception, and a request that can only be whole
  -- days pushes people into taking a full day for a dentist appointment.
  is_half_day   TINYINT(1)   NOT NULL DEFAULT 0,

  status        ENUM('requested','approved','declined','cancelled')
                  NOT NULL DEFAULT 'requested',
  reason        VARCHAR(400) NULL,

  decided_by_user_id INT UNSIGNED NULL,
  decided_by_name    VARCHAR(120) NULL,
  decided_at         DATETIME NULL,
  decided_note       VARCHAR(400) NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- "What has this person got outstanding", and the approval queue.
  KEY ix_leave_req_user (user_id, period_from),
  KEY ix_leave_req_status (status, period_from),
  -- RESTRICT: a type somebody has taken leave under cannot be deleted, or the
  -- history stops explaining itself.
  CONSTRAINT fk_leave_req_type FOREIGN KEY (leave_type_id)
    REFERENCES leave_types (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The ledger ──────────────────────────────────────────────────────────
--
-- Every movement in somebody's balance, positive or negative. The balance is
-- SUM(days) and is never stored.
CREATE TABLE leave_ledger (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       INT UNSIGNED NOT NULL,
  leave_type_id INT UNSIGNED NOT NULL,

  entry_date    DATE NOT NULL,

  -- Positive accrues, negative is taken. One signed column rather than a pair
  -- of debit/credit columns: a leave movement is only ever one or the other,
  -- and two columns would mean every read has to subtract.
  days          DECIMAL(6,2) NOT NULL,

  --   accrual    — the monthly or cyclical entitlement
  --   taken      — an approved request
  --   adjustment — a manager correcting the balance by hand
  --   opening    — what somebody arrived with, migrating from another system
  --   forfeit    — a capped balance losing the excess
  --   payout     — paid out rather than taken, e.g. on termination (BCEA s40)
  source        ENUM('accrual','taken','adjustment','opening','forfeit','payout')
                  NOT NULL,

  -- The request this came from, where it came from one. SET NULL rather than
  -- CASCADE: deleting a request must not silently give somebody their days
  -- back without a trace.
  request_id    INT UNSIGNED NULL,

  note          VARCHAR(400) NULL,
  created_by_user_id INT UNSIGNED NULL,
  created_by_name    VARCHAR(120) NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The balance query: one person, one type, summed.
  KEY ix_leave_ledger_balance (user_id, leave_type_id, entry_date),
  KEY ix_leave_ledger_request (request_id),

  -- Stops the monthly accrual running twice for the same person, type and
  -- month. A job that runs on a timer WILL be run twice eventually — by a
  -- retry, a manual trigger, or two app instances — and doubling everyone's
  -- leave is not a mistake anybody notices quickly.
  UNIQUE KEY uq_leave_accrual (user_id, leave_type_id, entry_date, source),

  CONSTRAINT fk_leave_ledger_type FOREIGN KEY (leave_type_id)
    REFERENCES leave_types (id) ON DELETE RESTRICT,
  CONSTRAINT fk_leave_ledger_request FOREIGN KEY (request_id)
    REFERENCES leave_requests (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The statutory minimums ──────────────────────────────────────────────
--
-- Annual: BCEA s20 — 21 consecutive days per 12-month cycle. Expressed as
-- 1.25 days a month because that is how it accrues in practice and how anybody
-- reads a balance mid-year; 1.25 × 12 = 15 WORKING days, which is what 21
-- consecutive days amounts to on a five-day week. A store on six days should
-- raise this to 1.75.
--
-- Sick: BCEA s22 — the number of days a person would normally work in six
-- weeks, per 36-month cycle. 30 on a five-day week.
--
-- Family responsibility: BCEA s27 — 3 days a year, for a person who has been
-- employed longer than four months and works at least four days a week.
--
-- Maternity: BCEA s25 — four consecutive months. UNPAID here, deliberately:
-- the employer is not obliged to pay it, UIF is. Marking it paid would commit
-- a store to a cost the law does not impose on them.
INSERT INTO leave_types
  (name, code, is_paid, accrual_method, accrual_days, cycle_months, is_system, sort_order, notes)
VALUES
  ('Annual leave', 'ANNUAL', 1, 'monthly', 1.250, 12, 1, 10,
   'BCEA s20 — 21 consecutive days per cycle. 1.25 days a month on a five-day week; raise to 1.75 on six.'),
  ('Sick leave', 'SICK', 1, 'cycle_36m', 30.000, 36, 1, 20,
   'BCEA s22 — six weeks'' worth per 36-month cycle. 30 days on a five-day week.'),
  ('Family responsibility', 'FAMILY', 1, 'annual_grant', 3.000, 12, 1, 30,
   'BCEA s27 — 3 days a year, after four months'' employment.'),
  ('Maternity leave', 'MATERNITY', 0, 'none', 0.000, 12, 1, 40,
   'BCEA s25 — four consecutive months. Unpaid by the employer; UIF pays.'),
  ('Unpaid leave', 'UNPAID', 0, 'none', 0.000, 12, 1, 50,
   'No entitlement accrues. Used once paid leave is exhausted.');
