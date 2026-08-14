-- ── An expense is its own kind of job line ──────────────────────────────────
--
-- A subcontractor invoice, a congestion charge, a skip hire, a permit fee. Money
-- the job cost that is not a part off the shelf, not somebodys time, and not
-- kilometres driven.
--
-- ── WHY NOT KEEP USING charge ───────────────────────────────────────────────
--
-- Because it works, which is the honest starting point. 104s own comment says a
-- subcontractor invoice is a `charge` with product_id NULL, and it is right: the
-- cost lands in the job total, the margin is correct, and the invariant that
-- cost counts EVERY line holds either way. Nothing is broken.
--
-- What it cannot do is REPORT. A callout fee, a disposal fee and a R14,000
-- subcontractor invoice are one undifferentiated bucket called Charge, and not
-- one of them names who was paid. "What did we spend with subcontractors this
-- quarter" has no query, and the PRDs costing model (26.5) lists subcontractor
-- and other direct expenses as lines in their own right.
--
-- ── EXISTING charge ROWS ARE LEFT ALONE ─────────────────────────────────────
--
-- Deliberately, and this is the decision most likely to be second-guessed later.
-- Reclassifying them would rewrite history to fit an enum value that did not
-- exist when they were written, and a charge is still a legitimate charge: a
-- callout fee genuinely is one. A migration that silently re-labels past data is
-- how a report starts disagreeing with a printed invoice nobody can reproduce.
--
-- The cost is that the first quarter after this ships has expenses in two
-- places. That is visible and explicable; rewritten history is neither.

ALTER TABLE job_card_lines
  MODIFY COLUMN line_kind
    ENUM('part','labour','travel','charge','expense') NOT NULL DEFAULT 'part';

-- ── Who was paid, and what for ──────────────────────────────────────────────
--
-- Both nullable, and both SET NULL, because neither is the job modules to own.
--
-- supplier_id answers "who did we pay" and makes a subcontractor spend report
-- one join. It is NOT a purchase document: no order was raised, no goods were
-- received, and nothing here posts. It is a note of who the money went to, the
-- same way sales_documents records a customer without being the customer.
--
-- expense_category_id reuses the categories 042 already defines, so a job
-- expense and a cashbook expense land in the same bucket on the P&L rather than
-- inventing a second, parallel classification that would then have to be
-- reconciled against the first.
--
-- SET NULL rather than RESTRICT: retiring a supplier or a category must not be
-- refused because a job three years ago named it, and a line that loses its
-- category is still a true record of money spent.

ALTER TABLE job_card_lines
  ADD COLUMN IF NOT EXISTS supplier_id INT UNSIGNED NULL AFTER product_id,
  ADD COLUMN IF NOT EXISTS expense_category_id INT UNSIGNED NULL AFTER supplier_id;

ALTER TABLE job_card_lines
  ADD KEY IF NOT EXISTS ix_jcl_supplier (supplier_id);

ALTER TABLE job_card_lines
  ADD KEY IF NOT EXISTS ix_jcl_expense_category (expense_category_id);

-- ADD FOREIGN KEY IF NOT EXISTS <name>, never ADD CONSTRAINT IF NOT EXISTS:
-- MariaDB accepts the former and rejects the latter as a syntax error.
ALTER TABLE job_card_lines
  ADD FOREIGN KEY IF NOT EXISTS fk_jcl_supplier (supplier_id)
    REFERENCES suppliers (id) ON DELETE SET NULL;

ALTER TABLE job_card_lines
  ADD FOREIGN KEY IF NOT EXISTS fk_jcl_expense_category (expense_category_id)
    REFERENCES expense_categories (id) ON DELETE SET NULL;

-- ── What is NOT changed, and why ────────────────────────────────────────────
--
-- job_headline_parts.line_kind keeps its four values. That table requires a
-- product_id (NOT NULL), so it cannot hold an expense at all — offering the
-- value there would put a choice on the template screen that saving would then
-- refuse. A kind of work brings its parts, labour and travel; what a
-- subcontractor charged for one particular job is not a template.
