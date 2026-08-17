-- The debit order behind a billing account, and every collection against it.
--
-- ── TWO PAYFAST CONCERNS, DELIBERATELY KEPT APART ──────────────────────────
--
-- This app already talks to PayFast for a DIFFERENT purpose: a tenant shop
-- collecting from its own shoppers, with that shop's own credentials, stored
-- encrypted in the shop's own database (see src/lib/site/payments.ts).
--
-- What is here is the other direction — Odyssey collecting from its tenants,
-- with ONE set of platform credentials that live in the environment and never
-- in any database. The two must never resolve each other's callbacks, which is
-- why they have separate tables, separate routes, and separate token
-- audiences. A shopper's R80 order settling against a platform subscription
-- would be the worst bug this feature could have.
--
-- ── NOTE ON THE SHARED DATABASE ────────────────────────────────────────────
--
-- odyssey_tickets is shared with the v2 backend. Both tables here are new and
-- cp2_-prefixed. In particular cp2_billing_accounts.gateway / gateway_ref —
-- reserved in migration 008 before the gateway was chosen — are deliberately
-- LEFT ALONE and stay NULL forever: two nullable strings cannot express a
-- status, an amount, an anniversary and an in-flight attempt, and 008 said as
-- much at the time. They are not dropped, because dropping a column in a
-- shared database is exactly what these migrations must never do.

-- ── The mandate ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cp2_billing_subscriptions (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id         INT UNSIGNED NOT NULL,

  -- PayFast's id for the mandate. NULL until the FIRST notification brings it.
  -- Every management call — pause, cancel, change the amount — is keyed on it.
  pf_token           CHAR(36) NULL,

  -- Our reference on the CURRENT checkout attempt, a fresh UUID each time.
  -- The first notification has no pf_token yet, so this is the only thing that
  -- can correlate it back to an account.
  m_payment_id       CHAR(36) NULL,

  status             ENUM('none','pending','active','past_due','paused','cancelled')
                       NOT NULL DEFAULT 'none',

  -- What we instructed PayFast to collect, VAT-inclusive. Read from here when
  -- checking a notification, never from the notification's own payload — a
  -- payload that vouches for its own amount vouches for nothing.
  amount_incl        DECIMAL(10,2) NOT NULL DEFAULT 0.00,

  -- The amount on the attempt currently in flight, so a notification for a
  -- superseded attempt cannot settle at a price nobody agreed. Cleared on
  -- activation.
  pending_amount     DECIMAL(10,2) NULL,
  pending_started_at DATETIME NULL,

  currency           CHAR(3) NOT NULL DEFAULT 'ZAR',
  billing_date       DATE NULL,
  next_billing_on    DATE NULL,
  last_paid_on       DATE NULL,

  -- When the local amount was last successfully pushed to PayFast. NULL means
  -- "they may still be collecting the old figure" — the reconciliation sweep
  -- looks for exactly that rather than the two silently drifting.
  synced_at          DATETIME NULL,

  -- ── Annual escalation ───────────────────────────────────────────────────
  -- Off by default. A feature that quietly starts raising prices the day it
  -- deploys is not acceptable, so somebody has to set a percent per account.
  escalation_percent DECIMAL(5,2) NOT NULL DEFAULT 0.00,
  -- The day the mandate first went live; the escalation anniversary.
  anniversary_on     DATE NULL,
  -- YEAR() of this is the idempotency guard. Running the job twice in a year
  -- must escalate nobody the second time — compounding an increase by accident
  -- is a real overcharge, not a rounding error.
  last_escalated_on  DATE NULL,

  cancelled_at       DATETIME NULL,
  cancel_reason      VARCHAR(190) NULL,

  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                       ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),

  -- ONE mandate per account, as a constraint rather than a convention. An
  -- upgrade that opened a second subscription would leave the customer with
  -- two debit orders, and nothing about the screens would look wrong.
  UNIQUE KEY uq_bs_account (account_id),
  -- Two accounts cannot share a mandate. MySQL allows repeated NULLs in a
  -- unique index, which is what lets "not activated yet" be expressible.
  UNIQUE KEY uq_bs_pf_token (pf_token),
  -- The first notification's only lookup path, so make it a point read.
  UNIQUE KEY uq_bs_mpid (m_payment_id),
  KEY ix_bs_escalation (status, anniversary_on),

  CONSTRAINT fk_bs_account FOREIGN KEY (account_id)
    REFERENCES cp2_billing_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Every collection, and the thing that makes a replay free ───────────────
--
-- ── WHY THE UNIQUE KEY IS THE WHOLE IDEMPOTENCY STORY ──────────────────────
--
-- The store-payment path guards a replay with `UPDATE ... WHERE status =
-- 'pending'`, which works because an order settles exactly once. A
-- SUBSCRIPTION settles every month: its status is 'active' before and after a
-- renewal, so a status guard is structurally unavailable here.
--
-- The only thing separating collection #7 from a replay of collection #7 is
-- PayFast's own payment id. Making that UNIQUE puts the guard inside InnoDB at
-- the moment of insert — not in application logic that two concurrent
-- deliveries could both pass on their way to double-crediting.
--
-- The previous system got this wrong for subscriptions (a blind UPDATE that
-- re-stamped the payment date and pushed the next billing date forward another
-- month on every replay) while getting it right for AI credits. This is the
-- AI-credits shape.
CREATE TABLE IF NOT EXISTS cp2_billing_payments (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id      INT UNSIGNED NOT NULL,
  subscription_id INT UNSIGNED NULL,

  -- NOT NULL on purpose. A payload without one cannot be keyed, so it is
  -- refused before it reaches this table — a nullable column would let
  -- unlimited NULLs through the unique index and defeat the entire guard.
  pf_payment_id   VARCHAR(64) NOT NULL,

  -- Echoed on later collections too, but not uniquely, so it is a breadcrumb
  -- and never a key.
  m_payment_id    CHAR(36) NULL,
  pf_token        CHAR(36) NULL,

  amount_gross    DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  amount_fee      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  amount_net      DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  currency        CHAR(3) NOT NULL DEFAULT 'ZAR',

  -- Verbatim from PayFast: COMPLETE | FAILED | PENDING | CANCELLED.
  payment_status  VARCHAR(20) NOT NULL,
  -- Whether OUR verification passed. A row can say COMPLETE and still be
  -- rejected — a forged payload claims whatever it likes.
  verified        TINYINT(1) NOT NULL DEFAULT 0,
  reject_reason   VARCHAR(190) NULL,

  billing_date    DATE NULL,

  -- The whole urlencoded body, kept because this is the evidence when somebody
  -- says "I paid and nothing happened". Logs rotate; rows do not.
  raw_payload     MEDIUMTEXT NULL,
  source_ip       VARCHAR(45) NULL,

  received_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_bp_pf_payment (pf_payment_id),
  KEY ix_bp_account (account_id, received_at),
  KEY ix_bp_token (pf_token, received_at),

  CONSTRAINT fk_bp_account FOREIGN KEY (account_id)
    REFERENCES cp2_billing_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A dormant row for every account that already exists, so the checkout path
-- only ever UPDATEs under a lock and never has to create-or-update in a race.
INSERT INTO cp2_billing_subscriptions (account_id, status)
SELECT a.id, 'none'
  FROM cp2_billing_accounts a
 WHERE NOT EXISTS (
   SELECT 1 FROM cp2_billing_subscriptions s WHERE s.account_id = a.id
 );
