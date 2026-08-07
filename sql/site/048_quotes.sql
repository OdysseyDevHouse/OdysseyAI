-- Quotes — what was offered, and whether it was taken.
--
-- ── NO NEW TABLES, DELIBERATELY ──────────────────────────────────────────
--
-- A quote IS a sales document. It has a customer, lines, prices, VAT and a
-- total, computed by the same documentMath as an invoice — so it lives in
-- sales_documents, which has carried `doc_type = 'quote'` since 015 and its own
-- QUO sequence since the numbering was seeded. Nothing about it needed
-- inventing; it needed using.
--
-- Building a parallel quote_documents table would mean a second copy of every
-- line calculation, a second editor, and two places for the VAT split to drift
-- apart. The cost of that shows up the first time a rounding rule changes and
-- only one of them is updated.
--
-- ── WHAT A QUOTE ACTUALLY HAS THAT AN INVOICE DOES NOT ───────────────────
--
-- Three things, and they are the whole of this migration:
--
--   VALIDITY. A quote expires. "Valid for 30 days" is the sentence on every
--   quote ever issued, and without a date the system cannot say whether the
--   prices on it still stand.
--
--   AN OUTCOME. Accepted, declined, or still waiting. That is what makes
--   "what is our conversion rate" answerable, and it is the single most
--   useful thing a quote register knows.
--
--   A REASON IT WAS LOST. Price, lead time, went elsewhere. Recorded because
--   a pattern in the losses is worth more than any individual one.
--
-- ── A QUOTE NEVER POSTS ──────────────────────────────────────────────────
--
-- It moves no stock, touches no ledger and declares no VAT, because it is not
-- a tax document — it is an offer. finaliseGuards() in salesPosting.ts has
-- refused to post one since sales orders were built. Converting a quote
-- creates a NEW invoice linked by converted_from_id, leaving the quote intact
-- as the record of what was offered. That distinction matters precisely when a
-- customer disputes what they were quoted.

ALTER TABLE sales_documents
  -- The last day the prices on this quote stand. NULL on an invoice, which
  -- does not expire, and on a quote where nobody set one.
  ADD COLUMN valid_until DATE NULL AFTER due_date,

  --   open      — issued, waiting for an answer
  --   accepted  — the customer said yes. Usually set by converting it.
  --   declined  — the customer said no, and quote_lost_reason says why.
  --   expired   — validity passed with no answer. Derived on read rather than
  --               stored, because a date passing is not an event anybody
  --               triggers — see quoteState() in quotes.ts.
  --
  -- Deliberately SEPARATE from `status`. A quote can be finalised (issued to
  -- the customer) and still open, or issued and declined; folding the two into
  -- one column would need statuses like 'finalised_declined' and every query
  -- that reads status would have to know about them.
  ADD COLUMN quote_outcome ENUM('open','accepted','declined') NOT NULL DEFAULT 'open' AFTER valid_until,
  ADD COLUMN quote_outcome_at DATETIME NULL AFTER quote_outcome,
  -- Free text rather than an enum: the reasons a quote is lost are various and
  -- a new one should be data, not a migration. Reported by grouping.
  ADD COLUMN quote_lost_reason VARCHAR(190) NULL AFTER quote_outcome_at,

  -- The quote register, and the "what is still open" worklist.
  ADD KEY ix_sales_quote (doc_type, quote_outcome, valid_until);

-- How long a quote is valid for by default, in days. 30 is the ordinary
-- commercial term and what most businesses put on a quote without thinking.
-- Zero means quotes do not expire, for a business that prefers that.
INSERT INTO settings (setting_key, setting_value)
VALUES ('quote_validity_days', '30')
ON DUPLICATE KEY UPDATE setting_key = setting_key;

-- The note printed at the foot of a quote. Blank by default: a store writes
-- its own terms, and inventing legal-sounding text on its behalf would be
-- worse than an empty field it can fill.
INSERT INTO settings (setting_key, setting_value)
VALUES ('quote_terms_text', '')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
