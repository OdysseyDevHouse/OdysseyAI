-- ── Tickets: inbound support, timed by the lane it sits in (3) ──────────────
--
-- The PRD says a ticket "works like a job card but is a separate module", and
-- this is the one item of the programme that is a SECOND PRODUCT rather than a
-- gap in the first.
--
-- ── WHAT IT DELIBERATELY HAS NOT GOT ────────────────────────────────────────
--
-- No lines. No billing state. No invoice link. No costing.
--
-- That is the decision that keeps this affordable: the moment a ticket carries
-- money it is a job card with a different name, and every rule in jobCards.ts
-- would need a second implementation that could then disagree with the first.
-- A ticket that needs billing becomes a job, through tickets.job_card_id, and
-- the money happens there under the one costing engine.
--
-- ── WHAT IT SHARES, AND WHY NO MIGRATION IS NEEDED FOR IT ───────────────────
--
-- party_comments.entity, party_documents.entity and activity_log.entity are all
-- free-text VARCHAR, checked rather than assumed. So comments, files and the
-- audit trail work for a ticket the moment something writes 'ticket' into them.
-- Three copies of those tables would be three more places for an internal note
-- to leak, and 131 has only just finished making that split trustworthy.

CREATE TABLE IF NOT EXISTS tickets (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- TK000001. Claimed from document_sequences, like every other numbered thing.
  document_number VARCHAR(32)  NULL,

  customer_id     INT UNSIGNED NULL,
  contact_id      INT UNSIGNED NULL,

  subject         VARCHAR(190) NOT NULL,
  description     TEXT         NULL,

  -- The SAME four as job_cards, deliberately. A business that calls something
  -- urgent on a job means the same word on a ticket, and two priority
  -- vocabularies would make a combined worklist impossible to sort.
  priority        ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',

  status_id       INT UNSIGNED NOT NULL,

  -- ── THIS COLUMN IS A CONTRACT, NOT A CONVENIENCE ──────────────────────────
  --
  -- verifySequence hard-codes
  --
  --   SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS voided
  --
  -- against whatever table OWN_TABLE_TYPES names (sequences.ts:648), and its
  -- header states the contract: "Each table must carry document_number, id and
  -- a status whose void value is 'cancelled'."
  --
  -- Without this column every TK number ever issued reports as MISSING. That
  -- omission has bitten four times already — stock takes, job cards, customer
  -- assets, laybys — and each time it was found long after the fact. 116 added
  -- a status column to customer_assets for this reason alone.
  --
  -- It is also the derived open/closed state, exactly as on job_cards: status_id
  -- is the configurable stage, status is what every report and guard reads.
  status          ENUM('open','closed','cancelled') NOT NULL DEFAULT 'open',

  -- ── WHO OWNS IT, AND WHOSE TIME IT IS ─────────────────────────────────────
  --
  -- The assignee. Your decision, and it decides the timing model: a segment in
  -- ticket_time_entries is credited to whoever the ticket is ASSIGNED to, never
  -- to whoever dragged the card. A dispatcher moving twenty tickets through the
  -- board must not appear to have done twenty tickets of work.
  --
  -- Name snapshotted with no FK on the name, the house convention: a record is
  -- evidence and must outlive the user row somebody tidies away.
  assignee_user_id INT UNSIGNED NULL,
  assignee_name    VARCHAR(120) NOT NULL DEFAULT '',

  -- Where it came from, for reporting. Mirrors job_cards.source minus the two
  -- values that only make sense for work raised from a quote.
  source          ENUM('manual','phone','email','walk_in','internal','portal','public_form')
                    NOT NULL DEFAULT 'manual',

  category        VARCHAR(60)  NULL,

  reported_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at          DATETIME NULL,
  closed_at       DATETIME NULL,
  close_reason    VARCHAR(400) NULL,
  cancelled_at    DATETIME NULL,
  cancel_reason   VARCHAR(400) NULL,

  -- ── THE TICKET THAT BECAME A SITE VISIT ───────────────────────────────────
  --
  -- SET NULL, not CASCADE. A ticket that produced a job is evidence that
  -- somebody asked, and deleting the job must not destroy the record of the
  -- request. Same reasoning as job_requests (129) and job_part_requests (162).
  job_card_id     INT UNSIGNED NULL,

  -- Service targets, stamped the way a job stamps its own: the DEADLINE is stored
  -- so it cannot be restated by a later change to the trading week, and the
  -- BREACH is derived on read. 113 argues both at length.
  sla_policy_id   INT UNSIGNED NULL,
  respond_by      DATETIME NULL,
  resolve_by      DATETIME NULL,
  responded_at    DATETIME NULL,
  responded_by_user_id INT UNSIGNED NULL,

  user_id         INT UNSIGNED NULL,
  user_name       VARCHAR(120) NOT NULL DEFAULT '',

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_ticket_number (document_number),

  -- The board read: every open ticket in a lane, newest first.
  KEY ix_ticket_status (status_id, status, reported_at),
  KEY ix_ticket_customer (customer_id, status),
  KEY ix_ticket_assignee (assignee_user_id, status),
  KEY ix_ticket_job (job_card_id),
  -- "Who is waiting for a reply", the same shape 113 indexes on job_cards.
  KEY ix_ticket_respond (status, responded_at, respond_by),

  CONSTRAINT fk_ticket_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE SET NULL,
  CONSTRAINT fk_ticket_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── The lanes ───────────────────────────────────────────────────────────────
--
-- A copy of job_statuses, not a shared table. A ticket moves Open -> Waiting on
-- customer -> Resolved; a job moves New -> Assigned -> In Progress -> Work
-- Completed. Sharing one table would put ticket stages on every job board and
-- job stages on every ticket board, and `role`, which code looks statuses up by,
-- would have to carry both vocabularies at once.
--
-- The honest cost is two status editors and two board editors. That is the price
-- of section 3 asking for a separate module rather than a job card variant.

CREATE TABLE IF NOT EXISTS ticket_statuses (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code        VARCHAR(40)  NOT NULL,
  name        VARCHAR(60)  NOT NULL,

  -- A Badge tone, never a hex, so a lane stays legible in both themes and the
  -- kit can restyle every board from one file.
  tone        ENUM('neutral','brand','success','warning','danger') NOT NULL DEFAULT 'neutral',
  sort_order  INT          NOT NULL DEFAULT 0,

  -- ── THE LANE OWNS THE CLOCK ───────────────────────────────────────────────
  --
  -- Dragging a ticket into a lane does this to its clock:
  --
  --   start   the clock runs while the ticket sits here
  --   pause   the clock stops and the ticket stays open
  --   end     the clock stops for good
  --   ''      this lane does nothing to the clock, which is most lanes
  --
  -- ONE ENUM, NOT THREE BOOLEANS. Three flags would permit start AND end on the
  -- same lane, which is a shape no screen can render and no arithmetic can
  -- resolve. The same reasoning makes job_statuses.role a single enum.
  --
  -- At most one lane may hold each value, enforced in code the way setRole does
  -- for job statuses: setting `start` here clears it from whichever lane had it.
  -- A unique key cannot express that, because '' must be allowed many times.
  clock       ENUM('','start','pause','end') NOT NULL DEFAULT '',

  -- Where a new ticket lands. EXACTLY ONE, and also enforced in code — a board
  -- with two landing lanes has no answer to "where does this go".
  is_landing  TINYINT(1) NOT NULL DEFAULT 0,

  -- Counts as done, and stops the SLA resolution clock. ONE OR MORE: a team
  -- that finishes work in both "Resolved" and "Closed" flags both, and tickets
  -- in either count. At least one must exist, or the queue has no exit.
  is_closed_stage TINYINT(1) NOT NULL DEFAULT 0,

  -- Cancelled rather than completed. Separate from is_closed_stage because a
  -- cancelled ticket is closed but was NOT done, and every report needs to tell
  -- those apart — the same split job_cards makes between closed and cancelled.
  is_cancelled_stage TINYINT(1) NOT NULL DEFAULT 0,

  is_system   TINYINT(1) NOT NULL DEFAULT 0,
  is_active   TINYINT(1) NOT NULL DEFAULT 1,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_tstatus_code (code),
  KEY ix_tstatus_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── Boards: saved views over lanes ──────────────────────────────────────────
--
-- A board stores no tickets. It names which lanes it shows, so the same ticket
-- appears on every board showing its lane — the shape job_boards already uses,
-- and the answer to question 1 of section 46 of the PRD.

CREATE TABLE IF NOT EXISTS ticket_boards (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name        VARCHAR(60)  NOT NULL,
  description VARCHAR(190) NULL,
  sort_order  INT          NOT NULL DEFAULT 0,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_tboard_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_board_statuses (
  board_id   INT UNSIGNED NOT NULL,
  status_id  INT UNSIGNED NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (board_id, status_id),
  KEY ix_tbs_status (status_id),
  CONSTRAINT fk_tbs_board FOREIGN KEY (board_id)
    REFERENCES ticket_boards (id) ON DELETE CASCADE,
  CONSTRAINT fk_tbs_status FOREIGN KEY (status_id)
    REFERENCES ticket_statuses (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── The clock ledger ────────────────────────────────────────────────────────
--
-- ── A LEDGER, NOT A minutes_worked COLUMN ───────────────────────────────────
--
-- A running total is a figure nobody can audit and that goes wrong silently.
-- The same argument 113 makes about breach and 104 makes about open/closed: the
-- raw fact is what an argument is about. A ledger answers "how long did this
-- take" AND "who had it, and when", which is the question a support manager
-- actually asks. jobTime works this way already, so the reporting shape is one
-- people have seen.
--
-- ── THE TIMESTAMPS ARE REAL; THE MINUTES ARE DERIVED ────────────────────────
--
-- started_at and ended_at are wall-clock instants. Business minutes are computed
-- on READ, through businessMinutesBetween() and the trading week — the same
-- clock the SLA runs on, which is your decision and the reason the two figures
-- on one screen can never disagree.
--
-- Storing the minutes would freeze them against the trading week as it stood at
-- the time, and a business that changes its hours would then have two eras of
-- incomparable numbers with nothing on screen saying so.

CREATE TABLE IF NOT EXISTS ticket_time_entries (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id     INT UNSIGNED NOT NULL,

  -- Whose time. The ASSIGNEE at the moment the segment opened, snapshotted:
  -- reassigning mid-flight closes this segment and opens a new one against the
  -- new person, so a stretch of work cannot land on whoever happens to hold the
  -- ticket at the end.
  user_id       INT UNSIGNED NULL,
  user_name     VARCHAR(120) NOT NULL DEFAULT '',

  started_at    DATETIME NOT NULL,
  ended_at      DATETIME NULL,

  -- Which move opened and closed the segment, so the ledger explains itself
  -- without joining the activity log.
  from_status_id INT UNSIGNED NULL,
  to_status_id   INT UNSIGNED NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- "What is open right now", for the per-user cap and the running indicator.
  KEY ix_tte_open (user_id, ended_at),
  KEY ix_tte_ticket (ticket_id, started_at),

  CONSTRAINT fk_tte_ticket FOREIGN KEY (ticket_id)
    REFERENCES tickets (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── SLA: one flag, not a second policy table ────────────────────────────────
--
-- A support promise differs from a site-visit promise, so a policy says which it
-- is. Everything else is reused: the business-hours arithmetic, per-customer
-- selection from 164, and escalateOverdue() on the alerts tick.
ALTER TABLE job_sla_policies
  ADD COLUMN IF NOT EXISTS for_tickets TINYINT(1) NOT NULL DEFAULT 0;

-- ── The escalation claim has to say WHICH KIND of record ────────────────────
--
-- uq_sla_escalation is (job_card_id, kind) today. Put a ticket id in that column
-- and ticket 5 collides with job 5 — which does not error, it SILENTLY SUPPRESSES
-- a real escalation. That is the worst failure mode available here, because it
-- fails quietly and in a different module from the one that caused it.
--
-- So the claim gains a record type, and the unique key is rebuilt around it.
-- All three columns NOT NULL, so unlike the 164 policy key this one really does
-- dedupe.
ALTER TABLE job_sla_escalations
  ADD COLUMN IF NOT EXISTS record_type ENUM('job','ticket') NOT NULL DEFAULT 'job'
    AFTER job_card_id;

-- ── THE FOREIGN KEY GOES FIRST, AND IT HAS TO ───────────────────────────────
--
-- Dropping the unique key while fk_slaesc_job still exists fails outright:
--
--   Cannot drop index 'uq_sla_escalation': needed in a foreign key constraint
--
-- InnoDB uses whatever index covers the FK column, and uq_sla_escalation is the
-- one leading with job_card_id. So the constraint is dropped first, then the
-- index it was leaning on.
--
-- The FK cannot come back: the column now holds a ticket id half the time, and
-- a foreign key cannot point at two tables. What is lost is the CASCADE that
-- cleaned up claims when a job was deleted, so reconcileTickets reports orphans
-- instead — a report rather than a repair, per the module rule.
ALTER TABLE job_sla_escalations
  DROP FOREIGN KEY IF EXISTS fk_slaesc_job;

-- Standalone DROP INDEX, matching 092 and 164: MariaDB takes IF EXISTS in that
-- form, and the ALTER TABLE ... DROP INDEX IF EXISTS spelling is the one to
-- distrust.
DROP INDEX IF EXISTS uq_sla_escalation ON job_sla_escalations;

ALTER TABLE job_sla_escalations
  ADD UNIQUE KEY IF NOT EXISTS uq_sla_escalation (record_type, job_card_id, kind);


-- ── Numbering ───────────────────────────────────────────────────────────────
--
-- INSERT IGNORE is safe HERE: document_sequences has a composite PRIMARY KEY on
-- (terminal_id, doc_type) and BOTH columns are NOT NULL, so the key genuinely
-- dedupes. That is the test 113 applied to its own seed and 164 failed.
INSERT IGNORE INTO document_sequences (terminal_id, doc_type, prefix, next_number, padding)
SELECT id, 'ticket', 'TK', 1, 6 FROM terminals;


-- ── Seed lanes ──────────────────────────────────────────────────────────────
--
-- Modelled on the board you already run: a landing lane, a running lane, a
-- paused lane and two closed lanes. Exactly one landing, one of each clock flag,
-- and TWO closed stages — because your team finishes work in both Resolved and
-- Closed, and the plural is the point.
--
-- NOT EXISTS on the code, so a re-run cannot reset a lane somebody has renamed.
INSERT INTO ticket_statuses (code, name, tone, sort_order, clock, is_landing, is_closed_stage, is_cancelled_stage, is_system)
SELECT * FROM (
  SELECT 'new'         AS code, 'New'         AS name, 'brand'   AS tone, 10 AS sort_order, ''      AS clock, 1 AS is_landing, 0 AS is_closed_stage, 0 AS is_cancelled_stage, 1 AS is_system
  UNION ALL SELECT 'in_progress', 'In Progress', 'brand',   20, 'start', 0, 0, 0, 1
  UNION ALL SELECT 'on_hold',     'On Hold',     'warning', 30, 'pause', 0, 0, 0, 1
  UNION ALL SELECT 'resolved',    'Resolved',    'success', 40, 'end',   0, 1, 0, 1
  UNION ALL SELECT 'closed',      'Closed',      'neutral', 50, '',      0, 1, 0, 1
  UNION ALL SELECT 'cancelled',   'Cancelled',   'danger',  60, '',      0, 1, 1, 1
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM ticket_statuses WHERE ticket_statuses.code = seed.code);

INSERT INTO ticket_boards (name, description, sort_order)
SELECT 'Support', 'Everything the desk is working on', 10
WHERE NOT EXISTS (SELECT 1 FROM ticket_boards WHERE name = 'Support');

-- Every seeded lane on the seeded board, in lane order.
INSERT IGNORE INTO ticket_board_statuses (board_id, status_id, sort_order)
SELECT b.id, s.id, s.sort_order
  FROM ticket_boards b
  JOIN ticket_statuses s
 WHERE b.name = 'Support';


-- ── Settings ────────────────────────────────────────────────────────────────
--
-- How many tickets one person may have running at once.
--
-- 0 means NO CAP, and 0 is the default. A cap that switched itself on at some
-- arbitrary number the morning after a migration would start refusing work
-- nobody asked it to refuse.
--
-- This is enforced in CODE, not by an index, and that is safe only because
-- ticket time is never billed. jobTime.ts:27 explains the difference: job time
-- has an unrelaxable generated-column constraint precisely because an hour
-- billed twice cannot be recovered. Nothing here is billed, so a configurable
-- cap costs nothing if it is occasionally exceeded by a race.
INSERT INTO settings (setting_key, setting_value)
SELECT 'ticket_max_running_per_user', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'ticket_max_running_per_user');
