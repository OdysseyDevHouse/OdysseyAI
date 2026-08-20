-- Stamps and vouchers remember which store they came from.
--
-- A follow-on to 198 and 199, and the same bug as 198: loyalty_stamps was
-- classified with the CARDS (branch configuration) rather than with the
-- BALANCES, so it was missed when origin_site_id went on the points ledger,
-- the wallet and gift-card events. It holds customer progress, so it moves to
-- the owner with them and needs the same column.
--
-- Separate migration rather than an edit to 199 because 199 has already been
-- applied — a migration is recorded by name, so editing it in place changes
-- nothing on a database that has run it.

-- ── loyalty_stamps carries THREE branch ids ──────────────────────────────
--
-- card_id, document_id and the shift behind them are all per-database, and
-- uq_stamp_sale is built on two of them. It is the same silent-refusal bug 198
-- fixed for the points ledger, the wallet and gift cards: store 3 stamps its
-- sale 5001, store 7 stamps ITS sale 5001, and the second one is refused as a
-- duplicate — the customer just does not get the stamp.
--
-- Missed in 198 because the stamp table was classified with the cards rather
-- than with the balances. It holds customer progress, so it moves, and it needs
-- the same treatment.
ALTER TABLE loyalty_stamps
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER document_id;

ALTER TABLE loyalty_stamps DROP INDEX IF EXISTS uq_stamp_sale;
ALTER TABLE loyalty_stamps
  ADD UNIQUE KEY IF NOT EXISTS uq_stamp_sale
    (card_id, origin_site_id, customer_id, document_id, stamp_seq);

-- Points at sales_documents, which stays in the branch.
ALTER TABLE loyalty_stamps DROP FOREIGN KEY IF EXISTS fk_stamp_document;

-- Vouchers name the sale they were redeemed on, and the reward product. Both
-- branch-owned once the voucher itself lives with the customer.
ALTER TABLE loyalty_vouchers
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER redeemed_doc_number;

-- loyalty_members lives with the customer; loyalty_tiers stays in the branch.
-- The same boundary, so the same treatment. A member's tier is re-derived from
-- their rolling spend at every review, so a dangling tier_id self-corrects on
-- the next pass rather than needing repair.
ALTER TABLE loyalty_members DROP FOREIGN KEY IF EXISTS fk_loyalty_member_tier;
