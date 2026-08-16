-- ─────────────────────────────────────────────────────────────────────────
-- A claim of its own, so a bill being edited is still a bill.
--
-- Recalling a parked sale has to stop a SECOND till pulling the same basket
-- onto its screen: both would edit it, and the second to finalise would fail
-- in front of a customer. That guard was implemented by moving the document
-- out of `saved` and into `draft` — the database's own conditional update
-- deciding which till won.
--
-- It works, and it costs too much, because `status` was already answering a
-- different question. A table's occupancy is derived from its document being
-- `saved` (see listTables, which LEFT JOINs on exactly that), so the moment a
-- waiter resumed a table the floor concluded the table was FREE. The bill's
-- money vanished from the floor, from the split screen and from the tab list,
-- and `updateTableBillAction` — which requires `saved` — began refusing the
-- autosave, so the resumed table could not even take another item.
--
-- Worse, the claim was only ever released by a clean exit. A reload, a
-- navigation away or a crash left the document in `draft` with nothing to put
-- it back, and the table was stranded for good. That is not a rare path: it is
-- what happens every time a till is closed mid-service.
--
-- ── WHY A COLUMN AND NOT A LOCK TABLE ────────────────────────────────────
--
-- A claim is one fact about one document with a one-to-one lifetime, so it
-- belongs beside it. A separate table would need its own row lifecycle, its own
-- orphan cleanup, and a join on every read of a document — to store what two
-- nullable columns hold.
--
-- ── WHY IT EXPIRES ───────────────────────────────────────────────────────
--
-- A claim with no expiry is the same trap in a new column: a till that dies
-- holding one would strand the bill exactly as `draft` did. So a claim is a
-- LEASE, not a lock. `claimed_at` is what makes it one — a claim older than the
-- lease is dead and may be taken by anyone, which means the worst a crash can
-- cost is the lease window rather than the bill.
--
-- The window is a trade with only one real risk on each side: too short and two
-- waiters genuinely editing one bill can collide; too long and a crashed till
-- blocks a table for that whole time. Fifteen minutes sits past any
-- interruption a waiter has mid-service and well inside a sitting.
--
-- ── STATUS STILL MOVES, JUST NOT FOR THIS ────────────────────────────────
--
-- draft -> saved -> issued -> finalised/cancelled is untouched. What changes is
-- that "somebody is editing this" is no longer spelled by walking a document
-- BACKWARDS through it. A table's bill is `saved` for its whole life now, and
-- listTables tells the truth whether or not a till happens to be looking at it.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_documents
  ADD COLUMN IF NOT EXISTS claimed_by INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS claimed_at DATETIME NULL;

-- Claims are taken and released by a conditional UPDATE that must not scan the
-- table: the whole guarantee is that exactly one of two concurrent tills wins,
-- and that race is decided on this predicate.
CREATE INDEX IF NOT EXISTS ix_sales_documents_claim
  ON sales_documents (claimed_at);

-- ── PUTTING BACK WHAT THE OLD SCHEME STRANDED ────────────────────────────
--
-- Any document a table currently points at that is sitting in `draft` is a bill
-- somebody resumed and never handed back. It is a real, unposted, editable sale
-- with money on it, invisible to the floor. Those go back to `saved`, which is
-- where they would have been all along had the claim lived anywhere else.
--
-- Scoped to documents A TABLE POINTS AT, deliberately. A plain `draft` with no
-- table is an ordinary basket somebody is ringing up at a counter right now,
-- and promoting that to `saved` would put a live basket in the Saved sales list
-- for another till to steal.
UPDATE sales_documents d
   JOIN pos_tables t ON t.document_id = d.id
   SET d.status = 'saved'
 WHERE d.status = 'draft';
