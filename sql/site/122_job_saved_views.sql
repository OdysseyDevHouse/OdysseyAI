-- ============================================================================
-- 122_job_saved_views.sql — a named set of filters, and how the board groups
-- ============================================================================
--
-- Section 37.2 asks for three things on the board: saved views, bulk actions and
-- Kanban grouping. Only the first needs storage.
--
-- Bulk actions are a screen and an action -- they change jobs, they do not
-- describe anything. Grouping is a choice made while looking at a board and
-- carried in the URL, so it survives a link being shared and dies when the tab
-- does, which is the right lifetime for a way of looking at something.
--
-- What is left is the saved view: a name somebody gives a set of filters so they
-- can come back to it. That is a thing, and it needs a row.
--
-- ── A VIEW HOLDS NO JOBS ────────────────────────────────────────────────────
--
-- The same argument the boards table settled in phase 1. A view stores the
-- QUESTION, never the answer: "mine, overdue, high priority" is filters, and the
-- jobs matching it change every hour without anybody editing the view.
--
-- A view that stored job ids would be a list somebody has to maintain, would go
-- stale the moment a job closed, and would let two people disagree about what
-- "my overdue work" contains. Storing the filters means the answer is computed
-- on read and is always right.
--
-- ── WHY THE FILTERS ARE JSON AND NOT COLUMNS ────────────────────────────────
--
-- Against the grain of this schema, which prefers columns everywhere. The reason
-- is that a filter set is not DATA the business owns -- it is a saved URL. The
-- job list already accepts state, status, priority, owner and a search term, and
-- will accept more as screens grow. A column per filter would mean a migration
-- every time the list learns a new one, and every existing view would silently
-- gain a column it never asked for.
--
-- Nothing joins on the contents, nothing aggregates them, and no report reads
-- them. They are handed back to the screen that wrote them. That is exactly the
-- case where JSON is right and a column is not.
--
-- The cost, stated plainly: a filter naming a status that is later deleted will
-- return nothing and say nothing. reconcileJobViews reports those rather than
-- repairing them -- a view is somebody intent, and quietly rewriting it is worse
-- than telling them it is broken.
-- ============================================================================


CREATE TABLE IF NOT EXISTS job_saved_views (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  name          VARCHAR(80)  NOT NULL,

  /*
   * The filters, as the job list understands them. Shape:
   *
   *   {"state":"open","priority":"high","ownerId":4,"q":"aircon"}
   *
   * Written by the screen, read by the screen, joined on by nobody.
   */
  filters       JSON         NOT NULL,

  /*
   * Whose view it is. cp2_users.id from the CONTROL database, so no foreign key
   * is possible -- the same constraint every other user reference in this schema
   * lives with.
   *
   * NULL means it belongs to the site rather than a person: a view somebody made
   * shared, which survives them leaving. That is why this is nullable rather
   * than pointing at whoever created it.
   */
  owner_user_id INT UNSIGNED NULL,
  owner_name    VARCHAR(120) NOT NULL DEFAULT '',

  /*
   * Everybody can see it. Separate from owner_user_id being NULL, because the
   * two answer different questions: who MAINTAINS it, and who can USE it. A view
   * can be mine and shared, or ownerless and private to nobody in particular.
   */
  is_shared     TINYINT(1)   NOT NULL DEFAULT 0,

  -- Pinned across the top of the list, in this order. A view nobody pinned is
  -- still findable in the picker; pinning is what makes it a tab.
  is_pinned     TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order    INT          NOT NULL DEFAULT 0,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  /*
   * One name per person, not one name per site.
   *
   * Two people may both have a view called "Mine" and they mean different
   * things. A site-wide unique name would make the second person rename theirs
   * for no reason.
   *
   * NOTE: owner_user_id is NULLABLE and MySQL treats NULLs as distinct, so this
   * key does NOT stop two shared views sharing a name. That is deliberate -- the
   * alternative is a sentinel value pretending to be a user -- and saveJobView
   * checks the shared case in code instead.
   */
  UNIQUE KEY uq_view_owner_name (owner_user_id, name),

  -- "What can I see" — the read every screen makes: my own, plus every shared one.
  KEY ix_jview_visible (is_shared, owner_user_id, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
