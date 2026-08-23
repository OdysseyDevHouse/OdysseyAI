-- ── Auto-numbering for master data ─────────────────────────────────────
--
-- Customers, suppliers and products carry a `code` that until now every user
-- had to invent. That is the wrong job for a person: they either type CUST1,
-- CUST01 and CUST001 across three afternoons, or they pause at the counter to
-- work out what the next number is.
--
-- These are NOT documents. The distinction matters, because it is what decides
-- how the number may behave:
--
--   A document number is a legal artefact. Every number issued must have a
--   document to show for it, so it is claimed inside the posting transaction
--   and a void keeps its number forever (see lib/site/sequences.ts).
--
--   A master-data code is an internal reference. Nothing outside this system
--   demands that CUST000042 exists, and a customer who is deleted before
--   trading leaves a hole nobody has to explain. So a gap here is harmless.
--
-- They share the sequences table anyway, because the mechanism — atomic
-- UPDATE, read back on the same connection — is the part that is hard to get
-- right, and having a second, subtly different implementation of it is how
-- duplicate codes eventually appear. What differs is only the policy above,
-- which lives in the calling code rather than the schema.
--
-- INSERT IGNORE, not INSERT: this migration must be a no-op on a site that
-- somehow already has these rows, rather than failing the whole run.
INSERT IGNORE INTO document_sequences (doc_type, prefix, next_number, padding, reset_period) VALUES
  ('customer', 'CUST', 1, 5, 'none'),
  ('supplier', 'SUPP', 1, 5, 'none'),
  ('product',  'PRD',  1, 5, 'none');

-- ON by default. This was off, on the reasoning that a store arriving with its
-- own coding scheme should keep it — but that case is the IMPORT, which carries
-- its codes in the file and where a typed code always wins over the suggestion.
-- What the default actually decides is what happens when somebody adds an
-- account by hand and leaves the code blank, and there the honest answer is a
-- code rather than a validation error. A store that wants its own scheme still
-- types one, or turns this off in Setup → Numbering & posting.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('autocode_customer', '1'),
  ('autocode_supplier', '1'),
  ('autocode_product',  '1');
