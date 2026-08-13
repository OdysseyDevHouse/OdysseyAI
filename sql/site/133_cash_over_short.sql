-- ============================================================================
-- 133 — Cash over and short
--
-- WHY
--
-- closeShift() freezes each tender's variance into shift_counts and stops.
-- Nothing reaches the ledger, so the GL's cash figure holds what was RUNG UP,
-- not what the drawer actually held — every till shortage quietly accumulates
-- as drift between the books and reality, invisible to the income statement.
--
-- The standard treatment is a "cash over and short" expense account: a short
-- drawer debits it (money is gone), an over drawer credits it. The journal's
-- contra is the tender account the sale mirror originally debited, so after
-- cash-up the ledger's cash ends at counted reality.
--
-- Account 6910 sits directly after 6900 Sundry expenses. It is an ordinary
-- postable expense — a site that wants it elsewhere remaps the key.
--
-- Only variances on drawer-cash tenders post. A card "variance" is a
-- bank-settlement question, not missing drawer cash — see mirrorCashup().
-- ============================================================================

INSERT INTO gl_accounts (account_code, name, account_type, subtype, control_type, is_postable, sort_order)
SELECT '6910', 'Cash over and short', 'expense', 'operating', NULL, TRUE, 995
 WHERE NOT EXISTS (SELECT 1 FROM gl_accounts WHERE account_code = '6910');

-- INSERT IGNORE cannot dedupe a NULL ref_id row (NULLs never collide in a
-- unique key), so the guard is a NOT EXISTS — the 089 pattern.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'cash_over_short', NULL, a.id
  FROM gl_accounts a
 WHERE a.account_code = '6910'
   AND NOT EXISTS (
     SELECT 1 FROM gl_mappings m
      WHERE m.mapping_key = 'cash_over_short' AND m.ref_id IS NULL
   );
