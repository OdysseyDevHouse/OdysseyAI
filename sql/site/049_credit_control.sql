-- Credit control — chasing money that is already owed.
--
-- ── WHY THIS IS NOT JUST "SEND STATEMENTS AGAIN" ─────────────────────────
--
-- A statement says what the account looks like. Dunning says what happens
-- next. The difference is escalation: the first reminder is polite, the third
-- carries a consequence, and the account that ignores all three stops being
-- allowed to buy on credit. A statement run cannot express that because it
-- treats every account identically and remembers nothing about the last time.
--
-- Three things are recorded here that a statement run has no place for:
--
--   WHERE AN ACCOUNT IS IN THE SEQUENCE. Sending reminder one four times is
--   how a debtor learns the reminders mean nothing.
--
--   WHAT WAS PROMISED. "I'll pay on Friday" is the single most common reply
--   to a reminder, and the one piece of information most often lost. A promise
--   that is written down can be broken visibly; one in someone's head cannot.
--
--   WHAT WAS ALREADY SAID. The next collector to open the account needs the
--   history, or the customer gets chased twice for the same invoice by two
--   people who each think they are first.
--
-- ── THE LEDGER STAYS THE SOURCE OF TRUTH ─────────────────────────────────
--
-- Nothing here holds a balance. Overdue amounts are read from
-- customer_transactions.amount_outstanding at the moment a run is built, and
-- snapshotted onto the item only as a record of what the letter claimed. If
-- the two ever disagree, the ledger is right and the snapshot is history.

-- ── Levels: the escalation ladder itself ─────────────────────────────────
--
-- Configurable rather than hard-coded, because the sequence is a commercial
-- decision, not a technical one. A hardware wholesaler on 30-day terms and a
-- studio invoicing monthly retainers do not chase on the same clock.
--
-- `min_days_overdue` is the gate: an account enters a level when its oldest
-- unpaid invoice is at least this many days past due. Levels are walked in
-- order, and an account only ever sits at ONE — the highest it qualifies for.

CREATE TABLE IF NOT EXISTS dunning_levels (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- 1, 2, 3… The order accounts climb. Not the id, because levels get
  -- inserted between existing ones as a policy is tuned.
  step           SMALLINT UNSIGNED NOT NULL,

  name           VARCHAR(80) NOT NULL,

  -- The gate. An account reaches this level when its oldest overdue item is
  -- this many days past its due date.
  min_days_overdue SMALLINT UNSIGNED NOT NULL,

  -- Accounts owing less than this are not chased at this level. A 14-rand
  -- rounding difference is not worth a letter, let alone a phone call, and
  -- chasing one is how a customer decides the reminders are automated noise.
  min_amount     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- What the reminder says. Placeholders are substituted at send time; the
  -- tokens are documented in the module rather than enforced here, so a
  -- typo'd token renders literally instead of failing a run.
  subject        VARCHAR(200) NOT NULL,
  body           TEXT NOT NULL,

  -- Does reaching this level suspend the account's credit? The last rung
  -- usually does. Applied only when a human posts the run, never silently.
  blocks_account TINYINT(1) NOT NULL DEFAULT 0,

  -- Whether a level requires someone to pick up the phone rather than send a
  -- letter. Late-stage collection is a conversation; the run still lists the
  -- account, it just produces a task instead of an email.
  requires_call  TINYINT(1) NOT NULL DEFAULT 0,

  is_active      TINYINT(1) NOT NULL DEFAULT 1,

  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_dunning_step (step),
  KEY idx_dunning_active (is_active, min_days_overdue)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The default ladder: a nudge, a firm reminder, a final demand.
--
-- Deliberately three. Two is not an escalation, and five means the customer
-- has learned to ignore the first three.
-- INSERT IGNORE against the unique key on `step`: a site that has already
-- rewritten its letters keeps them.
INSERT IGNORE INTO dunning_levels
  (step, name, min_days_overdue, min_amount, subject, body, blocks_account, requires_call)
VALUES
  (1, 'Friendly reminder', 7, 50.0000,
   'Your account with {company} — {overdue} outstanding',
   CONCAT(
     'Hi {customer},\n\n',
     'This is a friendly reminder that {overdue} on your account is now past due. ',
     'The oldest item is {oldest_days} days overdue.\n\n',
     '{lines}\n',
     'If you have already paid, thank you — please ignore this note and accept our apologies for the crossed wires.\n\n',
     'Kind regards\n{company}'
   ), 0, 0),

  (2, 'Second reminder', 30, 50.0000,
   'Second reminder — {overdue} overdue on your account',
   CONCAT(
     'Hi {customer},\n\n',
     'We wrote to you previously about {overdue} outstanding on your account. ',
     'That amount is still unpaid, and the oldest item is now {oldest_days} days overdue.\n\n',
     '{lines}\n',
     'Please arrange payment, or contact us to discuss the account if something is holding it up.\n\n',
     'Kind regards\n{company}'
   ), 0, 0),

  (3, 'Final demand', 60, 50.0000,
   'Final demand — {overdue} on your account',
   CONCAT(
     'Dear {customer},\n\n',
     'Despite previous reminders, {overdue} remains outstanding on your account. ',
     'The oldest item is {oldest_days} days overdue.\n\n',
     '{lines}\n',
     'Your account has been placed on hold and no further orders can be processed on credit until it is settled. ',
     'Please contact us immediately to arrange payment.\n\n',
     '{company}'
   ), 1, 1);

-- ── Runs: a batch of chasing, reviewed before it is sent ─────────────────
--
-- Modelled on customer_statement_runs, and for the same reason: two hundred
-- emails cannot be sent inside a request. The important difference is a review
-- step. A statement is a factual record and can go out unread; a final demand
-- that threatens to suspend an account is not something to send on a schedule
-- nobody looked at.
--
-- So a run is BUILT first (proposed), a human looks at it, and only then is it
-- SENT. `draft` is that pause. It is the same propose-review-post shape the
-- interest and depreciation runs use.

CREATE TABLE IF NOT EXISTS dunning_runs (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The date the run reckons overdue-ness from. Stored rather than assumed so
  -- a run built on Friday and sent on Monday still says what it said.
  as_at          DATE NOT NULL,

  --   draft     — built, awaiting review. Nothing has been sent.
  --   sending   — the queue is being worked.
  --   completed — every item reached a final state.
  --   cancelled — abandoned before sending. The proposal is kept as evidence
  --               of what was decided against.
  status         ENUM('draft','sending','completed','cancelled') NOT NULL DEFAULT 'draft',

  total_count    INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count     INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count   INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count  INT UNSIGNED NOT NULL DEFAULT 0,

  -- What the run is chasing in total, at the moment it was built. A headline
  -- number for the register; the items carry the detail.
  total_overdue  DECIMAL(14,4) NOT NULL DEFAULT 0.0000,

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  -- Who released it, separately from who built it. On a bigger book these are
  -- different people, and "who authorised the final demands" is a question
  -- worth being able to answer.
  sent_by_id     INT UNSIGNED NULL,
  sent_by_name   VARCHAR(120) NULL,

  started_at     DATETIME NULL,
  finished_at    DATETIME NULL,
  error          TEXT NULL,

  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_dunning_run_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Run items: one account, one level, one outcome ───────────────────────
--
-- The snapshot columns (overdue amounts, oldest_days) record what the letter
-- CLAIMED, not what is true now. A customer disputing "you said I owed 12,400"
-- is answered by this row; recomputing from today's ledger answers a different
-- question.

CREATE TABLE IF NOT EXISTS dunning_run_items (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  run_id         INT UNSIGNED NOT NULL,

  customer_id    INT UNSIGNED NOT NULL,
  -- Denormalised so a run reads correctly even if the account is later
  -- renamed. The letter went to the name that was on it that day.
  customer_code  VARCHAR(40) NOT NULL,
  customer_name  VARCHAR(200) NOT NULL,
  email          VARCHAR(190) NULL,

  level_id       INT UNSIGNED NULL,
  level_step     SMALLINT UNSIGNED NOT NULL,
  level_name     VARCHAR(80) NOT NULL,

  -- What was owed when the run was built.
  overdue_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  total_balance  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  oldest_days    SMALLINT NOT NULL DEFAULT 0,

  --   queued   — will be sent when the run is released.
  --   sent     — the email left successfully.
  --   failed   — it did not, and `error` says why.
  --   skipped  — deliberately not sent, and `error` says why. Kept rather
  --              than dropped: "why was Harbour Cafe not chased" is a
  --              question the run must be able to answer.
  --   excluded — a human removed it during review. Different from skipped:
  --              this was a judgement call, not a rule.
  status         ENUM('queued','sent','failed','skipped','excluded') NOT NULL DEFAULT 'queued',

  attempts       SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  error          TEXT NULL,
  sent_at        DATETIME NULL,

  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_dunning_item_run (run_id, status),
  KEY idx_dunning_item_customer (customer_id, created_at),
  CONSTRAINT fk_dunning_item_run FOREIGN KEY (run_id)
    REFERENCES dunning_runs (id) ON DELETE CASCADE,
  CONSTRAINT fk_dunning_item_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Promises to pay ──────────────────────────────────────────────────────
--
-- The most valuable thing a collector learns, and the thing most often lost.
--
-- A promise is NOT a ledger entry. No money has moved; nothing is owed
-- differently because of it. It is a commitment with a date, and its whole
-- purpose is to become visible when it is broken — which is why `status` is
-- derived from the promised date and what has been received since, rather than
-- being something someone remembers to update.
--
-- Kept even after it is kept or broken. A customer who has broken four
-- promises is a different commercial risk from one who has broken none, and
-- that pattern only exists if the history survives.

CREATE TABLE IF NOT EXISTS payment_promises (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id    INT UNSIGNED NOT NULL,

  -- When they said they would pay, and how much.
  promised_date  DATE NOT NULL,
  promised_amount DECIMAL(12,4) NOT NULL,

  -- What was outstanding when the promise was made. Without it, a promise of
  -- 5,000 against a 5,000 balance and the same promise against 50,000 look
  -- identical a month later.
  balance_at_promise DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  --   open     — the date has not arrived yet.
  --   kept     — settled. Set when enough was received, or by hand.
  --   broken   — the date passed without the money.
  --   cancelled— superseded or entered in error.
  --
  -- Stored rather than purely derived because "kept" needs a human or a
  -- payment to assert it, and because a broken promise that was later paid is
  -- still a broken promise.
  status         ENUM('open','kept','broken','cancelled') NOT NULL DEFAULT 'open',

  -- How much has been received against it. Updated when payments land, so a
  -- part-payment is visible as exactly that rather than as a clean break.
  received_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Who at the customer made the promise. "Accounts said Friday" and "the
  -- owner said Friday" are not the same commitment.
  promised_by    VARCHAR(120) NULL,
  notes          TEXT NULL,

  -- The run that prompted it, where there was one. Closes the loop between
  -- chasing and its result: this is what makes "our second reminders produce
  -- promises, our first ones don't" answerable.
  run_item_id    INT UNSIGNED NULL,

  user_id        INT UNSIGNED NULL,
  user_name      VARCHAR(120) NOT NULL DEFAULT '',

  resolved_at    DATETIME NULL,

  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_promise_customer (customer_id, status),
  -- The collector's morning query: what is due today, and what has been
  -- broken since I last looked.
  KEY idx_promise_due (status, promised_date),
  CONSTRAINT fk_promise_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_promise_run_item FOREIGN KEY (run_item_id)
    REFERENCES dunning_run_items (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Contact log: what was already said ───────────────────────────────────
--
-- One row per interaction, whether the system sent it or a person made it.
-- Both go here deliberately: a collector opening an account needs ONE list to
-- read, and a customer who was emailed on Monday and phoned on Tuesday was
-- contacted twice regardless of which side of the system did it.
--
-- Distinct from the activity log, which records what USERS did to records.
-- This records what was said to a CUSTOMER — a different audience, a different
-- retention concern, and the thing a collector actually needs on the account.

CREATE TABLE IF NOT EXISTS credit_contacts (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id    INT UNSIGNED NOT NULL,

  contact_date   DATE NOT NULL,

  --   email    — a dunning letter, usually system-sent.
  --   call     — someone picked up the phone.
  --   note     — an internal observation with no outward contact.
  --   meeting  — a visit or a scheduled conversation.
  --   letter   — posted, or handed over.
  kind          ENUM('email','call','note','meeting','letter') NOT NULL DEFAULT 'note',

  -- What came of it. Nullable because a note has no outcome and a sent email
  -- has no reply yet.
  --   promised     — they committed to a date. Usually paired with a promise.
  --   disputed     — they say something is wrong. Chasing should pause.
  --   no_answer    — nobody reached.
  --   paid         — settled on the spot.
  --   refused      — they will not pay. An escalation decision, not a chase.
  outcome       ENUM('promised','disputed','no_answer','paid','refused','none') NOT NULL DEFAULT 'none',

  summary       VARCHAR(300) NOT NULL,
  detail        TEXT NULL,

  -- What was owed at the time, so the history reads without reconstructing
  -- the ledger at every past date.
  balance_at    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Set when the system logged this itself, so a hand-written note and an
  -- automated send are distinguishable in the same list.
  run_item_id   INT UNSIGNED NULL,
  promise_id    INT UNSIGNED NULL,

  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',

  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_contact_customer (customer_id, contact_date),
  CONSTRAINT fk_contact_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE,
  CONSTRAINT fk_contact_run_item FOREIGN KEY (run_item_id)
    REFERENCES dunning_run_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_contact_promise FOREIGN KEY (promise_id)
    REFERENCES payment_promises (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Where each account sits, right now ───────────────────────────────────
--
-- One row per account, holding the state that would otherwise have to be
-- reconstructed by scanning every run ever made.
--
-- The important column is `dunning_level`. Without it there is no escalation:
-- every run would compute "this account is 45 days overdue" and send the same
-- level-2 letter forever. With it, an account that has already had its level-2
-- letter moves to level 3 next time rather than repeating itself.
--
-- `hold_reason` records WHY credit was suspended. customers.status already
-- carries on_hold, and this does not duplicate it — it explains it, and
-- remembers that the hold came from collections rather than from a manager.

CREATE TABLE IF NOT EXISTS customer_credit_status (
  customer_id    INT UNSIGNED NOT NULL,

  -- The highest level this account has actually been sent. 0 = never chased.
  dunning_level  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  last_dunned_at DATE NULL,
  last_run_id    INT UNSIGNED NULL,

  -- Pause chasing without changing anything else. A disputed invoice, an
  -- agreed payment plan, a customer in the middle of a claim — all reasons to
  -- stop the letters while the debt stands.
  paused_until   DATE NULL,
  pause_reason   VARCHAR(200) NULL,

  -- Set when collections suspended the account, so releasing it is a
  -- deliberate act with a record rather than someone flipping status back.
  held_at        DATETIME NULL,
  hold_reason    VARCHAR(200) NULL,

  -- Counters, maintained as promises resolve. Denormalised because "has this
  -- customer broken promises before" is asked on every collection call, and
  -- counting rows on each one is a scan nobody needs.
  promises_made  INT UNSIGNED NOT NULL DEFAULT 0,
  promises_kept  INT UNSIGNED NOT NULL DEFAULT 0,
  promises_broken INT UNSIGNED NOT NULL DEFAULT 0,

  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (customer_id),
  KEY idx_credit_level (dunning_level, last_dunned_at),
  CONSTRAINT fk_credit_status_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Settings ─────────────────────────────────────────────────────────────

-- INSERT IGNORE rather than a conditional insert: a site that has already
-- tuned these keeps its own values.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('credit_control_enabled', '1'),
  -- Days after a promised date before the promise is treated as broken. A
  -- little grace stops a payment that cleared on Monday morning from marking
  -- Friday's promise broken over the weekend.
  ('promise_grace_days', '2'),
  -- Minimum days between two letters to the same account, whatever the levels
  -- say. The guard against a mis-set ladder chasing someone daily.
  ('dunning_min_gap_days', '7');
