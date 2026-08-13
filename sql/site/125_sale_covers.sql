-- ============================================================================
-- 125_sale_covers.sql — how many people, and what kind of visit, on a bill
-- ============================================================================
--
-- A restaurant tab carries two facts an invoice never needed: how many people
-- are sitting at it, and whether they are eating in, taking away, or having it
-- delivered. Both belong to the BILL rather than to the table.
--
-- ── WHY NOT ON pos_tables, WHERE visit_type_id ALREADY LIVES ────────────────
--
-- `pos_tables.visit_type_id` describes the FURNITURE — "table 12 is a sit-down
-- table" — and it is right where it is. But a takeaway rung up over the counter
-- never touches a table row, so it has nowhere to record that it was a takeaway;
-- and a table that seats four can be sat at by two. Reading either fact off the
-- table answers a different question from the one being asked, and answers it
-- wrongly on exactly the sales a restaurant cares most about counting.
--
-- So they go on the document, where they are a property of the trade itself and
-- survive the table being re-seated, renamed or deleted underneath them.
--
-- ── NO FOREIGN KEY ON visit_type_id, DELIBERATELY ───────────────────────────
--
-- A visit type is back-office configuration; a finalised bill is history. An FK
-- would make deleting a retired visit type either impossible (RESTRICT) or
-- silently destructive to the historical record (SET NULL) — and "we stopped
-- offering delivery in March" must not rewrite what March's sales were. The id
-- is stored as a snapshot; visitTypes.deleteVisitType guards the live case.
--
-- Both columns are NULLABLE with no default. Every existing invoice, quote and
-- credit note predates the idea, and a retail sale never acquires one — NULL is
-- the honest answer for all of them, and 0 would be a lie that reports would
-- have to keep filtering out.

ALTER TABLE sales_documents
  -- SMALLINT UNSIGNED: a table of 300 is a wedding, not a typo to guard against.
  ADD COLUMN IF NOT EXISTS person_count  SMALLINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS visit_type_id INT UNSIGNED      NULL;

-- Reporting reads "all the takeaways this month" far more often than it reads
-- one bill, and the column is low-cardinality — a handful of types across every
-- document — so the index earns its keep on the group-by rather than on lookup.
ALTER TABLE sales_documents
  ADD INDEX IF NOT EXISTS idx_sales_documents_visit_type (visit_type_id);
