-- ─────────────────────────────────────────────────────────────────────────
-- Workflow rules on a job (§12): when this happens, if that is true, do this.
--
-- ── WHY THIS IS NOT MORE AlertKinds ──────────────────────────────────────
--
-- The plan said to extend the alerts builder, and that was the right instinct:
-- it already has conditions, recipients, four delivery channels, a run ledger
-- and a claim-before-work discipline this file copies wholesale.
--
-- What does not fit is its CLOCK. An alert rule is scheduled: the tick computes
-- the most recent due instant, claims (rule_id, due_at), and evaluates. That
-- pairing is what makes it idempotent, and it is the whole design.
--
-- Most of what §12 asks for has no due_at. "When a job is assigned", "when a
-- quote is accepted", "when a status is entered" are EVENTS — they happen at a
-- moment nobody scheduled, and there is nothing to compute a due instant from.
--
-- Forcing them into the scheduler means polling: a daily rule asking "which jobs
-- are in Awaiting Parts now". That fails twice. A notification meant for the
-- moment somebody is given a job arrives up to a day later, which is not a
-- notification. And a job that entered a status and left it again before the
-- poll ran is INVISIBLE — the rule never fires, and nothing anywhere says why.
--
-- So this is an event table with an event dispatcher, and the time-based job
-- automations (121) stay exactly where they are on the daily tick. Two clocks,
-- each doing what it is shaped for.
--
-- ── WHAT IS REUSED RATHER THAN REBUILT ───────────────────────────────────
--
-- alerts/deliver.ts for the sending, jobNotify for the audience and consent,
-- and the claim ledger below is the same shape as alert_rule_runs and
-- job_automation_runs: claim first, then work, so a crash leaves a visible
-- orphan rather than a silent repeat.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS job_rules (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name        VARCHAR(190) NOT NULL,
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,

  /*
   * WHEN. One trigger per rule, deliberately.
   *
   * A rule that fired on several events would need its actions to make sense
   * for all of them, and the first person to add a third event to an existing
   * rule discovers its action only ever made sense for the first. Two rules is
   * the honest way to say "on either of these".
   */
  trigger_event ENUM(
    'created',
    'status_entered',
    'status_exited',
    'priority_changed',
    'assigned',
    'closed',
    'quote_accepted',
    'quote_declined',
    'part_requested',
    'part_received',
    'form_submitted'
  ) NOT NULL,

  -- For status_entered / status_exited: WHICH status. NULL means any, which is
  -- how "tell me about every status change" is expressed.
  trigger_status_id INT UNSIGNED NULL,

  /*
   * IF. Every condition is optional and they AND together.
   *
   * Not an expression tree, and this is the same call 222 made about conditional
   * form fields: an AND/OR editor is the shape that never ships, because nobody
   * can read one back six months later. Four optional filters cover what people
   * actually write, and two rules cover the rest.
   */
  /*
   * "Is the job on this board" — which is a question about its STATUS.
   *
   * There is no job_cards.board_id, and 104 says at length why: a board is a
   * saved view over statuses and holds no jobs, so a job appears on every
   * board that lists the status it is in. The condition is therefore
   * evaluated as "does this board list the job's status", not as a column
   * comparison.
   */
  if_board_id     INT UNSIGNED NULL,
  if_priority     ENUM('low','normal','high','urgent') NULL,
  if_headline_id  INT UNSIGNED NULL,
  -- Only when the job has been sitting still this long. The one condition that
  -- is about TIME rather than shape, and it is why a rule can say "escalate a
  -- job reassigned after a week of silence" without needing a scheduler.
  if_idle_hours   INT UNSIGNED NULL,

  /*
   * THEN. Every action is optional; a rule with none is refused in code rather
   * than by the schema, because "which of these five is set" is not a constraint
   * MariaDB can express readably.
   */
  do_notify       TINYINT(1) NOT NULL DEFAULT 0,
  do_status_id    INT UNSIGNED NULL,
  do_priority     ENUM('low','normal','high','urgent') NULL,
  /*
   * NO do_board_id, and the absence is the same feature 104 named.
   *
   * "Move it to the Workshop board" cannot be an action, because nothing is
   * stored that would make it true. The only way a job reaches a board is by
   * being in a status that board lists — which do_status_id already does,
   * honestly and visibly.
   *
   * An action that wrote a board would have to invent a column, and that
   * column would make a job belong to exactly one board: the contradiction
   * 104 refused, arriving through the back door of an automation.
   */
  -- Somebody who should hear about this job from now on, added as a follower.
  do_follower_user_id INT UNSIGNED NULL,

  -- What the notification says. Blank uses a sentence built from the event.
  message     VARCHAR(400) NOT NULL DEFAULT '',

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- The dispatcher's own read: every live rule for one event.
  KEY ix_jobrule_event (is_active, trigger_event),

  -- SET NULL on all four: a rule must not vanish because somebody retired a
  -- board or a status. It becomes broader (any status, any board) and stays
  -- visible on the setup screen, where a person can decide what it should say
  -- now. A cascade would delete rules nobody knew they had.
  CONSTRAINT fk_jobrule_trigger_status FOREIGN KEY (trigger_status_id)
    REFERENCES job_statuses (id) ON DELETE SET NULL,
  CONSTRAINT fk_jobrule_do_status FOREIGN KEY (do_status_id)
    REFERENCES job_statuses (id) ON DELETE SET NULL,
  CONSTRAINT fk_jobrule_if_board_only FOREIGN KEY (if_board_id)
    REFERENCES job_boards (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── The run ledger, and the loop guard ───────────────────────────────────
--
-- Every firing is claimed BEFORE its actions run, on the precedent
-- job_automation_runs sets: claiming after would mean a crash between doing and
-- recording repeats the work, and claiming before leaves a visible orphan.
--
-- ── WHY THIS IS ALSO THE LOOP PROTECTION ─────────────────────────────────
--
-- 121_job_automations.sql named loop detection as a cost it was avoiding, and it
-- was right to: with four hardcoded automations, none of which triggered
-- another, there was nothing to protect against.
--
-- A rule engine has exactly that problem. A rule that moves a job to a status
-- fires status_entered, which may match a rule that moves it back. Nothing in
-- the schema can forbid that, and nothing should — two rules that happen to
-- disagree is a business's mistake to make and see.
--
-- What must not happen is the machine spinning. So: one row per
-- (rule, job, event occurrence), and the dispatcher refuses to fire a rule that
-- has already fired for this job within the cooldown. A ping-pong pair
-- therefore bounces once and then stops, leaving two rows that say exactly what
-- happened rather than a log nobody can read.
CREATE TABLE IF NOT EXISTS job_rule_runs (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  rule_id     INT UNSIGNED NOT NULL,
  job_card_id INT UNSIGNED NOT NULL,

  status      ENUM('claimed','done','failed') NOT NULL DEFAULT 'claimed',

  -- What it did, for the activity trail and for somebody asking why a job moved.
  -- §12 requires every automated action to name the rule responsible.
  detail      VARCHAR(400) NOT NULL DEFAULT '',

  claimed_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,

  PRIMARY KEY (id),

  -- The cooldown probe: has this rule already fired for this job, recently.
  KEY ix_jobrulerun_guard (rule_id, job_card_id, claimed_at),

  CONSTRAINT fk_jobrulerun_rule FOREIGN KEY (rule_id)
    REFERENCES job_rules (id) ON DELETE CASCADE,
  CONSTRAINT fk_jobrulerun_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
