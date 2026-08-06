-- ─────────────────────────────────────────────────────────────────────────
-- Store payments — a shopper pays THE STORE.
--
-- ── THE MONEY NEVER TOUCHES OUR ACCOUNT ──────────────────────────────────
--
-- Each store connects its OWN payment account, and the shopper pays that
-- account directly. This is the single most important property of the design
-- and it must not be collapsed for convenience.
--
-- Routing store takings through one platform merchant account would make this
-- software a payment aggregator — holding and disbursing third parties' money.
-- That is a regulated activity in South Africa, an unowned reconciliation
-- burden, and a liability nobody asked for. So: per-store credentials, and
-- money that moves shopper → store without passing through us.
--
-- ── CREDENTIALS ARE ENCRYPTED, NOT HASHED ────────────────────────────────
--
-- merchant_key and passphrase are a third party's payment credentials sitting
-- in a database we operate, so they are stored encrypted (AES-256-GCM, via
-- lib/crypto/secrets.ts). Reversible rather than hashed because they must be
-- replayed verbatim when signing a request to the gateway.
--
-- merchant_id is deliberately NOT encrypted: it is a public identifier that
-- appears in the checkout form the shopper's own browser posts. Encrypting it
-- would add cost and no secrecy.
--
-- ── WHY `reference` IS THE CRUX ──────────────────────────────────────────
--
-- It is an opaque id WE generate, send to the gateway, and receive back on the
-- webhook. It is how an inbound callback is resolved to a store BEFORE any
-- verification can happen — and it has to work that way round, because
-- verifying the signature REQUIRES that store's passphrase. The store cannot
-- be established by verifying.
--
-- Resolving by a value we generated ourselves is what keeps that safe: a
-- forged reference matches no row, and a real reference with a bad signature
-- still fails verification afterwards. At no point is caller-asserted identity
-- trusted. Hence UNIQUE.
--
-- ── STATUS IS THE IDEMPOTENCY GUARD ──────────────────────────────────────
--
-- Gateways retry, duplicate and replay. Settlement is therefore written as
-- UPDATE ... WHERE status = 'pending', so a replayed callback affects ZERO
-- rows rather than crediting an order twice. This is the difference between
-- one invoice and two for the same money.
--
-- ── AMOUNT IS RECORDED AT CREATION ───────────────────────────────────────
--
-- So the webhook can be checked against what we EXPECTED, not merely against
-- what the payload claims about itself.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS payment_gateways (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider       VARCHAR(20)  NOT NULL DEFAULT 'payfast',

  is_active      TINYINT(1)   NOT NULL DEFAULT 0,
  -- Sandbox takes play money. It is tracked here, and surfaced loudly on the
  -- Setup screen, because a storefront in test mode accepts orders that look
  -- paid and are not.
  is_sandbox     TINYINT(1)   NOT NULL DEFAULT 1,

  merchant_id    VARCHAR(64)  NOT NULL DEFAULT '',   -- public; see above
  merchant_key   VARCHAR(512) NOT NULL DEFAULT '',   -- encrypted
  passphrase     VARCHAR(512) NOT NULL DEFAULT '',   -- encrypted

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by     VARCHAR(120) NOT NULL DEFAULT '',

  PRIMARY KEY (id),
  -- One account per provider per store. A second row would make "which
  -- credentials sign this request" depend on row order.
  UNIQUE KEY uq_gateway_provider (provider)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_intents (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- Our opaque id. See the note above — this is the whole hinge of the design.
  reference      VARCHAR(64)  NOT NULL,
  provider       VARCHAR(20)  NOT NULL DEFAULT 'payfast',

  -- What is being paid for. `purpose` plus target is what makes this table
  -- reusable: a customer account payment, a lay-by deposit or an invoice
  -- pay-link each become a new purpose and a settlement handler, rather than a
  -- second gateway integration.
  purpose        ENUM('online_order') NOT NULL DEFAULT 'online_order',
  target_id      INT UNSIGNED NOT NULL,

  -- Recorded at creation, and what the callback is checked against.
  amount_incl    DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- pending → paid | failed | cancelled. Only ever leaves 'pending' once.
  status         ENUM('pending','paid','failed','cancelled') NOT NULL DEFAULT 'pending',

  -- The gateway's own id for the payment, once known. For the shop to quote
  -- when querying a payment with its provider.
  provider_ref   VARCHAR(64)  NOT NULL DEFAULT '',
  -- Why a payment failed, for the person who has to explain it to a customer.
  failure_reason VARCHAR(190) NOT NULL DEFAULT '',

  -- The VERIFIED callback body, kept for disputes. When a shopper insists they
  -- paid, the signed evidence has to still exist.
  raw_payload    MEDIUMTEXT   NULL,

  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at     DATETIME     NULL,

  PRIMARY KEY (id),
  -- The lookup a callback performs, and the guarantee a forged reference
  -- cannot collide with a real one.
  UNIQUE KEY uq_intent_reference (reference),
  KEY ix_intent_target (purpose, target_id),
  KEY ix_intent_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which intent paid for an order, and what the shop should believe about it.
--
-- Kept on the order rather than derived from the intents table so the queue
-- can show "paid" without a join per row, and so an order's payment state
-- survives any future change to how intents are stored.
ALTER TABLE online_orders
  ADD COLUMN payment_status ENUM('unpaid','pending','paid') NOT NULL DEFAULT 'unpaid';

ALTER TABLE online_orders
  ADD COLUMN paid_at DATETIME NULL;

-- The tender a settled online payment is banked against.
--
-- Its own tender type, NOT cash and NOT card: the money never went into a
-- drawer and never went through the shop's card machine, so banking it as
-- either would make every cash-up and tender report claim takings that are not
-- there. counts_as_drawer_cash = 0 is the load-bearing flag.
INSERT INTO tender_types
  (code, name, posts_to_debtor, requires_customer, counts_as_drawer_cash,
   opens_cash_drawer, allows_change, allows_split, allows_refund,
   requires_reference, reference_label, rounds_to_cash_denomination,
   position, is_active, is_system)
SELECT 'ONLINE', 'Online payment', 0, 0, 0,
       0, 0, 1, 0,
       0, 'Payment reference', 0,
       90, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM tender_types WHERE code = 'ONLINE');
