-- ─────────────────────────────────────────────────────────────────────────
-- Quote acceptance: who said yes, and how we know.
--
-- ── THE GAP THIS FILLS ───────────────────────────────────────────────────
--
-- 048 gave a quote an OUTCOME — open, accepted, declined — and that was right
-- for a shop counter, where accepting and invoicing are the same moment. There
-- is no acceptQuote() in quotes.ts at all: `quote_outcome = 'accepted'` is set
-- in exactly one place, inside convertToInvoice(), as a side effect of raising
-- the invoice.
--
-- For a job that is the wrong shape, and wrong in a way that costs money. A
-- customer accepts on Tuesday, a technician works Wednesday and Thursday, parts
-- are ordered on Friday, and the invoice goes out the following week. In between,
-- the business needs to know the work was authorised — because that is the whole
-- basis for having sent anybody out. Deriving acceptance from an invoice that
-- does not exist yet cannot answer it.
--
-- So acceptance becomes something that can be recorded on its own, and
-- converting later reads it rather than causing it.
--
-- ── WHY THE METHOD IS STORED, NOT JUST THE FACT ──────────────────────────
--
-- The PRD asks what constitutes valid proof of acceptance and answers: customer
-- email, an approval link, or a permitted user accepting on their behalf. Those
-- are three different strengths of evidence, and a dispute turns on which one
-- was used.
--
--   verbal     somebody phoned and said yes. The user vouches for it.
--   email      they replied in writing. The reference holds the message id.
--   link       they clicked an approval link. The system saw it happen.
--   in_person  signed on site.
--   internal   accepted on their behalf under a standing arrangement.
--
-- A single `accepted` flag would make "we have it in writing" and "Johan says
-- they agreed on the phone" indistinguishable six months later, which is exactly
-- when somebody asks.
--
-- ── WHY THIS IS NOT A SEPARATE TABLE ─────────────────────────────────────
--
-- One acceptance per quote VERSION, and a version is a sales_documents row. A
-- quote_acceptances table would be a second row per document carrying a
-- one-to-one relationship, and every read of "is this authorised" would need a
-- join to find out. Re-quoting creates a NEW document (see the revision chain in
-- jobQuotes.ts), so the history is the chain of documents rather than a stack of
-- acceptances against one — which is the same argument 048 makes for never
-- overwriting an accepted quote.
--
-- DDL auto-commits, so every step here is re-runnable.
--
-- NOTE: no apostrophes in comments anywhere in this file. The runner sends it as
-- one multipleStatements batch, and MariaDB reads a lone ' inside a `--` comment
-- as opening a string literal, swallowing the SQL that follows.
-- ─────────────────────────────────────────────────────────────────────────

-- Note the MariaDB form: `ADD FOREIGN KEY IF NOT EXISTS <name> (cols)`. It does
-- NOT accept `ADD CONSTRAINT IF NOT EXISTS <name> FOREIGN KEY`.
ALTER TABLE sales_documents
  -- How we know they said yes. NULL on every quote that has not been accepted,
  -- and on every document that is not a quote — which is almost all of them.
  ADD COLUMN IF NOT EXISTS quote_accept_method
    ENUM('verbal','email','link','in_person','internal') NULL AFTER quote_lost_reason,

  -- WHO said yes, in their words: a contact name, an email address, the person
  -- who signed. Free text rather than a customer_contacts FK, because the person
  -- who authorises work is often not on file — a tenant, a site foreman, a
  -- managing agent phoning on behalf of a landlord.
  ADD COLUMN IF NOT EXISTS quote_accepted_by VARCHAR(160) NULL AFTER quote_accept_method,

  -- The evidence. A message id, an email subject, a PO number, the token of the
  -- approval link that was clicked. What somebody would go looking for when the
  -- acceptance is questioned.
  ADD COLUMN IF NOT EXISTS quote_accept_reference VARCHAR(190) NULL AFTER quote_accepted_by,

  -- The user who RECORDED it, which is not the same as the customer who gave it.
  -- On an internal acceptance these are the only name there is, and that
  -- distinction is the point: the audit trail must show that a member of staff
  -- vouched for it rather than the customer having acted.
  --
  -- cp2_users.id from the CONTROL database, so no FK is possible.
  ADD COLUMN IF NOT EXISTS quote_accepted_by_user_id INT UNSIGNED NULL AFTER quote_accept_reference,

  -- Which quote this one replaces.
  --
  -- Deliberately separate from converted_from_id, which already means "the
  -- document this was raised FROM" and is how a quote points at its invoice. A
  -- revision is a different relationship in the opposite direction: v2 supersedes
  -- v1, both are quotes, and neither was raised from the other in the
  -- quote-to-invoice sense. Sharing the column would make "what did we originally
  -- offer" and "what did this become" the same question.
  ADD COLUMN IF NOT EXISTS supersedes_id INT UNSIGNED NULL AFTER quote_accepted_by_user_id,

  -- Which revision this is, from 1. Stored rather than counted along the chain so
  -- a list can show "v3" without walking backwards per row.
  ADD COLUMN IF NOT EXISTS quote_revision SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER supersedes_id,

  -- "Show me the accepted quote for this job", which is the read the whole
  -- module hangs on.
  ADD KEY IF NOT EXISTS ix_sdoc_quote_accept (job_card_id, doc_type, quote_outcome),
  ADD KEY IF NOT EXISTS ix_sdoc_supersedes (supersedes_id),

  -- SET NULL rather than CASCADE: superseding is a claim v2 makes about v1, and
  -- if v1 ever went away v2 is still a real quote that was really sent.
  ADD FOREIGN KEY IF NOT EXISTS fk_sdoc_supersedes (supersedes_id)
    REFERENCES sales_documents (id) ON DELETE SET NULL;

-- ── Settings ─────────────────────────────────────────────────────────────
-- Whether a job may be worked before its quote is accepted.
--
-- The PRD says a billable variation needs customer approval before work
-- continues, and that a user with permission may bypass it. This is the default
-- half of that: OFF, because the commonest real case is a technician already on
-- site finding a second fault, and refusing outright would strand them. The
-- permission half is jobs.bill_decide, which is what lets somebody classify the
-- extra work as billable at all.
INSERT INTO settings (setting_key, setting_value)
VALUES ('job_require_quote_acceptance', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
