-- Repoints freight_in from 4000 to 5200 where 088 mapped it wrongly.
--
-- 088 pointed the freight_in key at account code 4000, reasoning from
-- 042_expenses.sql, where the EXPENSE CATEGORY "Cost of sales -- freight in"
-- is 4000. But that is a different numbering scheme from the GL chart, where
-- 045_general_ledger.sql seeds 4000 as SALES -- an income account -- and puts
-- Freight in at 5200. 045 line 396 maps between the two schemes explicitly;
-- 088 did not read far enough.
--
-- ── WHY THIS NEEDED ITS OWN FILE ─────────────────────────────────────────
--
-- The runner records a migration by NAME. 088 has already run on at least one
-- site, so editing it fixes nothing there -- the corrected file would simply
-- never be applied again. The fix has to arrive as a new file.
--
-- ── WHY IT MATTERS MORE THAN A WRONG-LOOKING NUMBER ──────────────────────
--
-- The journal still BALANCED: freight was debited to 4000 and credited to
-- creditors, and debits equalled credits. Nothing would have complained. But
-- 4000 is income, so every carrier invoice was quietly inflating revenue and
-- leaving cost of sales short by the same amount -- the two errors cancelling
-- in the trial balance and both showing up in the income statement.
--
-- Only moved where it still points at 4000: a site that has since chosen its
-- own freight account keeps that choice.
UPDATE gl_mappings m
  JOIN gl_accounts wrong ON wrong.id = m.account_id AND wrong.account_code = '4000'
  JOIN gl_accounts right_account ON right_account.account_code = '5200'
   SET m.account_id = right_account.id
 WHERE m.mapping_key = 'freight_in'
   AND m.ref_id IS NULL;

-- And seed it for any site that reaches this file without 088 having found an
-- account to map at all.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'freight_in', NULL, a.id
  FROM gl_accounts a
 WHERE a.account_code = '5200'
   AND NOT EXISTS (
     SELECT 1 FROM gl_mappings m
      WHERE m.mapping_key = 'freight_in' AND m.ref_id IS NULL
   );
