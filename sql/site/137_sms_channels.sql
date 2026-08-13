-- ============================================================================
-- 137 — SMS channels: dunning, layby reminders
--
-- WHY
--
-- Every outbound word this system says goes by email, and in this market a
-- text lands where an email waits. The SMS layer itself is settings + code
-- (src/lib/sms); this migration adds the columns the CONSUMERS need.
--
-- dunning_levels.channel: which leg(s) a level sends. sms_body is its own
-- template rather than reusing body — a letter and a text are different
-- registers, and 320 characters is a constraint the column type states.
--
-- dunning_run_items: the SMS leg's own outcome, beside the email's. One
-- item, two legs, each recorded — `status` stays the overall outcome so
-- every existing reader keeps meaning what it meant.
--
-- laybys.reminded_at: when the customer was last nudged about a due date,
-- so the reminder sweep cannot nag daily.
-- ============================================================================

ALTER TABLE dunning_levels
  ADD COLUMN IF NOT EXISTS channel ENUM('email','sms','both') NOT NULL DEFAULT 'email' AFTER body,
  ADD COLUMN IF NOT EXISTS sms_body VARCHAR(320) NULL AFTER channel;

ALTER TABLE dunning_run_items
  ADD COLUMN IF NOT EXISTS phone VARCHAR(40) NULL AFTER email,
  ADD COLUMN IF NOT EXISTS sms_status ENUM('none','sent','failed','skipped') NOT NULL DEFAULT 'none' AFTER status,
  ADD COLUMN IF NOT EXISTS sms_error VARCHAR(400) NULL AFTER sms_status;

ALTER TABLE laybys
  ADD COLUMN IF NOT EXISTS reminded_at DATETIME NULL AFTER due_date;
