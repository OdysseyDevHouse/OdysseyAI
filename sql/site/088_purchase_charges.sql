-- Shipping and charges on a receipt, itemised — and attributable to whoever
-- actually invoiced them.
--
-- purchase_documents.charges_excl has existed since 017 and works: it is
-- apportioned across the lines by value, so landed cost is already right. What
-- it cannot say is WHO WAS PAID. A freight company that invoices separately is
-- currently buried inside the goods supplier's total, which means:
--
--   * the freight company's account shows nothing, so their invoice cannot be
--     matched, aged or paid through the payment run
--   * the goods supplier appears to be owed money that is not theirs
--   * freight-in never reaches its own expense account, so cost of sales is
--     understated and nobody can see what delivery is costing the business
--
-- So the total stays where it is and this table explains what it is made of.
-- charges_excl remains the sum, which is what keeps every existing GRV, report,
-- return and void path working untouched.
--
-- ── THE RULE THAT MATTERS ────────────────────────────────────────────────
--
-- EVERY charge row is apportioned into landed cost, whoever is being paid: the
-- goods cost what they cost to get onto the shelf, and a case that needed R60
-- of courier cost R60 more than the invoice says regardless of which invoice
-- carried it. What differs is the CREDIT side --
--
--   supplier_id NULL -- charged by the goods supplier on the same invoice.
--                       Exactly today's behaviour, and the default.
--   supplier_id set  -- a separate invoice. Gets its OWN supplier_transactions
--                       posting against that account, and a GL line to
--                       freight-in rather than to stock control.
--
-- A GRV can therefore create more than one creditor invoice, and voiding one
-- must reverse EVERY posting it made. A void that reverses the goods invoice
-- and forgets the courier's leaves that account permanently overstated, with
-- nothing on either document to say so.
CREATE TABLE IF NOT EXISTS purchase_document_charges (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  document_id     INT UNSIGNED NOT NULL,

  -- NULL means the goods supplier billed it on the same invoice. A value means
  -- a separate creditor, posted to their own account.
  supplier_id     INT UNSIGNED NULL,

  -- What it was for, in the words that will appear on the GRV and in the GL
  -- journal line. "Courier", "Import duty", "Pallet deposit".
  description     VARCHAR(120) NOT NULL,

  -- EXCLUSIVE of VAT, like every other purchase figure in this schema.
  amount_excl     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  vat_rate_pct    DECIMAL(6,3)  NOT NULL DEFAULT 0.000,

  -- THEIR invoice number for the freight, which is what the payment run
  -- matches against. Distinct from the goods supplier's invoice number on
  -- purchase_documents.
  their_invoice_no VARCHAR(60) NULL,

  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_pcharge_document (document_id),
  KEY ix_pcharge_supplier (supplier_id),
  -- CASCADE from the document: a charge has no meaning without the receipt it
  -- was incurred on, and the receipt is what carries the audit trail.
  CONSTRAINT fk_pcharge_doc FOREIGN KEY (document_id)
    REFERENCES purchase_documents (id) ON DELETE CASCADE,
  -- RESTRICT on the supplier, matching fk_pdoc_supplier: a freight company we
  -- have posted an invoice to is not deletable, and the database says so
  -- rather than trusting every code path to remember.
  CONSTRAINT fk_pcharge_supplier FOREIGN KEY (supplier_id)
    REFERENCES suppliers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Freight in, so the expense lands somewhere that means something.
--
-- 5200 "Freight in", an EXPENSE in the cost_of_sales group, seeded by
-- 045_general_ledger.sql. Note that it is 5200 and not the 4000 that
-- 042_expenses.sql uses for its own "Cost of sales -- freight in" category:
-- those are two different numbering schemes, and 045 line 396 maps between
-- them explicitly for exactly this reason.
--
-- Getting that wrong is not a cosmetic error. In the GL chart 4000 is SALES,
-- an income account -- so mapping freight there balances the journal perfectly
-- while overstating revenue and understating cost of sales by the same amount.
-- The trial balance would never complain.
--
-- NOT EXISTS rather than INSERT IGNORE, for the reason 081_stock_takes.sql
-- sets out at length: uq_mapping is (mapping_key, ref_id) and MySQL treats
-- NULLs as DISTINCT, so the default row for a key collides with nothing and
-- IGNORE would never fire. The guard also means a site that has already
-- pointed this key somewhere of its own keeps that choice.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'freight_in', NULL, a.id
  FROM gl_accounts a
 WHERE a.account_code = '5200'
   AND NOT EXISTS (
     SELECT 1 FROM gl_mappings m
      WHERE m.mapping_key = 'freight_in' AND m.ref_id IS NULL
   );
