-- Commission pays a USER, and the line says which one.
--
-- ── THE MISTAKE THIS FIXES ──────────────────────────────────────────────
--
-- 043 added `sales_document_lines.sales_rep_user_id` on the reasoning that
-- commission is paid to a `users` row, so the line should name one. What it
-- missed is that the invoicing screen has had a per-line salesperson picker
-- all along, and that picker writes `sales_rep_id` — pointing at `sales_reps`.
--
-- The result was a feature that looked complete and silently did nothing: a
-- line attributed through the UI was ignored by the commission calculation,
-- which fell through to `sales_documents.user_id` and paid whoever captured
-- the document. Three lines in site 1 were already in that state.
--
-- ── THE DECISION ────────────────────────────────────────────────────────
--
-- Commission posts to any USER. That is the simpler rule and the one worth
-- keeping: `users` is the thing with a role, a PIN and a login, and it is
-- already what every audit column in this database means by "who".
--
-- `sales_reps` does not go away — `customers.rep_id` still points at it, and
-- an account's rep is a genuinely different question from who rang up one
-- line. But it stops being a commission target.
--
-- Every active rep therefore becomes a user, so nobody who could earn
-- commission yesterday loses the ability today. They land as pos_only with NO
-- PIN and NO role, which means they can be paid but cannot sign in anywhere
-- until somebody deliberately gives them a way in. Creating a login as a side
-- effect of a data migration would be the wrong kind of helpful.

-- ── Reps become users ───────────────────────────────────────────────────
--
-- `users.sales_rep_id` (from 041) is what links the two, and its UNIQUE-free
-- shape means a rep maps to at most one user here because of the NOT EXISTS
-- guard, not because the schema enforces it.
INSERT INTO users (name, email, user_type, role_id, sales_rep_id, is_active)
SELECT r.name, r.email, 'pos_only', NULL, r.id, r.is_active
  FROM sales_reps r
 WHERE r.is_active = 1
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.sales_rep_id = r.id);

-- ── Existing attribution carries across ─────────────────────────────────
--
-- Lines already pointing at a rep now point at that rep's user, so historic
-- commission attribution survives the change rather than silently reverting to
-- "whoever captured it".
UPDATE sales_document_lines l
  INNER JOIN users u ON u.sales_rep_id = l.sales_rep_id
   SET l.sales_rep_user_id = u.id
 WHERE l.sales_rep_id IS NOT NULL
   AND l.sales_rep_user_id IS NULL;

-- ── The line's salesperson is a user from here on ───────────────────────
--
-- `sales_rep_id` is left in place rather than dropped. It is still written by
-- older code paths until they are updated, and dropping a column that a
-- running deployment might still reference turns a bad release into an outage.
-- The commission calculation reads `sales_rep_user_id` only.
ALTER TABLE sales_document_lines
  MODIFY COLUMN sales_rep_user_id INT UNSIGNED NULL
  COMMENT 'users.id — who earns commission on this line. See 047.';
