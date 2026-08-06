-- ─────────────────────────────────────────────────────────────────────────
-- Online store: the public storefront's configuration, its orders, and the
-- workflow they move through.
--
-- This is the foundation the Setup screen writes to and everything else in
-- the section will read. It is NOT a transliteration of the old
-- tblbackoffice_online_* tables — those were flat, string-keyed and unable to
-- reference anything. Here an order points at a real customer, a real sale
-- and a real department, because those tables exist in this database and a
-- foreign key is what stops the two drifting apart.
--
-- ── THE ORDER IS A REQUEST, THE SALE IS THE TRUTH ────────────────────────
--
-- An online order is NOT a sales document. It is what a shopper asked for, at
-- the price they were shown, before anyone in the shop agreed to it. Accepting
-- one creates a normal sales_document and links back here.
--
-- Both are kept. The order is the evidence of what was requested — when a
-- re-priced line differs from the request, staff (and later a dispute) need
-- both numbers, and deleting the basket on acceptance throws away the only
-- record of what the customer actually saw.
--
-- ── WHY MONEY IS NOT HERE YET ────────────────────────────────────────────
--
-- There is no payment_status, no gateway reference and no paid_at column, and
-- that is deliberate. Taking money needs a verified-callback path — an order
-- may only ever be marked paid by a gateway webhook whose signature checked
-- out, never by the shopper's browser landing back on a return URL. Adding the
-- columns before that path exists invites code to set them from the wrong
-- place, and the failure mode is goods handed over for money that never
-- arrived. Payments get their own migration alongside the gateway.
--
-- Until then a store runs pay-on-collection, which is what payment_mode
-- defaults to.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Settings ─────────────────────────────────────────────────────────────
-- One row, id pinned to 1. Its own table rather than rows in `settings`
-- because these are a dozen related values read together on every storefront
-- request, and the KV store is documented as being for single scalars nobody
-- joins to.
CREATE TABLE IF NOT EXISTS online_store_settings (
  id                 TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- The master switch. Off means the public link 404s regardless of
  -- everything below, so a store can configure over several sittings without
  -- ever being half-exposed.
  is_enabled         TINYINT(1)   NOT NULL DEFAULT 0,

  collect_enabled    TINYINT(1)   NOT NULL DEFAULT 1,
  deliver_enabled    TINYINT(1)   NOT NULL DEFAULT 0,

  -- 'on_collection' until a verified gateway path exists. See the note above.
  payment_mode       ENUM('on_collection','online') NOT NULL DEFAULT 'on_collection',

  -- Whether a signed-in account customer may charge an order to their account.
  -- The credit limit is checked at checkout and the account is only debited
  -- when the sale is finalised — the order itself moves no money.
  allow_account      TINYINT(1)   NOT NULL DEFAULT 0,

  -- What the public sees:
  --   departments — only products in departments ticked show_online
  --   flagged     — only products ticked show_online
  --   all         — the whole product file
  -- Defaults to the NARROWEST option. The storefront is public, so the safe
  -- default is the one that exposes least; 'all' has to be chosen.
  publish_mode       ENUM('departments','flagged','all') NOT NULL DEFAULT 'departments',

  -- Which price structure the storefront quotes. NULL means the default
  -- structure, matching how a walk-in is priced.
  price_structure_id INT UNSIGNED NULL,

  -- How long the shop needs before an order can be collected. The storefront
  -- must refuse a slot inside this window rather than promise what the kitchen
  -- cannot deliver.
  lead_time_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 30,

  -- 0 means no minimum.
  min_order_incl     DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- One line describing the shop; used when the link is shared.
  blurb              VARCHAR(500) NOT NULL DEFAULT '',

  -- Where a paid order lands in the queue. Nullable so it can be set once
  -- statuses exist; SET NULL rather than RESTRICT so deleting a status cannot
  -- wedge the settings row.
  paid_status_id     INT UNSIGNED NULL,

  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by         VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- The single-row guarantee. Without it nothing stops a second settings row
  -- appearing and the storefront reading whichever it finds first.
  CONSTRAINT ck_online_settings_singleton CHECK (id = 1),
  CONSTRAINT fk_online_price_structure
    FOREIGN KEY (price_structure_id) REFERENCES price_structures (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO online_store_settings (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;

-- ── What is published ────────────────────────────────────────────────────
-- A flag on the department and on the product, rather than a list of ids in a
-- settings column. The old design kept PublishDepartments as comma-separated
-- text, which cannot be joined, cannot be indexed, and silently keeps pointing
-- at departments that no longer exist.
ALTER TABLE departments
  ADD COLUMN show_online TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE products
  ADD COLUMN show_online TINYINT(1) NOT NULL DEFAULT 0;

-- The storefront's main query is "everything publishable", which without this
-- is a full scan of the product file on every page load.
ALTER TABLE products
  ADD KEY ix_product_show_online (show_online, is_archived);

-- ── Delivery zones ───────────────────────────────────────────────────────
-- Where the store delivers and what it charges.
--
-- Matching is on suburb or postcode: plain text a shop owner can reason about
-- and check. Radius matching needs geocoding on every checkout and a decision
-- about what to do when it fails, so it is left out rather than half-built.
CREATE TABLE IF NOT EXISTS online_delivery_zones (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name             VARCHAR(120) NOT NULL,
  match_type       ENUM('suburb','postcode') NOT NULL DEFAULT 'suburb',
  -- The value to match against, e.g. 'Claremont' or '7708'.
  match_value      VARCHAR(190) NOT NULL,
  fee_incl         DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- The common "free delivery over R500". 0 disables it.
  free_over_incl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Lets a store refuse a delivery not worth the trip. 0 disables it.
  min_order_incl   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  is_active        TINYINT(1)   NOT NULL DEFAULT 1,
  sort_order       INT          NOT NULL DEFAULT 0,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_zone_active (is_active, sort_order),
  -- Two zones matching the same suburb would make the fee depend on row order.
  UNIQUE KEY uq_zone_match (match_type, match_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Order statuses ───────────────────────────────────────────────────────
-- The workflow, owned by the store.
--
-- A fixed enum was one shop's process. A bakery has two steps and a butchery
-- with a van has six, and neither calls the last one "Completed" — they call
-- it "Handed over" or "Collected". How many steps there are, and what each is
-- called, is a property of the BUSINESS.
--
-- But renaming must stay free while MEANING stays findable, so three things
-- the code must locate without knowing the shop's vocabulary are carried by
-- `role` rather than by name:
--
--   new       — where an order lands when it is placed
--   completed — finished; archiving is allowed from here
--   cancelled — turned down. Not merely another step: a PAID order reaching
--               this status has to be credited, so the code must know which
--               one it is.
--
-- Each role is held by at most one status at a time.
CREATE TABLE IF NOT EXISTS online_order_statuses (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Generated from the name once, then frozen. Orders reference the id, so a
  -- rename relabels every order sitting in the status instead of stranding it.
  code          VARCHAR(40)  NOT NULL,
  name          VARCHAR(60)  NOT NULL,
  -- A Badge tone, not a hex — so a status stays legible in both themes.
  tone          ENUM('neutral','brand','success','warning','danger') NOT NULL DEFAULT 'neutral',
  -- Position in the pipeline. THIS is the workflow order: "move it along"
  -- offers the next status by sort_order.
  sort_order    INT          NOT NULL DEFAULT 0,
  -- '' for an ordinary step. See the note above.
  role          ENUM('','new','completed','cancelled','dispatched') NOT NULL DEFAULT '',
  -- Off retires a status: gone from the pickers, but orders already in it keep
  -- their label. Deleting one that orders sit in is refused by the FK below.
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_status_code (code),
  KEY ix_status_sort (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A workable default pipeline. A store renames and reorders these; the roles
-- are what the code actually looks for.
INSERT INTO online_order_statuses (code, name, tone, sort_order, role) VALUES
  ('new',       'New',       'brand',   10, 'new'),
  ('accepted',  'Accepted',  'brand',   20, ''),
  ('preparing', 'Preparing', 'warning', 30, ''),
  ('ready',     'Ready',     'success', 40, ''),
  ('dispatched','Out for delivery', 'warning', 50, 'dispatched'),
  ('completed', 'Completed', 'success', 60, 'completed'),
  ('cancelled', 'Cancelled', 'danger',  70, 'cancelled')
ON DUPLICATE KEY UPDATE code = code;

-- ── Orders ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS online_orders (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_number      VARCHAR(32)  NOT NULL,
  status_id         INT UNSIGNED NOT NULL,
  fulfilment        ENUM('collect','deliver') NOT NULL DEFAULT 'collect',

  -- The sale this order became, once accepted. NULL until then — that is
  -- exactly what distinguishes a request from a transaction.
  document_id       INT UNSIGNED NULL,

  -- NULL for a guest. Snapshots below carry what the shopper typed, so a
  -- guest order is complete without inventing a debtor account.
  customer_id       INT UNSIGNED NULL,
  contact_name      VARCHAR(160) NOT NULL DEFAULT '',
  contact_phone     VARCHAR(40)  NOT NULL DEFAULT '',
  contact_email     VARCHAR(190) NOT NULL DEFAULT '',

  -- The ORDER's delivery address, not the customer's statement address: the
  -- latter is free text meant for printing and has nothing routable in it.
  delivery_line1    VARCHAR(190) NOT NULL DEFAULT '',
  delivery_line2    VARCHAR(190) NOT NULL DEFAULT '',
  delivery_suburb   VARCHAR(120) NOT NULL DEFAULT '',
  delivery_postcode VARCHAR(20)  NOT NULL DEFAULT '',
  delivery_notes    VARCHAR(500) NOT NULL DEFAULT '',
  delivery_fee_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  zone_id           INT UNSIGNED NULL,

  -- What the shopper was shown, summed from the lines as submitted. Stored
  -- rather than derived so a later re-price cannot restate what was agreed.
  total_incl        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  requested_for     DATETIME     NULL,
  customer_note     VARCHAR(500) NOT NULL DEFAULT '',
  decline_reason    VARCHAR(190) NOT NULL DEFAULT '',

  -- Housekeeping, NOT a status. A status answers "where has this got to";
  -- archiving answers "am I still looking at it". Folding them together would
  -- lose the first answer the moment a shop tidied up.
  is_archived       TINYINT(1)   NOT NULL DEFAULT 0,
  archived_at       DATETIME     NULL,

  placed_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_online_order_number (order_number),
  -- The queue: unarchived orders by status, newest first.
  KEY ix_online_order_queue (is_archived, status_id, placed_at),
  KEY ix_online_order_customer (customer_id, placed_at),
  KEY ix_online_order_document (document_id),
  -- RESTRICT: a status with orders in it must not be deletable. Retire it with
  -- is_active instead, which keeps those orders readable.
  CONSTRAINT fk_online_order_status
    FOREIGN KEY (status_id) REFERENCES online_order_statuses (id) ON DELETE RESTRICT,
  CONSTRAINT fk_online_order_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_online_order_document
    FOREIGN KEY (document_id) REFERENCES sales_documents (id) ON DELETE SET NULL,
  CONSTRAINT fk_online_order_zone
    FOREIGN KEY (zone_id) REFERENCES online_delivery_zones (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Order lines ──────────────────────────────────────────────────────────
-- The basket AS SUBMITTED. Snapshots everything for the same reason
-- sales_document_lines does: this is a record of what was asked for at the
-- price shown, not a live view of the product file.
CREATE TABLE IF NOT EXISTS online_order_lines (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id        INT UNSIGNED NOT NULL,
  line_number     SMALLINT UNSIGNED NOT NULL DEFAULT 0,

  -- SET NULL, like a sales line: a product archived after the order was placed
  -- must leave the order readable.
  product_id      INT UNSIGNED NULL,
  product_code    VARCHAR(48)  NULL,
  description     VARCHAR(190) NOT NULL,

  qty             DECIMAL(12,3) NOT NULL DEFAULT 0.000,
  -- The STOREFRONT price at submission — not necessarily what the sale is
  -- eventually written at.
  unit_price_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_total_incl DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  line_note       VARCHAR(190) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  KEY ix_online_line_order (order_id, line_number),
  CONSTRAINT fk_online_line_order
    FOREIGN KEY (order_id) REFERENCES online_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_online_line_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Deferred to here because online_order_statuses does not exist above.
ALTER TABLE online_store_settings
  ADD CONSTRAINT fk_online_paid_status
    FOREIGN KEY (paid_status_id) REFERENCES online_order_statuses (id) ON DELETE SET NULL;
