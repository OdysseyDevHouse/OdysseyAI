-- The AI credits wallet: what a shop has bought, and what its AI calls spent.
--
-- ── WHY A WALLET AND NOT A MODULE ──────────────────────────────────────────
--
-- Every other paid thing on this platform is a subscription: the shop holds the
-- module or it does not, and the bill is the same each month. AI is not that.
-- One shop scans four hundred supplier invoices a month and another scans none,
-- and both cost us real money per call — Anthropic bills per token, to Odyssey's
-- own account, whoever ran it.
--
-- A module cannot express that. A wallet can: money in, usage out, and a
-- balance that says whether the next call may run. It sits alongside the
-- subscription rather than inside it.
--
-- ── THE BILLING ACCOUNT IS THE WALLET, NOT THE SITE ────────────────────────
--
-- Keyed on cp2_billing_accounts, the same entity cp2_billing_subscriptions
-- keys on, for the same reason migration 008 gave: an account is WHO PAYS, and
-- a wallet is money. A store group (cp2_store_groups) is who shares product
-- data, which is a different question with a different answer — an operator can
-- own two unrelated shops on one debit order, and a franchise can share a
-- product file across stores that each pay their own way.
--
-- The previous system keyed its wallet on the franchise group because that was
-- the only grouping it had. Here the right one exists, so the balance follows
-- the bill. Every site on an account draws from one balance, and site_id on a
-- usage row records which of them spent it.
--
-- ── MICRO-US-DOLLARS, AND WHY NOT CENTS ────────────────────────────────────
--
-- amount_micros is signed MICRO-USD: 1 USD = 1,000,000. Two decisions in one
-- column.
--
-- USD because Anthropic bills us in USD wherever the shop trades, so the real
-- cost of a call is currency-blind. The customer's currency
-- (cp2_billing_accounts.currency) is applied at the edges — converting a
-- top-up into credit, and formatting a balance for a screen — and never in
-- between, so no arithmetic here depends on an exchange rate.
--
-- MICRO rather than cents because these calls are cheap. A short report
-- question costs a fraction of a US cent; in cents it would round to zero and
-- be free, and a thousand free calls is a real bill nobody was charged for.
--
-- ── THE BALANCE IS DERIVED, NEVER STORED ───────────────────────────────────
--
-- There is no balance column anywhere. The balance is
-- SUM(amount_micros) WHERE account_id = ?, and that is the point: a stored
-- number has to be read, modified and written, and two AI calls finishing at
-- the same moment would each read the same number and each write their own
-- total back, losing one debit. Rows only ever INSERT, so concurrency costs
-- nothing and the history is the balance rather than a log beside it.
--
-- Apply by hand. sql/tickets/ has no runner — see
-- scripts/check-pending-migrations.mjs.

-- ── Every wallet event ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cp2_ai_credit_ledger (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id     INT UNSIGNED NOT NULL,

  -- Signed. Positive puts money in (topup, manual), negative takes it out
  -- (usage). Signing the amount rather than pairing a magnitude with a
  -- direction column means the balance is one SUM with nothing to get wrong,
  -- and a row that contradicts its own entry_type is not expressible.
  amount_micros  BIGINT NOT NULL,

  -- topup      a confirmed PayFast payment
  -- usage      one metered AI call
  -- manual     credited by hand — an EFT, a goodwill gesture, a refund
  -- adjustment a correction, which is why it is not 'manual'
  entry_type     ENUM('topup','usage','manual','adjustment') NOT NULL,

  -- ── top-up rows ─────────────────────────────────────────────────────────
  -- Our reference from cp2_ai_topup_pending, kept so a credit can be traced
  -- back to the checkout that bought it. NOT unique: it is a breadcrumb, and
  -- the key below is what actually guards a replay.
  reference      CHAR(36) NULL,

  -- ── usage rows ──────────────────────────────────────────────────────────
  -- doc_scan | ask_report. Deliberately not an ENUM: a new AI feature should
  -- be a deploy, not an ALTER on a database shared with the v2 backend.
  feature        VARCHAR(32) NULL,
  -- WHICH store spent it. The balance belongs to the account; this is how the
  -- owner of a four-store group sees where the money went.
  site_id        INT UNSIGNED NULL,
  -- Who ran it. NULL when nobody was standing there — a scheduled report.
  user_id        INT UNSIGNED NULL,

  -- What was charged for, kept because the price of a model changes and a
  -- historical debit has to stay explicable afterwards. Not used in any sum.
  model          VARCHAR(60) NULL,
  input_tokens   INT UNSIGNED NULL,
  output_tokens  INT UNSIGNED NULL,
  cache_tokens   INT UNSIGNED NULL,

  -- Why, for the rows a person created: "EFT ref 4471", "goodwill, ticket 88".
  -- Nothing reads it; support does.
  note           VARCHAR(255) NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The balance query and the history screen are the same shape.
  KEY ix_acl_account (account_id, created_at),
  KEY ix_acl_reference (reference),

  CONSTRAINT fk_acl_account FOREIGN KEY (account_id)
    REFERENCES cp2_billing_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Money that has not arrived yet ─────────────────────────────────────────
--
-- ── WHY IN-FLIGHT TOP-UPS ARE NOT IN THE LEDGER ────────────────────────────
--
-- A shop clicks R500 and is sent to PayFast. It may pay, or close the tab, or
-- have the card declined. Until PayFast's notification says otherwise, nothing
-- has happened — and a row in the ledger, of any kind, is money in the balance.
--
-- So a checkout starts here, and reaches the ledger only when the ITN confirms
-- it. An abandoned checkout leaves a 'pending' row that ages quietly and never
-- counts. This mirrors cp2_billing_subscriptions, which is 'pending' from the
-- moment of checkout until a notification makes it 'active'.
--
-- ── THE UNIQUE KEY ON pf_payment_id IS THE IDEMPOTENCY ─────────────────────
--
-- PayFast retries a notification it did not see acknowledged, so the same
-- payment arrives more than once as a matter of routine. Two deliveries
-- checking "have I credited this already?" in application code can both read
-- "no" and both credit — the guard has to be inside InnoDB, at the moment of
-- write.
--
-- It lives HERE and not on the ledger because it is NOT NULL here. On the
-- ledger it would have to be nullable, since usage rows have no payment, and a
-- UNIQUE index does not constrain NULL in MariaDB — every usage row would
-- satisfy it and the guard would silently protect nothing. The ledger credit is
-- written in the same transaction that stamps this column, so this key protects
-- both.
CREATE TABLE IF NOT EXISTS cp2_ai_topup_pending (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id     INT UNSIGNED NOT NULL,

  -- Our reference, sent as m_payment_id and echoed back on the notification.
  -- A fresh UUID per attempt, so an abandoned checkout can never be settled by
  -- a later one.
  reference      CHAR(36) NOT NULL,

  -- The credit to grant on success, in the wallet's own unit. Fixed at
  -- checkout from the amount actually charged, so a rate that moves afterwards
  -- cannot change what was bought.
  amount_micros  BIGINT NOT NULL,

  -- What the shop is charged, in the account's currency. Recorded to check the
  -- notification against — a payload that vouches for its own amount vouches
  -- for nothing — and afterwards it is the audit trail.
  amount_pay     DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  pay_currency   CHAR(3) NOT NULL DEFAULT 'ZAR',

  -- Which store's screen started it. Not who pays — that is account_id — but
  -- support's first question is always "where were you when you clicked it".
  site_id        INT UNSIGNED NULL,

  status         ENUM('pending','complete','failed') NOT NULL DEFAULT 'pending',

  -- PayFast's id for the payment. NULL while pending; NOT NULL is impossible
  -- here because the row exists before the payment does. The unique key
  -- tolerates the NULLs of unsettled rows and constrains every settled one,
  -- which is exactly the guard needed: a replay carries an id already present.
  pf_payment_id  VARCHAR(64) NULL,

  -- The whole urlencoded body of the notification that settled it. This is the
  -- evidence when a shop says "I paid and I got nothing".
  raw_payload    MEDIUMTEXT NULL,

  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                   ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_atp_reference (reference),
  UNIQUE KEY uq_atp_pf_payment (pf_payment_id),
  KEY ix_atp_account (account_id, created_at),

  CONSTRAINT fk_atp_account FOREIGN KEY (account_id)
    REFERENCES cp2_billing_accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
