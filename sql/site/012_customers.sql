-- Customers — the debtors book.
--
-- "Customer" on screen, "debtor" in accounting; the same record either way.
-- A customer is anyone you sell to; the credit fields only matter for the ones
-- you sell to ON ACCOUNT, and a walk-in never gets a row here at all (a cash
-- sale carries a name snapshot on the document instead, so the debtors book
-- stays a list of real accounts rather than a dumping ground).
--
-- Money is DECIMAL(12,4) per 001_products.sql.

-- ── Groups ─────────────────────────────────────────────────────────────
-- A group is a pricing-and-terms bucket: "Trade", "Staff", "Schools". It gets
-- its own table rather than a free-text column because it carries DEFAULTS a
-- new account inherits — which is behaviour, and behaviour needs columns.
CREATE TABLE customer_groups (
  id                 INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name               VARCHAR(120) NOT NULL,
  code               VARCHAR(32)  NULL,

  -- Applied to a new customer in this group. Each is a starting point the
  -- account can then override, never a live lookup — changing a group's terms
  -- must not silently restate what existing accounts already agreed.
  default_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  default_credit_limit DECIMAL(12,4) NOT NULL DEFAULT 0.0000,
  -- Which price structure this group buys at. SET NULL on delete: losing the
  -- structure must not delete the group.
  price_structure_id INT UNSIGNED NULL,

  sort_order         INT          NOT NULL DEFAULT 0,
  is_active          TINYINT(1)   NOT NULL DEFAULT 1,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_group_name (name),
  KEY ix_customer_group_active (is_active, sort_order),
  CONSTRAINT fk_cgroup_structure FOREIGN KEY (price_structure_id)
    REFERENCES price_structures (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Sales reps ─────────────────────────────────────────────────────────
-- A rep is a PERSON: a name, an email that statements copy in, a commission
-- rate. That is why this is not a generic lookup table — a lookup row cannot
-- hold an email address.
--
-- Deliberately not cp2_users: a rep is often not a system user at all, and a
-- user in the control database may cover several sites.
CREATE TABLE sales_reps (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name           VARCHAR(120) NOT NULL,
  code           VARCHAR(32)  NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40)  NULL,
  commission_pct DECIMAL(6,3) NOT NULL DEFAULT 0.000,
  is_active      TINYINT(1)   NOT NULL DEFAULT 1,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_sales_rep_name (name),
  KEY ix_sales_rep_active (is_active, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Customers ──────────────────────────────────────────────────────────
CREATE TABLE customers (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code           VARCHAR(32)  NOT NULL,
  name           VARCHAR(160) NOT NULL,

  -- One ENUM rather than is_active + on_hold. Two booleans describe four
  -- states, but only three are meaningful and the fourth (inactive AND on
  -- hold) is nonsense the schema would still permit — leaving every filter to
  -- decide what an impossible row means.
  --
  --   active   — sell on credit, sell for cash, statement it.
  --   on_hold  — a LIVE account with a temporary block. Still statemented,
  --              still aged, still chased. A credit decision, not a lifecycle
  --              stage.
  --   inactive — dormant. Hidden from pickers and the default age analysis,
  --              but intact and reactivatable. Lifecycle, not credit.
  --   closed   — finished with, balance settled, kept for history only.
  --
  -- WHEN and WHY a status changed lives in activity_log, so nothing is lost by
  -- collapsing the booleans.
  status         ENUM('active','on_hold','inactive','closed') NOT NULL DEFAULT 'active',
  -- Shown next to a non-active badge so counter staff see the reason without
  -- opening the audit log.
  status_reason  VARCHAR(190) NULL,

  -- May transact, but never on account. Different from on_hold: a cash-only
  -- account was never granted credit, a held one had it withdrawn.
  is_cash_only   TINYINT(1)   NOT NULL DEFAULT 0,

  contact_name   VARCHAR(120) NULL,
  email          VARCHAR(190) NULL,
  phone          VARCHAR(40)  NULL,
  address_line1  VARCHAR(190) NULL,
  address_line2  VARCHAR(190) NULL,
  city           VARCHAR(120) NULL,
  postal_code    VARCHAR(20)  NULL,
  vat_number     VARCHAR(40)  NULL,
  loyalty_number VARCHAR(60)  NULL,

  group_id       INT UNSIGNED NULL,
  rep_id         INT UNSIGNED NULL,
  -- A free-text slice — "Region", "Industry", whatever this store sorts by.
  -- Indexed text with a DISTINCT picker rather than a third lookup table: a
  -- field with no behaviour attached does not earn one. Promote it if it ever
  -- grows some.
  category       VARCHAR(60)  NULL,

  -- Days from invoice date to due date. 0 means cash on delivery.
  payment_terms_days SMALLINT UNSIGNED NOT NULL DEFAULT 30,

  -- Zero means "no credit granted", NOT "unlimited". Every over-limit check
  -- depends on reading it that way.
  credit_limit   DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Positive = the customer owes us.
  --
  -- Denormalised on purpose. The debtors list is the screen this module exists
  -- for: it shows fifty accounts a page with a balance and an over-limit badge
  -- on each, and it sorts and filters by balance. A read-time SUM over the
  -- ledger would make ORDER BY balance and WHERE balance > credit_limit
  -- unindexable, and the till needs "is this account over its limit" in
  -- single-digit milliseconds.
  --
  -- NOTHING may write this except a ledger posting, inside the same
  -- transaction as the row that moves it — see customerLedger.ts once the
  -- sub-ledger lands. updateCustomer() deliberately omits it from its column
  -- list. reconcileBalances() proves it still agrees with the ledger.
  balance        DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  notes          TEXT         NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_code (code),
  KEY ix_customer_name (name),
  KEY ix_customer_status (status, name),
  KEY ix_customer_group (group_id),
  KEY ix_customer_rep (rep_id),
  KEY ix_customer_category (category),
  KEY ix_customer_loyalty (loyalty_number),
  -- The over-limit and outstanding-balance filters on the list screen.
  KEY ix_customer_balance (balance),
  -- SET NULL, not RESTRICT: deleting a group or a rep should orphan the
  -- accounts, not refuse. Losing a rep is a routine staff change; being unable
  -- to remove them until 300 accounts are reassigned is not.
  CONSTRAINT fk_customer_group FOREIGN KEY (group_id) REFERENCES customer_groups (id) ON DELETE SET NULL,
  CONSTRAINT fk_customer_rep   FOREIGN KEY (rep_id)   REFERENCES sales_reps (id)      ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
