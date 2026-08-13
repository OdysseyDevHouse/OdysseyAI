-- ============================================================================
-- 119_job_evidence.sql — a photo item holds a photo; a signature holds a signature
-- ============================================================================
--
-- 114 built the checklist and got the response types right: a photo item and a
-- signature item have existed since then. What they stored was TEXT. A photo
-- item asked for a "Reference" and a signature item asked for a "Name", and the
-- comment on job_card_items.response said, optimistically, that a photo stores
-- an attachment.
--
-- It did not. It stored a technician typing that they had taken one.
--
-- That is the whole of this migration: the artefact becomes the answer.
--
-- ── WHY THIS IS NOT A NEW TABLE ─────────────────────────────────────────────
--
-- party_documents already holds files against a loose (entity, entity_id) pair
-- with an opaque generated stored_name, and job_card is already a registered
-- attachment target in attachmentTargets.ts. A job_evidence table would be a
-- second copy of an upload pipeline that has been hardened once, including the
-- path-traversal rule in uploads.ts that says the users filename never touches
-- the filesystem.
--
-- So evidence is a party_documents row, and this migration adds the link.
--
-- ── WHY THE LINK POINTS FROM THE ITEM, NOT FROM THE DOCUMENT ────────────────
--
-- party_documents has no FK on entity_id and cannot have one: the pair is
-- loose so one table can serve customers, suppliers, GRVs and job cards. Its
-- rows therefore cannot be constrained to point at a checklist item.
--
-- Putting attachment_id on job_card_items instead gets a real foreign key in
-- the direction that matters. An item can name a file that exists, or no file.
-- It can never name a file that was deleted: ON DELETE SET NULL, so removing
-- the attachment un-answers the item rather than leaving it pointing at bytes
-- that are gone. An item claiming a photo that is not there is worse than an
-- item with no photo, because only one of the two is visible on a screen.
--
-- The cost, stated plainly: a file uploaded to the job in general and a file
-- uploaded as evidence for item 4 are the same kind of row, and the Files tab
-- shows both. That is correct. Evidence IS a document on the job. The item
-- link says which question it answers, not where it lives.
-- ============================================================================


-- ── The link ────────────────────────────────────────────────────────────────
--
-- BIGINT UNSIGNED to match party_documents.id, which is BIGINT because a busy
-- site attaches more files than an INT will hold. A mismatched width here would
-- be accepted by MariaDB and then refuse the foreign key.
ALTER TABLE job_card_items
  ADD COLUMN IF NOT EXISTS attachment_id BIGINT UNSIGNED NULL AFTER response;

ALTER TABLE job_card_items
  ADD KEY IF NOT EXISTS ix_jci_attachment (attachment_id);

-- ADD FOREIGN KEY IF NOT EXISTS <name>, never ADD CONSTRAINT IF NOT EXISTS:
-- MariaDB accepts the former and rejects the latter as a syntax error.
ALTER TABLE job_card_items
  ADD FOREIGN KEY IF NOT EXISTS fk_jci_attachment (attachment_id)
    REFERENCES party_documents (id) ON DELETE SET NULL;


-- ── Which items must have one ───────────────────────────────────────────────
--
-- You chose: a photo item is complete when a photo is attached, and a signature
-- item when a signature is drawn. Typed text becomes the caption beside it, not
-- the answer.
--
-- This flag exists anyway, and defaults to 1, because the alternative was to
-- read the requirement off response_type in every caller. Two problems with
-- that. It hard-codes a policy in a dozen places, and it silently retro-applies
-- to items already answered with text before this migration ran, which would
-- re-open every photo check on every historical job.
--
-- So: new template items require the file. Existing ANSWERS are left alone by
-- the backfill below, because a job somebody already closed was closed
-- correctly under the rules of the day. Reopening finished work to satisfy a
-- rule that did not exist is how a module loses the trust of the people using
-- it.
ALTER TABLE job_headline_items
  ADD COLUMN IF NOT EXISTS evidence_required TINYINT(1) NOT NULL DEFAULT 1
    AFTER unit;

-- The same flag copied onto the job, exactly as 114 copies name, response_type
-- and is_required: a template edited next year must not change what a job
-- already asked for. This is the snapshot rule the whole checklist follows.
ALTER TABLE job_card_items
  ADD COLUMN IF NOT EXISTS evidence_required TINYINT(1) NOT NULL DEFAULT 1
    AFTER attachment_id;


-- ── The backfill: do not reopen closed work ─────────────────────────────────
--
-- Every item that was ALREADY answered keeps its answer. An item completed with
-- typed text under the old rules stays complete, and its text stays in
-- response. Only unanswered photo and signature items are held to the new rule.
--
-- Written as an UPDATE rather than a DEFAULT because the default has to be 1
-- for the rows created from tomorrow. This statement is what makes the change
-- apply forwards only.
UPDATE job_card_items
   SET evidence_required = 0
 WHERE completed_at IS NOT NULL
   AND attachment_id IS NULL;

-- Items that are not photo or signature never need a file. Setting this
-- explicitly rather than leaving the default means a query can read the flag
-- alone without also branching on response_type -- the mistake this column
-- exists to avoid.
UPDATE job_card_items
   SET evidence_required = 0
 WHERE response_type NOT IN ('photo', 'signature');

UPDATE job_headline_items
   SET evidence_required = 0
 WHERE response_type NOT IN ('photo', 'signature');


-- ── Settings ────────────────────────────────────────────────────────────────
--
-- INSERT IGNORE is safe here: setting_key is the unique key and is NOT NULL, so
-- a re-run cannot duplicate and cannot reset a value somebody changed. (Where a
-- unique key includes a NULLABLE column, INSERT IGNORE does NOT dedupe and this
-- would need NOT EXISTS instead -- the gl_mappings trap from 083.)
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  -- Drawn signatures are saved as PNG at this width; height follows the pad
  -- aspect. 600px is legible on a printed job sheet without storing a
  -- megabyte per signature.
  ('job_signature_width', '600'),
  -- Shown above the signature pad. A signature with nothing stating what was
  -- agreed is a mark on a screen, so the wording is a setting and not a string
  -- in a component.
  ('job_signature_statement',
   'I confirm the work described on this job card has been completed to my satisfaction.');
