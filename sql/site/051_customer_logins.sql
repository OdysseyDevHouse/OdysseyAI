-- Letting an account customer sign in to the online store.
--
-- ── A SEPARATE TABLE, NOT COLUMNS ON `customers` ─────────────────────────
--
-- A customer record is a trading relationship: staff create it, edit it and
-- read it all day. A credential is a secret. Keeping them apart means the
-- hash never appears in a SELECT * that someone writes for a customer list,
-- never lands in an export, and can be revoked without touching the account.
--
-- It also allows a customer with no login at all, which is the common case —
-- most account customers phone their orders in and always will.
--
-- ── ONE LOGIN PER CUSTOMER ──────────────────────────────────────────────
--
-- customer_id is UNIQUE. A business with three buyers shares one login, which
-- is how these shops already work: the account is the entity that owes money,
-- and splitting it per person would imply a permission model the shop has no
-- way to administer.

CREATE TABLE customer_logins (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  customer_id     INT UNSIGNED NOT NULL,

  -- Stored lowercased and trimmed by the application so a lookup is exact.
  -- UNIQUE because it is the identity someone signs in with; two customers
  -- sharing one would make the sign-in ambiguous.
  email           VARCHAR(190) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,

  -- Lockout. Counted per login rather than per IP: a shop's customers may all
  -- sit behind one office address, and locking that IP would shut out the
  -- whole company because one person forgot their password.
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until    DATETIME NULL,

  last_login_at   DATETIME NULL,
  -- Set when staff issue a temporary password, cleared once it is changed.
  must_change     TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,

  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_customer_logins_email (email),
  UNIQUE KEY uq_customer_logins_customer (customer_id),
  CONSTRAINT fk_customer_logins_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- How an online order was to be settled.
--
-- 'account' means the shopper asked to put it on their account and the server
-- agreed at the time. It is a RECORD OF THE REQUEST, not a posting: no balance
-- moves here. The debit happens when staff accept the order and the invoice is
-- written, exactly as it does for a sale rung up at the counter.
ALTER TABLE online_orders
  ADD COLUMN pay_on_account TINYINT(1) NOT NULL DEFAULT 0 AFTER payment_status;
