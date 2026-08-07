-- Clocking in and out.
--
-- ── WHY NOT `shifts` ────────────────────────────────────────────────────
--
-- 016 already has a table with `opened_at` and `closed_at` and a `user_id`, and
-- it is the wrong one. `shifts` is a CASH DRAWER SESSION:
--
--   Its unique key is `uq_shift_open (open_terminal_id)` — one open shift per
--   TILL, not per person. A bookkeeper, a stock-room packer or a driver has no
--   terminal and could therefore never clock in at all.
--
--   Shifts are optional. `salesPosting.ts` deliberately allows a sale with
--   `shift_id = NULL`, because "a store that does not cash up still needs to
--   trade". Hours would silently vanish for every such store.
--
--   `closed_by_user_id` exists precisely because a supervisor routinely closes
--   somebody else's drawer, so `closed_at` is not that person's clock-out.
--
-- 016's own header says it plainly: "the whole point is knowing whose drawer
-- was short". That is a different question from who was at work.
--
-- So: a separate table. `shift_id` below is a convenience link for the cases
-- where the two DO line up, never the storage.

CREATE TABLE staff_time_entries (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- No foreign key, and the name snapshotted, matching every other audit row in
  -- this schema. A time record is evidence of what happened and must outlive
  -- the person's user row being tidied away.
  user_id           INT UNSIGNED NOT NULL,
  user_name         VARCHAR(120) NOT NULL DEFAULT '',

  started_at        DATETIME NOT NULL,
  -- NULL means still on the clock. It is the normal state for half the day, not
  -- an error.
  ended_at          DATETIME NULL,

  -- How it got here. 'pin' is somebody clocking themselves at a till; 'manual'
  -- is a manager entering or correcting it; 'import' is a bulk load. Worth
  -- distinguishing because a timesheet made entirely of 'manual' rows is a
  -- timesheet nobody actually clocked.
  source            ENUM('pin','manual','import') NOT NULL DEFAULT 'pin',

  -- Where they clocked, when it was a till. Nullable: a back-office user
  -- clocking from their own screen has no terminal.
  terminal_id       INT UNSIGNED NULL,

  -- The cash-up shift this overlaps, when there is one. A CONVENIENCE, so a
  -- cash-up screen can offer "you clocked in at 07:58" — never the source of
  -- the hours. ON DELETE SET NULL because losing the shift must not lose the
  -- time worked.
  shift_id          INT UNSIGNED NULL,

  -- Unpaid break, subtracted from the worked total. Minutes rather than a
  -- second interval because nobody records a 12-second tea break, and an INT of
  -- minutes cannot drift the way a pair of timestamps can.
  break_minutes     INT NOT NULL DEFAULT 0,

  note              VARCHAR(400) NULL,

  -- ── The audit trail on a correction ──────────────────────────────────
  --
  -- A time record a manager can change without trace is one staff will not
  -- trust, and BCEA section 31 requires an employer to keep accurate records.
  -- So an amendment says who and why, and the original figures survive.
  edited_by_user_id INT UNSIGNED NULL,
  edited_by_name    VARCHAR(120) NULL,
  edited_at         DATETIME NULL,
  edited_reason     VARCHAR(400) NULL,
  original_started_at DATETIME NULL,
  original_ended_at   DATETIME NULL,

  approved_at       DATETIME NULL,
  approved_by_user_id INT UNSIGNED NULL,
  approved_by_name  VARCHAR(120) NULL,

  -- ── One person, one open entry ───────────────────────────────────────
  --
  -- Holds the user id while the entry is open and goes NULL once it closes.
  --
  -- A plain UNIQUE (user_id, ended_at) would NOT work: MySQL permits any number
  -- of NULLs in a unique index, so every open entry would have ended_at = NULL
  -- and none of them would collide — somebody could clock in fifty times. A
  -- generated column that nulls on close inverts that, so the index constrains
  -- exactly the open ones. Same trick 016 uses for open shifts, for the same
  -- reason.
  open_user_id      INT UNSIGNED
    GENERATED ALWAYS AS (CASE WHEN ended_at IS NULL THEN user_id ELSE NULL END) STORED,

  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_open_entry (open_user_id),
  -- "What did this person work between two dates" — the timesheet's whole query.
  KEY ix_time_user_day (user_id, started_at),
  -- "Who was in on Tuesday", for the day view.
  KEY ix_time_started (started_at),
  KEY ix_time_shift (shift_id),
  CONSTRAINT fk_time_shift FOREIGN KEY (shift_id) REFERENCES shifts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
