-- Branch tables let go of the customer file.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- A store group may share one customer file: the group's primary store holds
-- `customers` and every branch reads and writes it, so there is one balance,
-- one credit limit and one ledger. See lib/storeGroups.ts (customerOwnerSite)
-- and sql/tickets/015_share_customers.sql.
--
-- The tables below stay in the BRANCH, because each records something that
-- happened at a shop: this store's sale, this store's layby, this store's job.
-- Their customer_id then points at a row in ANOTHER database, and the foreign
-- key here cannot follow it — it names `customers` in this schema, and this
-- schema's `customers` no longer holds that id.
--
-- Without this migration a branch cannot record anything against a shared
-- customer at all:
--
--   ER_NO_REFERENCED_ROW_2: a foreign key constraint fails
--   (`ody10001_master`.`laybys`, CONSTRAINT `fk_layby_customer` ...)
--
-- ── WHY NOT JUST REPOINT THEM AT THE OWNER ───────────────────────────────
--
-- MariaDB does accept a cross-database foreign key, and its cascade fires —
-- both measured in scripts/probe-shared-customer-file.ts. But the target would
-- have to be a specific database NAME baked into the schema, and the same
-- schema has to be right for a store that shares and one that does not. One
-- table cannot have two definitions, so there is nothing to repoint TO.
--
-- ── WHAT IS LOST, AND WHAT REPLACES IT ───────────────────────────────────
--
-- A real guarantee, and it should be named rather than glossed over: the
-- database will no longer refuse a sale against a customer that does not
-- exist, and RESTRICT will no longer refuse to delete a customer who still has
-- documents.
--
-- Both move into code:
--   · Every write path already loads the customer before writing — the till
--     resolves an account before it can tender to it, and salesPosting refuses
--     an account tender with no customer.
--   · deleteCustomer() already refuses on a non-zero balance and on linked
--     documents, and it refuses BEFORE the database would have.
--
-- The columns keep their indexes, so nothing gets slower.
--
-- ── WHICH TABLES ARE *NOT* HERE ──────────────────────────────────────────
--
-- Everything that moves WITH the customer keeps its foreign key, because the
-- reference stays inside one database: customer_transactions,
-- customer_allocations, statements, credit control, contacts, addresses,
-- logins, portal links, loyalty and gift cards. Those are the majority. Only
-- the twelve below stay behind.
--
-- cashbook_links is also untouched: it keys into customer_transactions, which
-- moves, so its cascade still resolves locally.

ALTER TABLE sales_documents      DROP FOREIGN KEY IF EXISTS fk_sdoc_customer;
ALTER TABLE laybys               DROP FOREIGN KEY IF EXISTS fk_layby_customer;
ALTER TABLE job_cards            DROP FOREIGN KEY IF EXISTS fk_jcard_customer;
ALTER TABLE job_series           DROP FOREIGN KEY IF EXISTS fk_series_customer;
ALTER TABLE job_sla_policies     DROP FOREIGN KEY IF EXISTS fk_sla_customer;
ALTER TABLE service_addresses    DROP FOREIGN KEY IF EXISTS fk_saddr_customer;
ALTER TABLE customer_assets      DROP FOREIGN KEY IF EXISTS fk_asset_customer;
ALTER TABLE online_orders        DROP FOREIGN KEY IF EXISTS fk_online_order_customer;
ALTER TABLE online_saved_baskets DROP FOREIGN KEY IF EXISTS fk_saved_basket_customer;
ALTER TABLE discount_code_uses   DROP FOREIGN KEY IF EXISTS fk_use_customer;
ALTER TABLE contracts            DROP FOREIGN KEY IF EXISTS fk_contract_customer;
ALTER TABLE tickets              DROP FOREIGN KEY IF EXISTS fk_ticket_customer;
