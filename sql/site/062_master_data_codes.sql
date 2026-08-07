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

-- Off by default, and deliberately so. An existing store has its own coding
-- scheme already in the data — switching it to CUST00001 without being asked
-- would make every new account inconsistent with the thousand before it. A new
-- store turns it on in Setup → Numbering & posting the first time it notices
-- it is typing codes by hand.
INSERT IGNORE INTO settings (setting_key, setting_value) VALUES
  ('autocode_customer', '0'),
  ('autocode_supplier', '0'),
  ('autocode_product',  '0');
