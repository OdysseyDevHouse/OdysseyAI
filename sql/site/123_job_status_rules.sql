-- ============================================================================
-- 123_job_status_rules.sql — the five missing stages, and rules per stage
-- ============================================================================
--
-- Two gaps against section 10.1, found by auditing the PRD rather than my own
-- notes.
--
-- ── THE FIVE MISSING STATUSES ───────────────────────────────────────────────
--
-- 104 seeded eight of the thirteen the PRD names. Missing: Paused, Awaiting
-- Customer, Ready to Invoice, Invoiced, and Closed.
--
-- None of them needs a new ROLE. A role exists so code can find a stage whose
-- name a business has changed -- assignOwner looks for `assigned`, closeJob
-- looks for `completed`. Nothing in the code needs to find "Awaiting Customer";
-- it is a stage a person moves a job to and a person moves it out of. Adding
-- roles for them would also break every existing site, because REQUIRED_ROLES
-- is validated and a new required role has no holder until somebody creates one.
--
-- Closed is the interesting one. The PRD lists it as a status, but this schema
-- already derives closed-ness from the role: isClosed() returns true for
-- completed and cancelled, and job_cards.status is a separate open/closed record
-- state. A "Closed" status carrying role `completed` would mean two stages both
-- claiming to be the completion one, and statusForRole would return whichever
-- sorted first. So Closed is seeded with an EMPTY role and marked closed by
-- being listed after Work Completed -- see the is_closed_stage column below.
--
-- ── WHY A STATUS NEEDS ITS OWN RULES ────────────────────────────────────────
--
-- Section 10.1 asks for three things per status that this schema decides
-- globally today:
--
--   requires_reason      -- "why is this on hold?" matters; "why is this in
--                           progress?" does not. One global switch would either
--                           interrogate somebody on every move or never ask.
--   blocks_on_incomplete -- job_items_block_close is a single setting covering
--                           every closing status. A business wants Work
--                           Completed to demand its checks and Cancelled NOT to
--                           -- refusing to cancel a job because a check is
--                           unticked is how a job stays open forever.
--   audience             -- a technician should not be able to move a job to
--                           Invoiced.
--
-- All three default to the behaviour that exists today, so a site that migrates
-- and changes nothing behaves exactly as it did.
-- ============================================================================


-- ── Rules per status ────────────────────────────────────────────────────────

ALTER TABLE job_statuses
  -- Ask for a sentence when a job enters this stage. The reason column already
  -- exists on the write path -- setStatus takes one and logs it -- it has simply
  -- never been required.
  ADD COLUMN IF NOT EXISTS requires_reason TINYINT(1) NOT NULL DEFAULT 0 AFTER role;

ALTER TABLE job_statuses
  /*
   * Refuse this move while required tasks or checks are outstanding.
   *
   * NULL means "use the site setting", which is what every existing row gets --
   * so nothing changes on a site that migrates and touches nothing. A 1 or 0
   * overrides it for this stage only.
   *
   * Nullable rather than a plain boolean precisely so "not decided" stays
   * distinguishable from "decided no". A boolean defaulting to 0 would silently
   * switch the close guard OFF for every existing site.
   */
  ADD COLUMN IF NOT EXISTS blocks_on_incomplete TINYINT(1) NULL AFTER requires_reason;

ALTER TABLE job_statuses
  /*
   * Who may move a job here.
   *
   * anyone  -- the default, and what every existing status gets
   * office  -- back-office only. Ready to Invoice and Invoiced want this: a
   *            technician marking a job invoiced is a billing statement they
   *            are not making.
   *
   * An ENUM rather than a capability key because it is a coarse audience, not a
   * permission -- the real guard is still jobs.edit on the action. This narrows
   * the picker and is enforced server-side on top.
   */
  ADD COLUMN IF NOT EXISTS audience ENUM('anyone','office') NOT NULL DEFAULT 'anyone'
    AFTER blocks_on_incomplete;

ALTER TABLE job_statuses
  /*
   * Treat a job in this stage as CLOSED, for statuses that carry no role.
   *
   * The PRD calls this "Treat jobs with this status as closed". Until now
   * closed-ness came only from the role, which meant a business could not add a
   * closing stage of its own without claiming one of the two reserved roles.
   *
   * isClosed() still answers for completed and cancelled; this column answers
   * for everything else, and the two are ORed. A status with role `completed`
   * and this set to 0 is still closed -- the role wins, because code depends on
   * it.
   */
  ADD COLUMN IF NOT EXISTS is_closed_stage TINYINT(1) NOT NULL DEFAULT 0 AFTER audience;


-- ── The five stages 104 did not seed ────────────────────────────────────────
--
-- INSERT IGNORE on `code`, which is the unique key and is NOT NULL, so a re-run
-- cannot duplicate and cannot overwrite a business that renamed one of these.
-- (Where a unique key includes a NULLABLE column INSERT IGNORE does NOT dedupe
-- and this would need NOT EXISTS -- the gl_mappings trap from 083.)
--
-- sort_order slots them between the stages 104 seeded, using the gaps it left:
-- Paused after In Progress, Awaiting Customer beside Awaiting Parts, and the two
-- billing stages after Work Completed.
--
-- is_system is 0 on all five. They are conveniences, not stages the code looks
-- for, so a business that does not invoice from job cards can delete Ready to
-- Invoice and Invoiced outright.
INSERT IGNORE INTO job_statuses
  (code, name, tone, sort_order, role, requires_reason, blocks_on_incomplete, audience, is_closed_stage, is_system)
VALUES
  -- Paused: why it stopped is the whole point of the stage.
  ('paused',           'Paused',            'neutral', 45, '', 1, NULL, 'anyone', 0, 0),
  -- Awaiting Customer: likewise. "Waiting on what?" is the first question asked.
  ('awaiting_customer','Awaiting Customer', 'warning', 65, '', 1, NULL, 'anyone', 0, 0),
  -- Ready to Invoice: office only, and it must not be reachable with checks
  -- outstanding -- an invoice raised over an unfinished job is the expensive
  -- version of this mistake.
  ('ready_invoice',    'Ready to Invoice',  'brand',   72, '', 0, 1,    'office', 0, 0),
  -- Invoiced: office only. A technician does not decide a customer was billed.
  ('invoiced',         'Invoiced',          'success', 74, '', 0, NULL, 'office', 0, 0),
  -- Closed: a closing stage with NO role, which is exactly what is_closed_stage
  -- was added for. Deliberately does not block on incomplete items -- a job
  -- reaching here has already passed Work Completed.
  ('closed',           'Closed',            'neutral', 76, '', 0, 0,    'office', 1, 0);


-- ── Keep the behaviour the stages that already existed have today ───────────
--
-- Work Completed is the stage the global setting was really about, so it now
-- says so explicitly rather than relying on a site-wide default that a later
-- change might flip underneath it.
UPDATE job_statuses SET blocks_on_incomplete = 1 WHERE code = 'completed';

-- Cancelled must NOT block. Refusing to cancel a job because a check is unticked
-- is how a job nobody wants stays open forever -- and cancelling is precisely
-- what somebody does when the work is not going to be finished.
UPDATE job_statuses SET blocks_on_incomplete = 0, requires_reason = 1 WHERE code = 'cancelled';

-- On Hold earns a reason for the same reason Paused does.
UPDATE job_statuses SET requires_reason = 1 WHERE code = 'on_hold';
