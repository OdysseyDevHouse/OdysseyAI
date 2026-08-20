-- Which store a shared-file row came from.
--
-- ── THE BUG THIS FIXES ───────────────────────────────────────────────────
--
-- When a store group shares one customer file, the debtors ledger, the loyalty
-- ledger, the wallet and gift-card events all live in the group's primary and
-- receive rows from every branch. The documents those rows point at do NOT
-- move: a sale stays in the shop that made it.
--
-- Document ids are per-database auto-increments. Store 3 and store 7 both have
-- a sales_documents #5001. Pooled into one table, `document_id` alone stops
-- identifying a document, and three UNIQUE keys built on it start rejecting
-- perfectly good rows:
--
--   loyalty_ledger.uq_ledger_document_earn  (document_id, entry_type)
--   loyalty_wallet.uq_wallet_document_spend (document_id, entry_type)
--   gift_card_events.uq_gc_event_doc        (card_id, document_id, entry_type)
--
-- Each exists to make a retried finalise safe: a sale may grant points exactly
-- once, and the database arbitrates the race rather than a SELECT that cannot
-- lock a row which does not exist yet. That is right and stays.
--
-- But across branches the arbitration fires on the wrong thing. Store 3 awards
-- points for its sale 5001; store 7 then awards points for ITS sale 5001 and
-- gets a duplicate-key error. The award is refused, the sale completes
-- normally, and the customer silently loses the points. Nobody sees an error —
-- which is what makes this worse than the foreign keys in 197, where the
-- failure at least announced itself.
--
-- customer_transactions has the same flaw in a different shape: four lookups
-- match on source_doc_id alone, and one of them is an UPDATE that would
-- rewrite another store's credit-note number.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────
--
-- Every row records the site it came from, and that goes into the key. The
-- pair (origin_site_id, document_id) identifies a document across the whole
-- group, which is exactly what the single database used to do on its own.
--
-- Deliberately NOT a foreign key: cp2_sites lives in the control database, and
-- a site leaving a group must not make its own history unreadable. Same
-- reasoning, and the same shape, as stock_transfers.peer_site_id in 101.
--
-- NULL means "written before this column existed, by a store that was not
-- sharing" — which is unambiguous, because a non-sharing store's document ids
-- were never at risk of colliding.

/* ── The debtors ledger ─────────────────────────────────────────────────── */

ALTER TABLE customer_transactions
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER source_doc_id;

-- The lookups that match on source_doc_id resolve through this.
ALTER TABLE customer_transactions
  ADD INDEX IF NOT EXISTS ix_ctxn_origin_source (origin_site_id, source, source_doc_id);

/* ── Loyalty points ─────────────────────────────────────────────────────── */

ALTER TABLE loyalty_ledger
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER document_number;

ALTER TABLE loyalty_ledger DROP INDEX IF EXISTS uq_ledger_document_earn;
ALTER TABLE loyalty_ledger
  ADD UNIQUE KEY IF NOT EXISTS uq_ledger_document_earn (origin_site_id, document_id, entry_type);

/* ── The wallet ─────────────────────────────────────────────────────────── */

ALTER TABLE loyalty_wallet
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER document_number;

ALTER TABLE loyalty_wallet DROP INDEX IF EXISTS uq_wallet_document_spend;
ALTER TABLE loyalty_wallet
  ADD UNIQUE KEY IF NOT EXISTS uq_wallet_document_spend (origin_site_id, document_id, entry_type);

/* ── Gift cards ─────────────────────────────────────────────────────────── */

ALTER TABLE gift_card_events
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER document_number;

ALTER TABLE gift_card_events DROP INDEX IF EXISTS uq_gc_event_doc;
ALTER TABLE gift_card_events
  ADD UNIQUE KEY IF NOT EXISTS uq_gc_event_doc (card_id, origin_site_id, document_id, entry_type);
