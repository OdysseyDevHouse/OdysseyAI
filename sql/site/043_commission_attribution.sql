-- Making a sale line say who to pay, and what it reverses.
--
-- 042 assumed two things the sales schema does not actually provide, and both
-- have to exist before commission can be calculated honestly.
--
-- ── 1. A CREDIT NOTE MUST POINT AT WHAT IT REVERSES ─────────────────────
--
-- `createCreditNote` already works line by line off a `sourceLineId` — it reads
-- the original line to copy its cost, so returning at today's higher cost
-- cannot manufacture margin (015). But that id is used and thrown away; it is
-- never stored.
--
-- Without it a clawback cannot find the salesperson who made the sale, and the
-- only available answer is "whoever was standing at the till when the goods
-- came back". That person then slowly accumulates everybody else's clawbacks,
-- which is both wrong and the fastest way to make staff distrust the whole
-- scheme.
--
-- Nullable because most credit lines have no source: a return with no receipt
-- (`/sales/returns`) reverses nothing in particular, and forcing a value would
-- invent a link that does not exist.
ALTER TABLE sales_document_lines
  ADD COLUMN source_line_id INT UNSIGNED NULL AFTER sales_rep_id;

-- SET NULL rather than CASCADE: deleting an invoice line must never delete the
-- credit note line that reversed it. The credit is a document in its own right
-- and the customer is holding a copy.
ALTER TABLE sales_document_lines
  ADD CONSTRAINT fk_sales_line_source
    FOREIGN KEY (source_line_id) REFERENCES sales_document_lines (id) ON DELETE SET NULL;

ALTER TABLE sales_document_lines
  ADD KEY ix_sales_line_source (source_line_id);

-- ── 2. ATTRIBUTION MUST NAME SOMEONE WHO CAN BE PAID ────────────────────
--
-- `sales_rep_id` points at `sales_reps`, which 012 describes as a PERSON who
-- may not be a system user at all — an agent earning commission without ever
-- logging in. That is still true and the column stays.
--
-- But commission under 042 is paid to a `users` row, because that is the thing
-- with a role, a PIN, and a login. A rep record has none of those, and 041
-- already links the two with `users.sales_rep_id` for exactly this reason.
--
-- Rather than join through that link at calculation time — which would break
-- the moment a user is re-pointed at a different rep, silently re-attributing
-- historic sales — the line records the user directly, resolved at sale time
-- and then fixed.
--
-- NULL means "no specific salesperson", which is the honest answer for most
-- till sales: someone rang it up, but nobody sold it in the sense that earns
-- commission. The calculation falls back to `sales_documents.user_id` — who
-- captured it — only when this is set.
ALTER TABLE sales_document_lines
  ADD COLUMN sales_rep_user_id INT UNSIGNED NULL AFTER source_line_id;

-- No foreign key to `users`, deliberately. A commission entry must outlive the
-- person leaving: 042's entries snapshot the name, and a CASCADE here would
-- quietly detach historic lines from the person they belonged to. SET NULL
-- would do the same thing more slowly.
ALTER TABLE sales_document_lines
  ADD KEY ix_sales_line_rep_user (sales_rep_user_id);

-- Backfill from the rep link where one exists, so sales captured before this
-- migration still attribute. Only where the mapping is unambiguous — a rep
-- linked to exactly one active user.
UPDATE sales_document_lines l
  INNER JOIN (
    SELECT sales_rep_id, MIN(id) AS user_id
      FROM users
     WHERE sales_rep_id IS NOT NULL AND is_active = 1
     GROUP BY sales_rep_id
    HAVING COUNT(*) = 1
  ) AS m ON m.sales_rep_id = l.sales_rep_id
   SET l.sales_rep_user_id = m.user_id
 WHERE l.sales_rep_id IS NOT NULL
   AND l.sales_rep_user_id IS NULL;
