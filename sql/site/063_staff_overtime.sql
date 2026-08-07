-- Overtime: the three things 053-059 left for later.
--
-- The banding itself already works. `timesheetModel.ts` splits a week into
-- ordinary, overtime and premium hours; `staffCost.ts` costs them at the BCEA
-- multipliers; `staff_pay_lines` freezes the result. What follows are the
-- three places that arithmetic is fed something it cannot currently be told.
--
--   1. Good Friday and Family Day, which no code in this schema knows about.
--   2. Whether a person ordinarily works Sundays, which halves their premium.
--   3. The multipliers themselves, which are constants in a .ts file.
--
-- Taken together these are the difference between "overtime is calculated" and
-- "overtime is calculated correctly for this store".

-- ── 1. Public holidays a store declares for itself ──────────────────────
--
-- `timesheets.ts` computes the ten FIXED-date South African holidays in code,
-- and says plainly why the moving ones are absent: "a wrong Easter is worse
-- than an absent one because it silently mis-bands somebody's pay. A store can
-- mark those days by hand until this earns a proper table."
--
-- This is that table, and 063 also adds the Easter arithmetic — Computus is
-- exact rather than approximate, so the objection was to guessing, not to the
-- dates. The table remains worth having for the cases code cannot know:
--
--   A declared day of mourning or election day, gazetted a fortnight ahead.
--   A store's own shutdown that it chooses to pay at holiday rates.
--   Overriding a computed day a store genuinely does not observe.
--
-- ── WHY NOT SEED THE FIXED DAYS INTO THIS TABLE ─────────────────────────
--
-- Because then there would be two sources of truth for Christmas, and the one
-- a store could edit would be the one nobody remembered to check. Code keeps
-- the statutory days; this table holds only what a store adds or removes on
-- purpose. `is_working_day` below is what makes removal possible without
-- deleting the record of the decision.
CREATE TABLE public_holidays (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  holiday_date  DATE NOT NULL,
  name          VARCHAR(120) NOT NULL,

  -- FALSE (the default) means "this is a holiday" — premium hours.
  --
  -- TRUE inverts it: a day the computed calendar calls a holiday but this
  -- store treats as ordinary. Kept as a row rather than as an absence so the
  -- override is visible on the screen and survives somebody re-adding the day.
  is_working_day TINYINT(1) NOT NULL DEFAULT 0,

  note          VARCHAR(400) NULL,

  -- Who decided, because this moves money. Snapshotted like every other audit
  -- name in this schema, and no FK for the same reason.
  created_by_user_id INT UNSIGNED NULL,
  created_by_name    VARCHAR(120) NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One ruling per day. Two rows disagreeing about the same date is exactly
  -- the ambiguity this table exists to remove.
  UNIQUE KEY uq_holiday_date (holiday_date),
  -- "Which of these fall in the timesheet range" — the only query there is.
  KEY ix_holiday_date (holiday_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── 2. Whether Sunday is an ordinary working day for this person ────────
--
-- BCEA section 16(1) pays double time for Sunday work — but 16(2) pays one and
-- a half where the employee ORDINARILY works on a Sunday. `staffCost.ts`
-- currently applies 2× to everybody, which over-states the wage bill of every
-- store that trades on a Sunday, and does so silently.
--
-- Per person rather than per site: the same shop has a weekend team who always
-- work Sundays and an office who never do, and one flag for the store would be
-- wrong for one of them.
--
-- Defaults to 0 — the statutory rate for somebody who does not ordinarily work
-- Sundays. An existing site therefore keeps costing exactly as it does today
-- until somebody sets the flag, which is the conservative direction: it
-- over-states cost rather than quietly paying somebody less than 16(1).
ALTER TABLE user_employment
  ADD COLUMN works_sundays TINYINT(1) NOT NULL DEFAULT 0 AFTER ordinary_hours_pw;

-- ── 3. The multipliers, as settings ─────────────────────────────────────
--
-- `OVERTIME_MULTIPLIER = 1.5` and `SUNDAY_MULTIPLIER = 2` are constants in
-- timesheetModel.ts. They are the correct statutory defaults and most stores
-- will never touch them — but a bargaining council agreement can set higher
-- rates, and a store bound by one currently has no way to say so.
--
-- These are exactly what settings.ts describes as belonging in the KV: single
-- scalars a store owner changes, that nothing joins to.
--
-- Seeded here so the row exists rather than relying on the read-side fallback.
-- INSERT IGNORE because a site that has somehow already got these keeps its
-- own values — a migration must never quietly reset a rate somebody chose.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('staff_overtime_multiplier', '1.5'),
  ('staff_sunday_multiplier', '2'),
  -- 16(2): what a Sunday costs for somebody who ordinarily works one.
  ('staff_sunday_ordinary_multiplier', '1.5'),
  -- A public holiday is paid at double under section 18(2)(a) when it is not
  -- an ordinary working day for that person. Separate from the Sunday rate
  -- because a store may agree one and not the other.
  ('staff_holiday_multiplier', '2');
