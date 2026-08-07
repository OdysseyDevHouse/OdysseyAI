-- Cash-up by till, or cash-up by person.
--
-- 016 defined a shift as "one person on one till" and enforced the till half of
-- that with a unique index. That is right for retail: a cashier stands at a
-- register for a stretch, and the drawer they hand over is the thing being
-- reconciled.
--
-- It is wrong for hospitality. Twenty waiters work ten tills, each carrying
-- their OWN float, and any of them may ring up on any register. Reconciling by
-- till would ask "which of the six people who touched till 4 is short?", which
-- has no answer. Reconciling by person asks "did this waiter hand over what
-- they took?", which does.
--
-- Both are one shift table, because a shift was never really "a till" — it is a
-- RECONCILIATION UNIT between two moments. Only the owner of that unit differs,
-- and `mode` records which owner this row was opened under. Stored on the row
-- rather than read from settings at report time: a site that switches mode must
-- not retrospectively change what a shift someone already signed off meant.

ALTER TABLE shifts
  -- 'terminal' — the drawer in a register. One open shift per till.
  -- 'user'     — a person and their own float. One open shift per user.
  ADD COLUMN mode ENUM('terminal','user') NOT NULL DEFAULT 'terminal' AFTER id;

-- In user mode nobody is tied to a register, so the till stops being required.
-- Sales still carry their own terminal_id, so "which register rang this" is
-- never lost — it simply stops being what the cash-up is grouped by.
ALTER TABLE shifts
  MODIFY COLUMN terminal_id INT UNSIGNED NULL,
  MODIFY COLUMN terminal_code VARCHAR(24) NULL;

-- The open-shift guard, once per mode.
--
-- 016's trick still does the work: a generated column that goes NULL on close,
-- with a unique index over it, constrains exactly the OPEN rows (MySQL permits
-- any number of NULLs in a unique index). What changes is that each expression
-- now also tests the mode, so a terminal-mode shift never collides with a
-- user-mode one and each mode gets precisely the rule it needs.
--
-- Dropping the index before the column because the index depends on it.
ALTER TABLE shifts DROP INDEX uq_shift_open;
ALTER TABLE shifts DROP COLUMN open_terminal_id;

ALTER TABLE shifts
  ADD COLUMN open_terminal_id INT UNSIGNED
    GENERATED ALWAYS AS (
      CASE WHEN closed_at IS NULL AND mode = 'terminal' THEN terminal_id ELSE NULL END
    ) STORED,
  ADD COLUMN open_user_id INT UNSIGNED
    GENERATED ALWAYS AS (
      CASE WHEN closed_at IS NULL AND mode = 'user' THEN user_id ELSE NULL END
    ) STORED;

-- One open shift per till in terminal mode; one open shift per person in user
-- mode. Enforced by the database rather than by remembering to check, exactly
-- as 016 argued for the terminal case.
ALTER TABLE shifts
  ADD UNIQUE KEY uq_shift_open_terminal (open_terminal_id),
  ADD UNIQUE KEY uq_shift_open_user (open_user_id);

-- Which drawer the money came out of.
--
-- In terminal mode the shift already names the till, so this is redundant but
-- harmless. In user mode it is the only record of it: a waiter paying a supplier
-- out of pocket and a waiter taking it from the till drawer are different
-- events, and without this column they are indistinguishable afterwards.
ALTER TABLE shift_movements
  ADD COLUMN terminal_id INT UNSIGNED NULL AFTER shift_id,
  ADD CONSTRAINT fk_smove_terminal FOREIGN KEY (terminal_id) REFERENCES terminals (id) ON DELETE SET NULL;

-- How this site reconciles. 'terminal' keeps every existing store working
-- exactly as it did, which is why it is the default rather than a choice
-- somebody has to make before they can trade.
INSERT INTO settings (setting_key, setting_value) VALUES
  ('cashup_mode', 'terminal')
  ON DUPLICATE KEY UPDATE setting_value = setting_value;
