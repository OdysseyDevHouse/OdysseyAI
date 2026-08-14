-- ── Two-party sign-off on a job ─────────────────────────────────────────────
--
-- The customer signs to say the work is done. Somebody from the business signs
-- to say they did it. Two named facts on the job, not two rows in a checklist.
--
-- ── WHY NOT JUST TWO SIGNATURE CHECKLIST ITEMS ──────────────────────────────
--
-- Because that already works, and it cannot answer the question the PRD asks.
--
-- 114 gives every checklist item a response_type of signature, and 119 makes
-- one hold a real drawn PNG. A business can therefore add "customer signs here"
-- to a kind of work today and make it mandatory before closing. What nothing in
-- the schema knows is WHICH item is the customer and which is the technician:
-- both are rows in job_card_items with a name somebody typed.
--
-- So "completed jobs missing a customer signature" — a report the PRD names —
-- has no query. It would mean matching on the item NAME, which is configurable
-- text that differs per site and per kind of work. Two named pairs of columns
-- make it one indexed read.
--
-- ── WHY COLUMNS RATHER THAN A job_signoffs TABLE ────────────────────────────
--
-- There are exactly two parties and there will be two. A table would buy the
-- ability to record a third signature nobody has asked for, and cost a join on
-- every job read plus a second place for "is this job signed" to be answered.
--
-- The deposits phase made the same call in reverse: a deposit needed no table
-- because it was already a customer receipt. This needs no table because it is
-- two facts about one row.
--
-- ── THE FILE IS THE EVIDENCE; THE NAME IS THE CLAIM ─────────────────────────
--
-- signature_id points at the drawn mark. signed_name is who they said they were
-- — typed, because the person holding the tablet is often not the person named
-- on the account, and "signed by the site foreman" is worth more than a mark
-- with no name against it.
--
-- ON DELETE SET NULL, matching job_card_items.attachment_id in 119 and for the
-- same reason: deleting the file un-signs the job rather than leaving it
-- claiming a signature that is not there.

ALTER TABLE job_cards
  ADD COLUMN IF NOT EXISTS customer_signed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS customer_signed_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS customer_signature_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS technician_signed_at DATETIME NULL,
  ADD COLUMN IF NOT EXISTS technician_signed_name VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS technician_signature_id BIGINT UNSIGNED NULL;

-- The report the PRD asks for: completed jobs missing a signature. Both halves
-- indexed, because a business chasing paperwork chases one or the other.
ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_jcard_customer_signed (customer_signed_at, status);

ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_jcard_tech_signed (technician_signed_at, status);

ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_jcard_customer_sig (customer_signature_id);

ALTER TABLE job_cards
  ADD KEY IF NOT EXISTS ix_jcard_tech_sig (technician_signature_id);

-- ADD FOREIGN KEY IF NOT EXISTS <name>, never ADD CONSTRAINT IF NOT EXISTS:
-- MariaDB accepts the former and rejects the latter as a syntax error.
ALTER TABLE job_cards
  ADD FOREIGN KEY IF NOT EXISTS fk_jcard_customer_sig (customer_signature_id)
    REFERENCES party_documents (id) ON DELETE SET NULL;

ALTER TABLE job_cards
  ADD FOREIGN KEY IF NOT EXISTS fk_jcard_tech_sig (technician_signature_id)
    REFERENCES party_documents (id) ON DELETE SET NULL;

-- ── Whether a signature is required before closing ──────────────────────────
--
-- Three values rather than a pair of flags, because the sensible settings are
-- a short list and two booleans would allow "technician only", which no
-- business asks for: the point of a technician signature is that it accompanies
-- the customer one.
--
--   none      sign-off is recorded when it happens and blocks nothing
--   customer  a job cannot close until the customer has signed
--   both      neither may be missing
--
-- Defaults to none. A site that has been closing jobs for months must not find
-- every one of them refused the morning after a migration.
INSERT INTO settings (setting_key, setting_value)
SELECT 'job_signoff_required', 'none'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE setting_key = 'job_signoff_required');
