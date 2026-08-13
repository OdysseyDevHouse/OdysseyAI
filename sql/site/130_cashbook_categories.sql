-- ============================================================================
-- 130 — Cashbook captures reach the ledger
--
-- WHY
--
-- recordCustomerReceipt mirrors to the GL; captureTransaction — the general
-- capture behind bank charges, interest received, drawings, capital and every
-- categorised statement import — did not. Every such entry moved
-- bank_transactions and bank_accounts.balance while the GL's bank control
-- account stood still, so reconcileControlAccounts reported drift with no fix.
--
-- The missing piece is WHERE THE OTHER SIDE GOES. A capture knows its bank
-- account (one leg); the contra needs a target. These two columns store that
-- target as a gl_mappings coordinate — the same (key, ref) shape every other
-- mirror resolves through — so "bank charges" points at the expense category
-- and "interest received" at its mapping, and the journal builder needs no
-- category table of its own.
--
-- NULL means uncategorised: no journal is attempted (fail-soft, the 045 rule),
-- and the entry shows on the reconciliation screen as unmirrored until someone
-- categorises it. An imported statement line starts NULL and gains its
-- category when a person (or a cashbook rule) files it.
-- ============================================================================

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS category_key VARCHAR(40) NULL AFTER source_doc_id,
  ADD COLUMN IF NOT EXISTS category_ref_id INT UNSIGNED NULL AFTER category_key;

-- Contra targets that had no mapping key yet. Guarded with NOT EXISTS — the
-- 089 pattern; INSERT IGNORE cannot dedupe a NULL ref_id.
INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'owner_drawings', NULL, a.id FROM gl_accounts a
 WHERE a.account_code = '3100'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m WHERE m.mapping_key = 'owner_drawings' AND m.ref_id IS NULL);

INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'capital_introduced', NULL, a.id FROM gl_accounts a
 WHERE a.account_code = '3000'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m WHERE m.mapping_key = 'capital_introduced' AND m.ref_id IS NULL);

INSERT INTO gl_mappings (mapping_key, ref_id, account_id)
SELECT 'other_income', NULL, a.id FROM gl_accounts a
 WHERE a.account_code = '4900'
   AND NOT EXISTS (SELECT 1 FROM gl_mappings m WHERE m.mapping_key = 'other_income' AND m.ref_id IS NULL);
