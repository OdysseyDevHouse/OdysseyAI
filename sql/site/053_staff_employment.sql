-- What a person is employed AS, and what they cost.
--
-- The first of five steps towards timesheets, leave and cost per employee. This
-- one adds only the employment facts; hours, leave and the cost report follow.
--
-- ── WHY A SEPARATE TABLE AND NOT COLUMNS ON `users` ─────────────────────
--
-- Two reasons, both practical.
--
-- `users` is read on EVERY request. `requireSiteUser()` resolves it before any
-- page renders, so every column on it is loaded thousands of times a day.
-- Employment data is read on a handful of screens by a handful of people.
--
-- And a pay rate is not like a name. `users.name` is on every audit row in the
-- database; `hourly_rate` is the kind of thing a shop floor argues about. A
-- separate table makes "who may read this" a JOIN somebody has to write on
-- purpose, rather than a column they have to remember to leave out of a SELECT.
--
-- One row per user at most, so the user id IS the primary key.
--
-- ── WHY NOT `sales_reps` ────────────────────────────────────────────────
--
-- 047 settled that: `users` is the person, `sales_reps` is now only an
-- account-ownership label on `customers.rep_id`. Every active rep already has a
-- users row. Hanging employment off reps would split the same person in two.

CREATE TABLE user_employment (
  user_id          INT UNSIGNED NOT NULL,

  -- The number on the payslip in whatever system actually pays them. Ours is
  -- `users.id`; theirs is this. Nullable because a store may not use one, and
  -- UNIQUE because two people sharing one is how the wrong person gets paid.
  employee_number  VARCHAR(32) NULL,

  employment_type  ENUM('permanent','fixed_term','casual','contractor')
                     NOT NULL DEFAULT 'permanent',

  -- Which of the two rates below actually applies. Stored rather than inferred
  -- from whichever is non-zero: somebody moving from hourly to salaried keeps
  -- their old rate on file, and "whichever is filled in" would then pay both.
  pay_basis        ENUM('hourly','salaried') NOT NULL DEFAULT 'hourly',

  -- GROSS, before any statutory deduction. This system does not calculate PAYE,
  -- UIF or SDL — it produces the input a payroll system takes. Naming it gross
  -- here is what stops somebody typing a net figure into it.
  hourly_rate      DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  monthly_salary   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Ordinary hours per week, above which the overtime rate applies.
  --
  -- 45 is the BCEA section 9 maximum for ordinary hours. Per-person rather than
  -- a site setting because a part-timer's ordinary week is genuinely shorter,
  -- and calculating their overtime from 45 would mean they never earn any.
  ordinary_hours_pw DECIMAL(5,2) NOT NULL DEFAULT 45.00,

  hired_on         DATE NULL,

  -- Set rather than deleting the row. Every report has to be able to answer
  -- "what did March cost" correctly in June, and a person who left in April
  -- still worked in March. Deleting them would silently restate history.
  terminated_on    DATE NULL,

  -- The anniversary the annual leave cycle runs from. BCEA section 20 grants 21
  -- consecutive days per 12-month cycle measured from the start of employment,
  -- not from January — so this defaults to `hired_on` and is separate only
  -- because a store may run everybody on a common cycle instead.
  leave_cycle_start DATE NULL,

  notes            VARCHAR(400) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (user_id),
  UNIQUE KEY uq_employee_number (employee_number),
  -- "Who is currently employed" is the filter every screen here opens with.
  KEY ix_employment_current (terminated_on, employment_type),

  -- CASCADE is right for once: this row describes a user and has no meaning
  -- without one. Unlike a time entry or a commission entry, it is not a record
  -- of something that happened — it is the person's current terms.
  CONSTRAINT fk_employment_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
