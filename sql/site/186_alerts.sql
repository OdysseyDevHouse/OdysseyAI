-- ─────────────────────────────────────────────────────────────────────────
-- Alerts & automations — watch a condition, tell somebody, offer the fix.
--
-- A rule is an INTENT: a CONDITION + a WHEN + a WHO + optionally an ACTION.
-- Nothing about the condition's DATA is stored here. The check re-runs fresh
-- against the shop on every firing, recipients re-resolve out of `users` at
-- send time, and the rule runs under its stored owner's capabilities — because
-- there is no session at 07:00. Same doctrine as 054's report schedules, and
-- deliberately the same scheduling vocabulary, evaluated by the same pure
-- lastDueAt() so two features can never disagree about when "07:00 daily" is.
--
-- ── WHY NOT JUST MORE SCHEDULED REPORTS ──────────────────────────────────
--
-- A scheduled report always sends. An alert sends only when something is
-- wrong, and a clean bill of health is a SUCCESSFUL run that notifies nobody —
-- which is the whole difference between a thing you read every morning and a
-- thing you trust to interrupt you. That inverts the ledger's meaning
-- (item_count 0 is the good day), adds channels a report has no use for (the
-- bell, WhatsApp, SMS), and adds an ACTION half no report has: a low-stock
-- rule can draft the purchase orders it is complaining about. Sharing one
-- table would mean a nullable column for every one of those.
--
-- ── WHY THE RUN LEDGER, AGAIN ────────────────────────────────────────────
--
-- UNIQUE (rule_id, due_at) IS the claim. Whoever wins the INSERT runs the
-- check; everyone else gets ER_DUP_ENTRY, which means "someone already has
-- this occurrence", not an error. due_at is the SCHEDULED instant with its
-- seconds zeroed, never "now" — otherwise two ticks a minute apart compute
-- different keys and the shop is told twice.
--
-- It is not only a mutex. It is what makes a failed check retryable, what
-- lets the screen show a history, and — through created_docs — the audit
-- answer to "what did this thing do in my name last Tuesday".
CREATE TABLE IF NOT EXISTS alert_rules (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- WHAT TO WATCH. A registry key resolved in code ('low_stock',
  -- 'cashup_variance', …), not an ENUM: a new kind is a new evaluator file and
  -- one switch case, and must never be a migration. A row whose kind an older
  -- build does not know fails that one occurrence loudly rather than running
  -- some other rule's check under the wrong name.
  kind          VARCHAR(40)  NOT NULL,
  name          VARCHAR(120) NOT NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,

  -- WHEN IT CHECKS, in the shop's own wall clock. Identical vocabulary to
  -- report_schedules, evaluated by the same lastDueAt(): daily at send_time,
  -- weekly on the days flagged in a 7-character Mon..Sun mask, or monthly on
  -- day_of_month clamped to the month's last day.
  --
  -- No "every N minutes", for a sharper reason than reports have: an interval
  -- invites "every 5 minutes", and an alert that fires every 5 minutes about a
  -- condition that stays true for a week is a notification the shop learns to
  -- ignore. A low-stock check is a rhythm-of-the-day thing — 07:00 before
  -- ordering, or 17:00 before close.
  frequency     ENUM('daily','weekly','monthly') NOT NULL DEFAULT 'daily',
  send_time     VARCHAR(5)   NOT NULL DEFAULT '07:00',
  days_of_week  VARCHAR(7)   NOT NULL DEFAULT '1111111',
  day_of_month  TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- THE KIND'S OWN KNOBS, as JSON. Each kind has its own shape ("how many days
  -- is dead", "what variance matters", "draft the orders or not"), so discrete
  -- columns would mean an ALTER per kind and a table of mostly-NULLs.
  --
  -- Read sceptically: readConfig() gives every knob a default and clamps every
  -- range, so malformed JSON degrades to a sensible rule rather than throwing
  -- inside a sweep that is running over every site at 07:00.
  config_json   TEXT         NULL,

  -- HOW IT TELLS PEOPLE. Four independent switches, not one channel column: a
  -- rule that matters is usually wanted in two places at once (the bell now,
  -- an email to read later), and per-channel recipients differ in KIND — a
  -- bell row needs a user, an email needs an address, WhatsApp and SMS need
  -- numbers that are frequently not a system user's at all.
  notify_bell     TINYINT(1) NOT NULL DEFAULT 1,
  notify_email    TINYINT(1) NOT NULL DEFAULT 0,
  notify_whatsapp TINYINT(1) NOT NULL DEFAULT 0,
  notify_sms      TINYINT(1) NOT NULL DEFAULT 0,

  -- WHO HEARS ABOUT IT.
  --   recipient_user_ids — the people, resolved to their CURRENT email (and
  --     their current access) on every firing. Storing the USER and not the
  --     address is the point: someone who changes their email keeps hearing,
  --     and a suspended account stops without anyone remembering which rules
  --     they were on.
  --   recipient_emails / whatsapp_numbers / sms_numbers — hand-typed, stored
  --     verbatim, for the recipient who is deliberately not a system user (the
  --     bookkeeper, the owner's phone, the supplier rep).
  -- Comma-separated rather than child tables: short lists, always read whole
  -- with their parent, never joined and never searched.
  recipient_user_ids VARCHAR(500)  NOT NULL DEFAULT '',
  recipient_emails   VARCHAR(2000) NOT NULL DEFAULT '',
  whatsapp_numbers   VARCHAR(500)  NOT NULL DEFAULT '',
  sms_numbers        VARCHAR(500)  NOT NULL DEFAULT '',

  -- OWNERSHIP. Whose capabilities the unattended run answers to, re-checked on
  -- EVERY firing. Sharper here than for reports, because an alert can ACT: a
  -- low-stock rule that drafts purchase orders is exercising the purchasing
  -- capability while nobody is watching, so it must answer to the same check
  -- the interactive path enforces. A rule whose owner has lost access is
  -- skipped and DEACTIVATED, with the reason on its card, rather than run.
  owner_user_id   INT UNSIGNED NULL,
  created_by      INT UNSIGNED NULL,
  created_by_name VARCHAR(120) NOT NULL DEFAULT '',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  -- OBSERVABILITY ONLY — never the idempotency mechanism. The ledger below
  -- decides whether a check runs; these exist so the screen can say "checked
  -- 07:00, found 12" without a join. An alert that has been quietly failing
  -- for a week is the failure mode worth designing against, which is why
  -- last_run_error is shown on the card rather than buried in the history.
  last_run_at     DATETIME     NULL,
  last_run_status VARCHAR(20)  NOT NULL DEFAULT '',
  last_run_error  VARCHAR(500) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  KEY idx_alert_rules_active (is_active),
  CONSTRAINT fk_alert_rules_owner FOREIGN KEY (owner_user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (rule, scheduled instant).
--
-- status: 'claimed' -> 'sent' | 'failed' | 'skipped'.
--   sent    — the check RAN and whatever it found went out. Includes the happy
--             "nothing was wrong" run, which is why item_count is a column and
--             not an inference: 0 is a good day, not a failure, and a run of
--             zeroes is exactly what proves the rule is alive.
--   skipped — deliberately not run, and WHY is in error_text: too late to be
--             worth sending, or the owner lost access. A skipped row still
--             burns the claim, so the occurrence is not retried forever.
--   failed  — the check threw. Left failed so the reclaim window can retry it,
--             up to the attempt cap.
--   claimed — in flight, or a process that died mid-check. A row stuck here
--             past the reclaim window is taken over, or the rule silently
--             stops for good.
CREATE TABLE IF NOT EXISTS alert_rule_runs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id     INT UNSIGNED NOT NULL,
  due_at      DATETIME     NOT NULL,
  claimed_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status      ENUM('claimed','sent','failed','skipped') NOT NULL DEFAULT 'claimed',
  finished_at DATETIME     NULL,

  -- WHAT THE CHECK FOUND. 0 is the good day.
  item_count  INT UNSIGNED NOT NULL DEFAULT 0,

  -- WHAT THE CHECK DID — document numbers an automation created in the owner's
  -- name ("PO-000031, PO-000032"). The audit answer to "where did this order
  -- come from"; empty for every read-only rule.
  created_docs VARCHAR(500) NOT NULL DEFAULT '',

  recipients  VARCHAR(500) NOT NULL DEFAULT '',
  attempts    SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  error_text  VARCHAR(500) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  UNIQUE KEY uq_alert_rule_due (rule_id, due_at),
  KEY idx_alert_runs_status (status, due_at),
  CONSTRAINT fk_alert_runs_rule FOREIGN KEY (rule_id)
    REFERENCES alert_rules (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
