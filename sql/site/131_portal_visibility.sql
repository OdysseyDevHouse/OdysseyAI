-- ── Who wrote it, and who may see it ────────────────────────────────────────
--
-- Two columns on two shared tables, so the portal can tell a customer message
-- from a staff note.
--
-- ── WHY THIS WAS NOT ALREADY THERE ──────────────────────────────────────────
--
-- party_comments has always been staff-only. Every comment in it was written by
-- somebody signed in to the back office, about a customer, and none of it was
-- ever meant to be read by that customer. The same is true of party_documents:
-- a supplier PDF behind a GRV is not something to publish.
--
-- So the default of both columns below is the SAFE one, and that is the whole
-- point of adding them rather than reusing something:
--
--   is_customer  = 0   nobody wrote this as a customer
--   is_visible   = 0   nobody has said a customer may see this
--
-- Every row that already exists gets both, which means switching the portal on
-- publishes NOTHING that was written before it existed. A design that made
-- existing comments visible by default would leak years of staff notes the first
-- time somebody signed in.
--
-- ── TWO COLUMNS, NOT ONE ────────────────────────────────────────────────────
--
-- They answer different questions and both are needed:
--
--   a customer message is always visible to that customer  (1, 1)
--   a staff note shared deliberately                       (0, 1)
--   an ordinary staff note                                 (0, 0)
--
-- One column could not express the middle case, which is the one that makes the
-- portal a conversation rather than a noticeboard.

ALTER TABLE party_comments
  ADD COLUMN IF NOT EXISTS is_customer TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_visible  TINYINT(1) NOT NULL DEFAULT 0;

-- The read the portal does: this job, only what may be shown.
ALTER TABLE party_comments
  ADD KEY IF NOT EXISTS ix_comment_visible (entity, entity_id, is_visible);

ALTER TABLE party_documents
  ADD COLUMN IF NOT EXISTS is_customer TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_visible  TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE party_documents
  ADD KEY IF NOT EXISTS ix_document_visible (entity, entity_id, is_visible);
