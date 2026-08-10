-- A purchase line discount entered as an AMOUNT, not only as a percentage.
--
-- discount_pct has been the only way to take money off a line since 017. That
-- is fine when the supplier quotes "less 12.5%", and wrong when they quote
-- "less R37.50": storing the amount as a percentage of the line gives 12.497%
-- on a R300.10 line, and rendering it back gives R37.49. The cent is small; the
-- fact that the number the buyer typed is not the number the system holds is
-- not, because it is the invoice they have to agree with.
--
-- So both are stored, and the ABSOLUTE AMOUNT WINS when it is non-zero. That is
-- the same rule lineTotals() in documentMath.ts already applies on the sales
-- side, where discountIncl beats discountPct — one rule, both directions of the
-- business, nothing new to remember.
--
-- The percentage column stays as it is. Every existing line has 0.0000 here, so
-- the percentage keeps winning for all of them and nothing already posted
-- changes value.
ALTER TABLE purchase_document_lines
  ADD COLUMN discount_amount DECIMAL(12,4) NOT NULL DEFAULT 0.0000 AFTER discount_pct;
