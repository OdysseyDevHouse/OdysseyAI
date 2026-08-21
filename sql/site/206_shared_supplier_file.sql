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
-- ── THE THREE THAT COULD HAVE GONE EITHER WAY: THEY STAY ─────────────────
--
-- purchase_documents (with its lines, charges and order details),
-- supplier_prices and product_suppliers. Each is genuinely arguable, and all
-- three stay in the branch. Decided deliberately, so it is written here rather
-- than left implicit in what the code happens to do.
--
-- WHAT THEY HAVE IN COMMON: every one of them keys into `products`, and
-- products do not move. Where a store group shares products at all it does so
-- by REPLICATION — the same product in each database, matched by code, an edit
-- fanned out (015) — which is a different mechanism from the ownership model
-- here. A table cannot be owned by the supplier file and keyed to a replicated
-- product at the same time without one of its ids meaning nothing.
--
-- 199 already settled this exact argument on the customer side. loyalty_ledger
-- and loyalty_wallet moved with the customer; loyalty_card_items stayed,
-- BECAUSE it has foreign keys to products and departments and "cannot follow
-- the customer without dragging the product file with it". Same shape, same
-- answer.
--
-- purchase_documents adds its own reason: finaliseDocument moves
-- products.average_cost and writes stock_movements in the same transaction as
-- the receipt. The stock arrives at a building. And uq_pdoc_number is
-- (doc_type, document_number) over a per-store sequence, so pooling ten
-- branches' orders would collide on the first PO either way.
--
-- product_suppliers and supplier_prices each carry a CASCADE key to `products`
-- AND one to `suppliers` — a shape 197 never met, since every table that moved
-- with the customer kept all its keys. Keeping them in the branch means the
-- products key survives and only the supplier one is dropped (below), which is
-- the half that can be enforced in code.
--
-- ── WHAT THIS MEANS THE FEATURE IS, AND IS NOT ───────────────────────────
--
-- It is ONE CREDITORS BOOK: one supplier record, one balance, one ledger, one
-- payment run, one statement — a supplier invoiced at branch 3 and paid from
-- branch 7 nets off correctly.
--
-- It is NOT CENTRAL BUYING. Orders, receipts, agreed prices and the
-- product-supplier links stay per store. Each branch orders for itself, at its
-- own agreed costs, into its own stock, with its own PO numbers. A branch's
-- "what is on order" figure counts only its own orders, which is the right
-- number for a branch reordering its own shelves and the wrong one for a group
-- buying centrally.
--
-- 015's header offers "central buying from one creditors book" as the
-- motivation for the switch. That was aspirational; this migration delivers the
-- creditors book and not the buying. The setup screen must say so plainly
-- rather than let the phrase imply more than it does — a shop that switched
-- this on expecting one PO series would find out by using it.
--
-- Genuine central buying is a larger, separate feature: it needs a group-wide
-- purchase order that a branch receives against, which is a new document flow
-- rather than a routing change.
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
