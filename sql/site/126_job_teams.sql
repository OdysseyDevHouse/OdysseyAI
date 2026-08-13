-- ============================================================================
-- 126_job_teams.sql — "the North crew", as a thing you can name once
-- ============================================================================
--
-- The remaining half of section 16. Phase 14 shipped the other half: several
-- people on one job, via job_card_people. What it did not give anybody is a way
-- to say "the North crew" and have three names appear.
--
-- ── A TEAM IS A SHORTCUT, NOT AN OWNER ──────────────────────────────────────
--
-- This is the decision the whole migration rests on, so it is written here
-- rather than discovered later.
--
-- A team does NOT get assigned to a job. Selecting one EXPANDS into individual
-- job_card_people rows, and from that moment the job knows only the people.
--
-- Storing job_cards.team_id instead would have been fewer rows and worse in
-- every way that matters:
--
--   * "Whose jobs are these?" becomes a two-level question. Every existing
--     query -- my-work, the board lanes, the technician dashboard, the workload
--     figures -- reads job_card_people, and each would need to learn about a
--     second source or silently miss half the answer.
--   * Editing a team would rewrite history. Take Sipho off the North crew in
--     March and every January job would retroactively claim he was never on it.
--   * A person is on a job for a reason. Somebody swapped in for one afternoon
--     is not a member of the crew, and a team FK has nowhere to put them.
--
-- Expanding at the moment of assignment keeps the snapshot rule this schema
-- follows everywhere else: names, prices and rates are all copied at the moment
-- they are used, precisely so a later edit cannot rewrite what happened.
--
-- The cost, stated plainly: after expansion nothing records that the crew was
-- chosen rather than three people picked individually. That is acceptable --
-- the activity log names the team in its detail line, and no figure anywhere
-- depends on knowing.
-- ============================================================================


CREATE TABLE IF NOT EXISTS job_teams (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name        VARCHAR(80)  NOT NULL,

  -- What the crew is for, in a line. Shown in the picker, because "North" means
  -- nothing to somebody who joined last week.
  description VARCHAR(190) NULL,

  -- Retired rather than deleted, so a crew that stops being used keeps its name
  -- out of the picker without breaking anything that mentions it.
  is_active   TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order  INT          NOT NULL DEFAULT 0,

  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- Two crews called "North" is a typo, not a plan.
  UNIQUE KEY uq_team_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


CREATE TABLE IF NOT EXISTS job_team_members (
  team_id   INT UNSIGNED NOT NULL,

  -- cp2_users.id from the CONTROL database, so no foreign key is possible. The
  -- name is snapshotted for the same reason every other user reference in this
  -- schema snapshots it: no cross-database join exists, and a rename must not
  -- rewrite history.
  --
  -- Note that this snapshot is the CURRENT membership list, not a historical
  -- one -- see the header. History lives in job_card_people, which took its own
  -- copy when the team was expanded.
  user_id   INT UNSIGNED NOT NULL,
  user_name VARCHAR(120) NOT NULL DEFAULT '',

  /*
   * The one who leads when this crew is put on a job.
   *
   * Enforced in code rather than by a constraint, matching
   * job_appointment_assignees: a partial unique index is not available in
   * MariaDB, and a crew mid-edit with nobody marked lead is a legitimate
   * intermediate state.
   */
  is_lead   TINYINT(1) NOT NULL DEFAULT 0,

  sort_order INT NOT NULL DEFAULT 0,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One row per person per crew. Somebody cannot be on the North crew twice.
  PRIMARY KEY (team_id, user_id),
  -- "Which crews is this person on" -- the read the staff screen would want.
  KEY ix_jteam_user (user_id),
  CONSTRAINT fk_jteam_member FOREIGN KEY (team_id)
    REFERENCES job_teams (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
