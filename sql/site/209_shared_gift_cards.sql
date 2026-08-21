-- ── Gift cards can live in the group's database ───────────────────────────
--
-- They follow `shares_loyalty` — see sql/tickets/018_share_gift_cards.sql for
-- why there is no separate flag, and why the MONEY still needs its own answer
-- when the stores are separate companies.
--
-- ── THE THREE FOREIGN KEYS THAT HAVE TO GO ────────────────────────────────
--
-- No foreign key can span two databases. Once a branch's cards live in the
-- primary's database, each of these points at a table that is no longer beside
-- it:
--
--   fk_gift_card_customer   gift_cards.customer_id      -> customers
--   fk_gift_card_document   gift_cards.activated_doc_id -> sales_documents
--   fk_gc_event_document    gift_card_events.document_id -> sales_documents
--
-- fk_gc_event_card STAYS. gift_card_events and gift_cards move together and are
-- always in the same database, so the one FK that matters — an event with no
-- card — keeps being enforced by the database rather than by hope.
--
-- ── WHAT REPLACES EACH ────────────────────────────────────────────────────
--
-- The two document links become (origin_site_id, document_id) pairs, which is
-- the same fix 198 already applied to gift_card_events and 052 to the loyalty
-- ledger. A document id alone means nothing once twenty branches each have
-- their own sale 5001: gift_cards gains the column, and gift_card_events
-- already has it.
--
-- `customer_id` gains customer_origin_site_id for the same reason
-- loyalty_members did — the id is only unique within the file that issued it,
-- and a group may share gift cards while each branch keeps its own customers.
--
-- Losing ON DELETE SET NULL is the real cost, and it is small here. Deleting a
-- customer or a finalised sales document is already refused elsewhere, so the
-- clause was insurance against something that does not happen; and a card
-- naming a document that has gone is readable as history rather than broken.

/* ── gift_cards ─────────────────────────────────────────────────────────── */

ALTER TABLE gift_cards DROP FOREIGN KEY IF EXISTS fk_gift_card_customer;
ALTER TABLE gift_cards DROP FOREIGN KEY IF EXISTS fk_gift_card_document;

-- Which store made the sale that activated this card. NULL on a pre-generated
-- card that has never been sold, which is the `pending` status.
ALTER TABLE gift_cards
  ADD COLUMN IF NOT EXISTS origin_site_id INT UNSIGNED NULL AFTER activated_doc_number;

-- The site whose customer file customer_id belongs to. NULL exactly when
-- customer_id is NULL. See loyalty_members in 052 for the argument.
ALTER TABLE gift_cards
  ADD COLUMN IF NOT EXISTS customer_origin_site_id INT UNSIGNED NULL AFTER customer_id;

-- The activation lookup is by (site, document), so index the pair rather than
-- the document alone — a shared table holds twenty branches' worth of rows and
-- the old index would scan every store's sale 5001.
ALTER TABLE gift_cards DROP INDEX IF EXISTS idx_gift_card_document;
ALTER TABLE gift_cards
  ADD KEY IF NOT EXISTS idx_gift_card_document (origin_site_id, activated_doc_id);

/* ── gift_card_events ───────────────────────────────────────────────────── */

ALTER TABLE gift_card_events DROP FOREIGN KEY IF EXISTS fk_gc_event_document;

-- origin_site_id and uq_gc_event_doc already carry the pair — 198 did that when
-- it fixed the same duplicate-key problem for the loyalty ledger. Nothing to
-- add here; the FK was the only thing left holding it to one database.

-- The document index is site-blind, like gift_cards' was. Same fix, same
-- reason: a shared table holds twenty branches' rows and document_id alone
-- matches every store's sale 5001.
ALTER TABLE gift_card_events DROP INDEX IF EXISTS idx_gc_event_document;
ALTER TABLE gift_card_events
  ADD KEY IF NOT EXISTS idx_gc_event_document (origin_site_id, document_id);

-- There is no index on shift_id at all, and the cash-up reads by shift. That
-- was survivable while every table held one store's rows; on a shared table it
-- is a scan of the whole group's history per cash-up.
ALTER TABLE gift_card_events
  ADD KEY IF NOT EXISTS idx_gc_event_shift (origin_site_id, shift_id, entry_type);
