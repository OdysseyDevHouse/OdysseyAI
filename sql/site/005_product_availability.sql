-- Per-product, per-store availability.
--
-- Until now, a linked store with product sharing on received EVERY product:
-- saving in one store created the code in all the others. That conflated two
-- separate questions — "does this store take part in sharing" and "should this
-- particular product be stocked here" — and left no way to answer the second.
--
-- This column answers it. Like the sharing flags beside it, the row lives in
-- the STORE's own master database, so each store owns the record of what it
-- carries and a store leaving the group needs no cleanup elsewhere.
--
-- DEFAULT 1 applies only to rows that are actually written, and a row is only
-- written when someone sets the switch. With NO row, the code does not assume
-- available — it reads whether the store already holds an unarchived copy. That
-- is what makes adding a store a deliberate act: a save never introduces this
-- product to a store that has never carried it, while stores that already have
-- it keep it untouched.
ALTER TABLE product_share_settings
  ADD COLUMN available TINYINT(1) NOT NULL DEFAULT 1 AFTER product_code;
