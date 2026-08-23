-- ─────────────────────────────────────────────────────────────────────────
-- What happened to a quote after it was written (§ quote states).
--
-- ── WHY THESE ARE COLUMNS AND NOT ENUM VALUES ────────────────────────────
--
-- 048 built quote_outcome as open / accepted / declined, and quoteState() in
-- quotesModel.ts derives `expired` and `draft` on top of it. The obvious move is
-- to add 'sent' and 'viewed' to that enum. It is wrong, and for a reason worth
-- writing down:
--
--   quote_outcome answers "what did the CUSTOMER decide". Sent and viewed are
--   not decisions — they are things that happened on the way to one, and a quote
--   can be sent, viewed, and STILL open. Folding them into the outcome would
--   make those mutually exclusive, so emailing an accepted quote a second time
--   would either un-accept it or be refused.
--
-- So they are timestamps beside the outcome, and quoteState() layers them the
-- way it already layers expiry: only where the outcome is still `open`.
--
-- ── TIMESTAMPS, NOT FLAGS ────────────────────────────────────────────────
--
-- "Sent on the 3rd, opened on the 11th, still no answer" is a sales
-- conversation. "Sent = yes" is not. The dates cost the same to store and are
-- the entire value of tracking this at all.
--
-- FIRST viewed rather than last, deliberately: the interesting fact is how long
-- the customer took to look, and a `last_viewed_at` would overwrite that every
-- time somebody re-opened the link. The count says how often.
--
-- ── WHAT "VIEWED" HONESTLY MEANS ─────────────────────────────────────────
--
-- Somebody opened the quote through a link we minted. NOT that they read it,
-- NOT that the decision-maker saw it, and NOT that they received the email —
-- a mail can be delivered and never opened, and a link can be opened by the
-- recipient's own spam scanner.
--
-- No tracking pixel, deliberately. A 1x1 image in an email is blocked by most
-- clients, unblocked by others for reasons unrelated to a human reading it, and
-- is the kind of thing a customer is entitled to object to. A link somebody
-- chose to click is a weaker signal honestly obtained, and the column comment
-- is where that limit is recorded so no report claims more than it knows.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE sales_documents
  -- When the quote was last emailed to the customer, and to whom.
  --
  -- LAST rather than first: resending is normal — a chased quote, a corrected
  -- address — and the useful question is "when did they last get it", which is
  -- what a follow-up call is measured from. Every individual send is already in
  -- document_audit, so nothing is lost by keeping only the latest here.
  ADD COLUMN IF NOT EXISTS quote_sent_at DATETIME NULL AFTER quote_lost_reason,
  ADD COLUMN IF NOT EXISTS quote_sent_to VARCHAR(190) NULL AFTER quote_sent_at,

  -- When the customer FIRST opened it. See the header for what this does and
  -- does not prove.
  ADD COLUMN IF NOT EXISTS quote_viewed_at DATETIME NULL AFTER quote_sent_to,
  -- How many times. A quote opened nine times is a quote being discussed
  -- internally, which is worth a phone call — and it is the one number that
  -- distinguishes real interest from an accidental click.
  ADD COLUMN IF NOT EXISTS quote_view_count INT UNSIGNED NOT NULL DEFAULT 0
    AFTER quote_viewed_at;

-- The follow-up worklist: quotes sent, not yet answered, oldest first.
--
-- Ordered (doc_type, quote_outcome, quote_sent_at) rather than reusing 048's
-- ix_sales_quote, which leads on valid_until — the wrong column for "who has
-- not replied", and MariaDB cannot skip a leading column to use the third.
ALTER TABLE sales_documents
  ADD KEY IF NOT EXISTS ix_sales_quote_sent (doc_type, quote_outcome, quote_sent_at);
