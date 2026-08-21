-- Branch tables let go of the supplier file. The creditors twin of 197.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- A store group may share one supplier file: the group's primary holds
-- `suppliers` and every branch reads and writes it, so there is one balance,
-- one code and one ledger. See lib/storeGroups.ts (supplierOwnerSite) and
-- sql/tickets/015_share_customers.sql, which gave customers and suppliers two
-- separate switches because a group may run central buying from one creditors
-- book while each branch keeps its own debtors, or the reverse.
--
-- The tables below stay in the BRANCH, because each records something that
-- happened at a shop: this store's order, this store's bill, this store's
-- asset. Their supplier_id then points at a row in ANOTHER database, and the
-- foreign key here cannot follow it.
--
-- Without this migration a branch cannot record anything against a shared
-- supplier at all:
--
--   ER_NO_REFERENCED_ROW_2: a foreign key constraint fails
--   (`ody10001_master`.`purchase_documents`, CONSTRAINT `fk_pdoc_supplier` ...)
--
-- ── WHICH TABLES MOVE, AND WHICH STAY ────────────────────────────────────
--
-- MOVE with the supplier (keep their foreign keys, which stay inside one
-- database):  suppliers, supplier_transactions, supplier_allocations,
-- supplier_contacts, supplier_payment_runs, supplier_payment_items,
-- supplier_payment_allocations.
--
-- STAY in the branch: everything below, plus expenses, purchase_documents and
-- their children. A bill this shop received, paid from this shop's bank
-- account, against stock delivered to this shop's shelves.
--
-- product_suppliers and supplier_prices are NOT decided here. Each carries a
-- CASCADE foreign key to `products` AND one to `suppliers`, so no placement
-- keeps both — a shape 197 never met, since every table that moved with the
-- customer kept all its keys. They keep their current placement (branch) and
-- their supplier-side key is dropped below; whether they should move at all is
-- a separate decision with a schema change behind it.
--
-- ── WHAT IS LOST, AND WHAT REPLACES IT ───────────────────────────────────
--
-- The same trade 197 named, and it should be named again rather than assumed:
-- the database will no longer refuse a purchase order against a supplier that
-- does not exist, and RESTRICT will no longer refuse to delete a supplier who
-- still has documents.
--
-- Both move into code. Every write path already loads the supplier before
-- writing, and deleteSupplier() refuses on a non-zero balance and on linked
-- documents BEFORE the database would have. The columns keep their indexes, so
-- nothing gets slower.

/* ── Branch tables pointing at `suppliers` ──────────────────────────────── */

ALTER TABLE purchase_documents        DROP FOREIGN KEY IF EXISTS fk_pdoc_supplier;
ALTER TABLE purchase_document_charges DROP FOREIGN KEY IF EXISTS fk_pcharge_supplier;
ALTER TABLE expenses                  DROP FOREIGN KEY IF EXISTS fk_exp_supplier;
ALTER TABLE recurring_expenses        DROP FOREIGN KEY IF EXISTS fk_recur_supplier;
ALTER TABLE fixed_assets              DROP FOREIGN KEY IF EXISTS fk_asset_supplier;
ALTER TABLE commission_rules          DROP FOREIGN KEY IF EXISTS fk_commission_rule_supplier;
ALTER TABLE job_card_lines            DROP FOREIGN KEY IF EXISTS fk_jcl_supplier;
ALTER TABLE product_suppliers         DROP FOREIGN KEY IF EXISTS fk_prodsupp_supplier;
ALTER TABLE supplier_prices           DROP FOREIGN KEY IF EXISTS fk_sprice_supplier;

/* ── Branch tables pointing at `supplier_transactions` ──────────────────── */

-- 203 dropped fk_link_ctxn for the customer side and said in as many words that
-- this one would need the same treatment when supplier sharing was exercised:
-- "It is left standing deliberately, not overlooked." This is that moment.
--
-- cashbook_links stays in the branch because it also keys into
-- bank_transactions, and a bank account belongs to the shop that holds it. So
-- it cannot follow supplier_transactions to the owner, and the key it holds is
-- an id in a table that is no longer here. Measured on the customer side: the
-- creditor was paid, the bank half rolled back on this constraint, and the
-- money was off the ledger and nowhere in the cashbook.
ALTER TABLE cashbook_links DROP FOREIGN KEY IF EXISTS fk_link_stxn;

-- The same shape, and this one has no customer counterpart at all — `expenses`
-- is creditors-only. expenses.supplier_txn_id is written straight after
-- postSupplierTransaction returns an OWNER-side id, so it fails identically.
ALTER TABLE expenses DROP FOREIGN KEY IF EXISTS fk_exp_supplier_txn;

/* ── Where a pooled row came from ───────────────────────────────────────── */

-- The creditors half of 198, and it is not optional.
--
-- supplier_transactions.source_doc_id points at purchase_documents.id or
-- expenses.id — both BRANCH tables, whose ids are per-database
-- auto-increments. Pooled into one owner table, `source_doc_id` alone stops
-- identifying a document.
--
-- purchaseInvoiceMatch.ts finds a GRV's invoice with
--
--   WHERE source = 'purchase' AND source_doc_id = ? AND supplier_id = ?
--   ORDER BY id LIMIT 1
--
-- and then UPDATEs the row's doc_number and due_date. Branch 3's GRV 5001 and
-- branch 7's GRV 5001 both match, so recording an invoice number at one branch
-- rewrites another branch's invoice number and ages it from a date that
-- supplier never agreed to. No error, no duplicate key — the wrong row simply
-- wins the ORDER BY.
--
-- This is the fault 198 fixed for customer_transactions, in the same words:
-- "four lookups match on source_doc_id alone, and one of them is an UPDATE that
-- would rewrite another store's credit-note number." Only the customer side got
-- the column.
--
-- Deliberately NOT a foreign key, for the reason 198 and 101 give: cp2_sites is
-- in the control database, and a site leaving a group must not make its own
-- history unreadable. NULL means "written before this column existed", which is
-- unambiguous because a non-sharing store's document ids never collided.
ALTER TABLE supplier_transactions
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER source_doc_id;

ALTER TABLE supplier_transactions
  ADD INDEX IF NOT EXISTS ix_stxn_origin_source (origin_site_id, source, source_doc_id);

-- The creditors half of 204. A payment run lives in the owner's database with
-- the ledger it settles, so every branch sees every other branch's runs in one
-- undifferentiated list: listRuns is `SELECT * FROM supplier_payment_runs ORDER
-- BY created_at DESC LIMIT n` with no scope at all, and cancelPaymentRun will
-- happily cancel another branch's draft.
--
-- As in 204 this records PROVENANCE and does not scope the WORK: a payment run
-- pays down a balance, and under sharing there is one balance for the group, so
-- a run must stay group-wide or a supplier owed across three branches gets
-- three partial payments.
ALTER TABLE supplier_payment_runs
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER user_name;

ALTER TABLE supplier_payment_runs
  ADD INDEX IF NOT EXISTS ix_sprun_origin (origin_site_id, created_at);
