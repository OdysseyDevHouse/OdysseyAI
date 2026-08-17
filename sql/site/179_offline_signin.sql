-- Signing in to the back office with no control database.
--
-- ── WHY THIS IS NEEDED AT ALL ───────────────────────────────────────────────
--
-- Every password read in src/lib/auth.ts targets cp2_users, in the CONTROL
-- database. 041_users_roles.sql says so in as many words about this site's own
-- users table: "the password lives upstream and is verified there", and the
-- only credential it carries is pin_hash, which is a till PIN.
--
-- On a cloud install that is exactly right. On a LOCAL backend it means a shop
-- with a dead line cannot open its own back office - the stock, the prices and
-- the customers are all sitting on the machine in front of them, and nobody can
-- get in to look at any of it. A local backend that dies with the internet is
-- not a local backend.
--
-- ── WHY NOT COPY THE BCRYPT HASH DOWN ───────────────────────────────────────
--
-- It would be one column and no new code, and it was rejected for the same
-- reason offlinePin.ts rejects it for PINs. A bcrypt hash at cost 10 is
-- offline-attackable by anyone who reaches this database, and unlike a PIN a
-- back-office password is very often reused - so cracking one here yields an
-- email account, not merely a till.
--
-- Worse, it would put OUR hash on a customer's own machine, where the customer
-- is the person we are protecting the takings from.
--
-- ── WHAT IS STORED INSTEAD ──────────────────────────────────────────────────
--
--     verifier = PBKDF2-SHA256(
--                  password = the password as typed,
--                  salt     = HMAC-SHA256(OFFLINE_PIN_KEY, site|user|'backoffice'),
--                  iters    = as recorded in the row )
--
-- The same construction offlinePin.ts uses, and the same three properties:
-- the salt is an HMAC under a server secret that never reaches this machine, so
-- a dumped table cannot even be attacked; it is bound to this site and user;
-- and the cost is deliberate.
--
-- The material difference from a PIN is the search space. A four-digit PIN has
-- ten thousand candidates, so the iteration count is doing all the work. A
-- password does not, which is why a verifier here is meaningfully stronger than
-- a PIN verifier at the same cost - and why the iteration count is stored per
-- row rather than assumed, so it can be raised later without invalidating
-- anybody's existing sign-in.
--
-- ── THE PROPERTY THAT MAKES THIS SAFE TO SHIP ───────────────────────────────
--
-- A verifier is only ever written after a SUCCESSFUL ONLINE SIGN-IN. There is
-- no path that mints one from a password the control database has not just
-- accepted. So a user who has never signed in on this machine cannot sign in
-- offline, ever - which is the correct behaviour and not a limitation: the
-- alternative is a machine that grants access on a credential nobody upstream
-- has confirmed.

CREATE TABLE IF NOT EXISTS offline_signin (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- The SITE user this belongs to. Not the control user: everything else in
  -- this database keys on the local row, and joining through control_user_id
  -- every time would invite somebody to key one of them on the wrong id.
  user_id INT UNSIGNED NOT NULL,

  -- PBKDF2 output, base64. Not a password and not reversible.
  verifier VARCHAR(64) NOT NULL,

  -- Recorded per row so the cost can be raised for new sign-ins without
  -- locking out everyone whose verifier was minted at the old figure. Exactly
  -- the reasoning in offlinePin.ts, and the reason that file's count could be
  -- raised from 600k to 2.4M without a migration.
  iterations INT UNSIGNED NOT NULL,

  -- When this was last confirmed by a real, successful ONLINE sign-in.
  --
  -- The reason it exists: a password changed in the control panel while this
  -- machine was offline leaves a verifier here that still accepts the OLD
  -- password. That window has to be bounded, and it has to be visible - so the
  -- age is recorded and the sign-in path refuses a verifier that has gone
  -- stale, rather than trusting it indefinitely.
  confirmed_at DATETIME NOT NULL,

  -- Failed offline attempts, and the lockout they earn.
  --
  -- In the DATABASE rather than in IndexedDB, unlike the till's PIN lockout.
  -- That lockout is explicitly documented as clearable with DevTools and is a
  -- guard against a person guessing at a counter. This one guards a password
  -- against somebody sitting at the machine all evening, so it lives where the
  -- person at the keyboard cannot reach it.
  failed_attempts INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One verifier per user: a second row would be a second password, and which
  -- one wins would depend on read order.
  UNIQUE KEY uq_offline_signin_user (user_id),
  CONSTRAINT fk_offline_signin_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
