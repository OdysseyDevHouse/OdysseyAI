-- ─────────────────────────────────────────────────────────────────────────
-- Daily and monthly spend limits, and auto-emailing an invoice.
--
-- ── WHY A SPEND LIMIT IS NOT A SECOND CREDIT LIMIT ───────────────────────
--
-- credit_limit tests the BALANCE: what is owed right now. It falls when the
-- customer pays, and that is the point — an account settled in full has its
-- whole limit available again.
--
-- These two test SPEND OVER A WINDOW: what has been charged to the account
-- since midnight, or since the first of the month. A payment does NOT give
-- the room back, because the question is a different one. "How much may this
-- account draw in a day" is asked precisely because a customer with a
-- R50,000 limit who settles every afternoon could otherwise take R50,000
-- every single day, and the credit limit would never once be breached.
--
-- So the two are checked together and neither replaces the other: the credit
-- limit caps EXPOSURE, these cap VELOCITY. An account can be refused by
-- either.
--
-- Zero means no limit — the opposite of credit_limit, where zero means no
-- credit at all. That reads backwards until you remember what each is for: a
-- credit limit is a grant (nothing granted = nothing allowed), a spend limit
-- is a restriction (nothing restricted = nothing stopped). The forms say so
-- in as many words, because this is the sort of asymmetry that produces a
-- support call otherwise.
--
-- ── WHY THE SPEND IS NOT A STORED COUNTER ────────────────────────────────
--
-- No daily_spent column, deliberately. A counter has to be reset by
-- something — a nightly job, a first-touch-of-the-day check — and every one
-- of those is a way for the number to be wrong at 00:01 or after a day the
-- system was off. Worse, a voided sale would have to remember to decrement
-- it.
--
-- Instead the spend is SUMMED at the moment of the check, from the ACCOUNT
-- TENDER rows of finalised sales in the window. It is a derived figure with
-- no reset, no drift and no repair path, and voiding a sale corrects it for
-- free.
--
-- Summed from sales_tenders rather than sales_documents.total_incl, because
-- what a spend limit governs is what was put ON THE ACCOUNT. A customer who
-- pays R900 cash and R100 on account has drawn R100 of credit, not R1,000.
-- The existing ix_doc_customer (customer_id, document_date) index already
-- serves the driving side of that query, so no new index is added here.
--
-- ── AUTO-EMAIL ───────────────────────────────────────────────────────────
--
-- auto_email_invoices is a per-account switch, not a site setting: some
-- customers want every invoice in their inbox and some emphatically do not.
-- It sends through the same emailInvoiceDocument path as the manual button,
-- so the PDF, the pay link and the document_audit row are identical — the
-- only difference is who pressed it.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS daily_limit DECIMAL(12,4) NOT NULL DEFAULT 0.0000
    AFTER credit_limit,
  ADD COLUMN IF NOT EXISTS monthly_limit DECIMAL(12,4) NOT NULL DEFAULT 0.0000
    AFTER daily_limit,
  ADD COLUMN IF NOT EXISTS auto_email_invoices TINYINT(1) NOT NULL DEFAULT 0
    AFTER monthly_limit;
