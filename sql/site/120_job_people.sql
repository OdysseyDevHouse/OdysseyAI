-- ============================================================================
-- 120_job_people.sql — more than one person on a job, and people who only watch
-- ============================================================================
--
-- Two PRD sections asking for the same thing from opposite ends.
--
-- Section 16 wants a job-level team: two technicians on one job without having
-- to book a visit first. Today a job has ONE owner_user_id, and the only place
-- more than one name fits is job_appointment_assignees, which hangs off a visit.
-- A job with no visit booked yet therefore has no team -- and that is precisely
-- when somebody needs assigning.
--
-- Section 13 wants followers: a manager who wants to hear about a job without
-- being responsible for it, and without being able to edit it by virtue of
-- watching it.
--
-- ── ONE TABLE WITH A ROLE, NOT TWO TABLES ───────────────────────────────────
--
-- The tempting split is job_card_assignees and job_card_followers. Each would be
-- exactly what its name says and neither would carry a column the other ignores.
--
-- It was rejected on the read. "Every job I am involved in" is the query behind
-- the job list filter, the dashboard tile and every notification decision, and
-- across two tables it is a UNION -- one that every future caller has to
-- remember to write both halves of. Getting it wrong does not error; it silently
-- shows somebody half their work.
--
-- One table also makes promotion a value change rather than a move: a follower
-- who takes the job on becomes an assignee with an UPDATE, keeping the row that
-- records when they first got involved.
--
-- ── WHY owner_user_id STAYS ─────────────────────────────────────────────────
--
-- It would be tidy to delete it and make the owner "the assignee with a flag".
-- It is not being deleted, for the reason 104 gave it in the first place: the
-- owner is the ONE person answerable for the job, it is on every list screen and
-- every index, and every existing query reads it. Making a single-valued fact
-- into a row somebody has to aggregate is how a list screen acquires a subquery.
--
-- So: owner_user_id is the answerable one; this table is everybody else. The
-- owner is NOT duplicated in here -- see the trigger-free rule below.
-- ============================================================================


CREATE TABLE IF NOT EXISTS job_card_people (
  job_card_id  INT UNSIGNED NOT NULL,

  -- cp2_users.id from the CONTROL database, so no foreign key is possible. The
  -- name is snapshotted for the same reason every other document snapshots it:
  -- a rename must not rewrite history, and a cross-database join cannot be made.
  user_id      INT UNSIGNED NOT NULL,
  user_name    VARCHAR(120) NOT NULL DEFAULT '',

  /*
   * What they are to this job.
   *
   * assignee -- doing the work. Appears on their job list, counts toward their
   *             workload, and is who "assigned to me" means.
   * follower -- watching it. Gets the emails, appears on no workload at all, and
   *             holds no permission by virtue of following: what they may see is
   *             still decided by jobs.view / jobs.view_own like everybody else.
   *
   * An ENUM rather than a boolean pair because the two are mutually exclusive
   * and always will be. Somebody who is doing the work does not also need to be
   * told about it.
   */
  role         ENUM('assignee','follower') NOT NULL DEFAULT 'follower',

  -- How they got here. A person who asked to follow something and a person who
  -- was added by their manager are in the same state but not the same
  -- situation, and only one of them should be surprised to be removed.
  added_by_user_id INT UNSIGNED NULL,
  added_by_name    VARCHAR(120) NOT NULL DEFAULT '',

  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One row per person per job. The composite key is the whole uniqueness rule:
  -- somebody cannot be both an assignee and a follower, because that would need
  -- two rows and the key refuses the second.
  PRIMARY KEY (job_card_id, user_id),

  -- "What is assigned to this person" and "who follows this" -- the two reads
  -- this table exists for. role first so the assignee list does not scan the
  -- followers.
  KEY ix_jperson_user (user_id, role),

  CONSTRAINT fk_jperson_job FOREIGN KEY (job_card_id)
    REFERENCES job_cards (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ── Settings ────────────────────────────────────────────────────────────────
--
-- INSERT IGNORE is safe: setting_key is the unique key and is NOT NULL, so a
-- re-run cannot duplicate and cannot reset a value somebody changed. (Where a
-- unique key includes a NULLABLE column this would NOT dedupe and would need
-- NOT EXISTS -- the gl_mappings trap from 083.)
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  /*
   * Whether to email at all.
   *
   * ON by default, unlike almost every other switch this project has added --
   * and deliberately, because unlike auto_create on a schedule, nothing happens
   * here unless a person explicitly put somebody on a job. The surprising
   * behaviour would be adding a follower and having them told nothing.
   *
   * It is still a switch, because a business running its own alerting elsewhere
   * should be able to turn ours off rather than have two.
   */
  ('job_notify_enabled', '1'),

  /*
   * WHICH moments send mail. Three, not everything that changes.
   *
   * A notification on every edit is how a person learns to filter the whole lot
   * into a folder they never open -- at which point the feature is worse than
   * not having it, because everybody believes they were told.
   *
   * Stored as a comma-separated list rather than three columns so adding a
   * fourth moment later is a settings change, not a migration.
   */
  ('job_notify_events', 'assigned,status,closed'),

  /*
   * Whether an assignee gets told they were assigned.
   *
   * Separate from the follower switch because it is a different promise: a
   * follower opted in, an assignee has been GIVEN something. A business that
   * assigns work verbally at a morning huddle does not want the email; one whose
   * technicians never meet in person needs it.
   */
  ('job_notify_assignee', '1');
