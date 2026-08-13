-- What the kitchen has been TOLD, per line.
--
-- A SERVER column, not a client snapshot: a hospitality tab is one document
-- reachable from every till, so a waiter adding a course from till B must not
-- blind till A's "what is new since the last send". A QUANTITY rather than a
-- boolean, because the common edit is 1 espresso becoming 3 — the delta
-- (qty - kitchen_sent_qty) is what prints.
ALTER TABLE sales_document_lines
  ADD COLUMN IF NOT EXISTS kitchen_sent_qty DECIMAL(12,3) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS kitchen_sent_at DATETIME NULL;
