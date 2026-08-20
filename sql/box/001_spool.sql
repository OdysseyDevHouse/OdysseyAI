-- ============================================================================
-- 001_spool.sql — the in-store box's own tables
-- ============================================================================
--
-- A hybrid site keeps its shop in the cloud and one narrow thing in the
-- building: the OPEN TAB. This file creates only what holding a tab needs.
--
-- ── WHY THE SHOP'S TABLES ARE NOT COPIED HERE ───────────────────────────────
--
-- `sales_documents`, `sales_document_lines` and `pos_tables` are created by
-- scripts/box-migrate.mjs, which reads their live definition from the site's
-- OWN database and reshapes it. Not copied into this file, and that is
-- deliberate:
--
--   · 25 migrations in sql/site/ have altered those three tables since they
--     were created. A frozen copy here would be wrong within a release, and
--     wrong SILENTLY — the box would accept a tab the cloud then refuses.
--   · The live definition already differs from 015_sales_core.sql in ways that
--     matter: `credit_sale` not `credit_note`, `saved` not `parked`, plus the
--     offline_* columns. Hand-copying would have reproduced the 2023 shape.
--
-- ── AND WHY THE FOREIGN KEYS ARE DROPPED ────────────────────────────────────
--
-- Those three tables carry 18 foreign keys between them. Following that closure
-- pulls in 32 tables — customers, products, suppliers, job cards, stock
-- locations, price structures — measured against a live site, not guessed. That
-- is a shop, not a spool, and it would put the box back in the business of
-- holding things the cloud is the master of.
--
-- So the box keeps the COLUMNS and drops the CONSTRAINTS. `customer_id` is
-- still recorded on a tab; there is simply no `customers` table here to point
-- at. That is the same trick `sales_documents.user_id` already uses for
-- cp2_users, which lives in another database entirely and has never had a FK.
--
-- What that costs, stated plainly: the box cannot enforce that a product on a
-- tab exists. It does not need to — the cloud recomputes every figure when the
-- sale arrives (see lib/site/offlineSync.ts), and a line whose product has been
-- deleted already posts with product_id NULL by design.

-- ── The outbox ──────────────────────────────────────────────────────────────
--
-- Finalised sales waiting to reach the cloud. The device-local outbox in
-- lib/posOffline/ moved here: on a hybrid site the box holds the queue, because
-- the box is what has the tab.
--
-- The rules come with it unchanged, and they are the important part:
--
--   · A `pending` row is a sale that HAPPENED. The customer has the goods and
--     the drawer has the cash, and this row is the only record. Nothing deletes
--     one — not a prune, not a version upgrade, not a "clear cache".
--   · `synced` rows are deletable, because the cloud has them.
--   · `failed` rows are kept until a human deals with them. A sale that quietly
--     disappeared is worse than one in a list marked "needs attention".
CREATE TABLE IF NOT EXISTS box_outbox (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Client-generated, and the idempotency key the cloud claims against. A
  -- replayed batch must be a no-op rather than a second sale.
  sale_uid       CHAR(36)     NOT NULL,

  -- The number PRINTED on the customer's slip, allocated by the till from its
  -- own per-till sequence. It travels with the sale because the cloud adopts it
  -- rather than issuing a new one — two numbers for one sale is the outcome the
  -- whole numbering design exists to prevent.
  document_number VARCHAR(32) NOT NULL,

  -- When it was rung up, NOT when it was queued. The cloud posts oldest-first
  -- and back-dates nothing, so this is the figure that decides the order.
  taken_at       DATETIME     NOT NULL,

  -- The whole sale, exactly as the till captured it: lines, tenders, customer,
  -- operator. JSON rather than columns because the box never reads inside it —
  -- it is a sealed envelope the cloud opens. Giving it columns here would be a
  -- second definition of a sale, free to drift from the one that matters.
  payload        LONGTEXT     NOT NULL,

  status         ENUM('pending','synced','failed') NOT NULL DEFAULT 'pending',

  -- Why the cloud refused it, for the exceptions screen. Null while pending.
  last_error     VARCHAR(400) NULL,
  attempts       INT UNSIGNED NOT NULL DEFAULT 0,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  synced_at      DATETIME     NULL,

  PRIMARY KEY (id),

  -- One row per sale, enforced rather than hoped for. A till that retries a
  -- queue-write after a timeout must not create a second copy of a sale that
  -- is already waiting.
  UNIQUE KEY uq_box_outbox_uid (sale_uid),

  -- The flush query: pending, oldest first.
  KEY ix_box_outbox_flush (status, taken_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── The licence lease ───────────────────────────────────────────────────────
--
-- Whether this shop may still trade, readable with the line down.
--
-- ── WHY ONE ROW FOR THE SITE, NOT ONE PER TILL ──────────────────────────────
--
-- Ten tills would drift: three locking on Tuesday and the rest on Thursday is
-- confusing to support and worse to explain to a customer. The box renews once
-- for the shop and all ten read the same answer.
--
-- ── WHY checked_at AND expires_at ARE SEPARATE ──────────────────────────────
--
-- Carried over from the local backend's lease, and the distinction is the whole
-- point: an unlock extends how long a machine may RUN without claiming a
-- conversation happened. A shop silent for three weeks still reads as silent
-- for three weeks, however many times support extended it. Collapsing these
-- into one column launders a non-payer clean.
CREATE TABLE IF NOT EXISTS box_lease (
  -- Exactly one row. The constant makes that a constraint rather than a
  -- convention, so a second lease cannot quietly appear and disagree.
  id           TINYINT UNSIGNED NOT NULL DEFAULT 1,

  site_id      INT UNSIGNED NOT NULL,

  -- When the control panel was last actually reached. Never moved by an unlock.
  checked_at   DATETIME     NOT NULL,

  -- When trading stops without a further check. Moved by a renewal OR a
  -- telephone unlock.
  expires_at   DATETIME     NOT NULL,

  -- What the control panel said when it was last reached, for the lock screen.
  licence_status VARCHAR(40) NOT NULL DEFAULT '',

  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                            ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT ck_box_lease_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── What this box is ────────────────────────────────────────────────────────
--
-- Which site it serves and when it was provisioned. One row, same singleton
-- reasoning as the lease.
--
-- Its job is to make a MISMATCH loud. A box provisioned for site 1 that a till
-- for site 2 connects to would otherwise serve that till somebody else's tabs —
-- and the tills would look right while doing it.
CREATE TABLE IF NOT EXISTS box_identity (
  id            TINYINT UNSIGNED NOT NULL DEFAULT 1,
  site_id       INT UNSIGNED NOT NULL,
  site_code     VARCHAR(32)  NOT NULL,

  -- The schema version applied by box-migrate.mjs, so a till can refuse a box
  -- older than the sale shape it is sending.
  schema_version INT UNSIGNED NOT NULL DEFAULT 0,

  provisioned_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT ck_box_identity_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
