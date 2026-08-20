-- ============================================================================
-- 014_mobile_devices.sql — a phone that stays signed in
-- ============================================================================
--
-- The mobile app is a native shell around the same web pages, and its whole
-- premise is that the user signs in ONCE. A twelve-hour JWT cannot carry that:
-- a manager who checks the dashboard every morning would meet a login form
-- inside a WebView every morning, which is the thing that makes a wrapper feel
-- like a browser with a nicer icon.
--
-- So the phone holds a long-lived REFRESH TOKEN — kept in the iOS Keychain or
-- the Android Keystore, behind the device's own biometric — and exchanges it
-- for a fresh session on each cold start. This table is the server's half of
-- that exchange: one row per enrolled device, and the only thing that can turn
-- a lost phone back into a stranger.
--
-- ── WHY NOT cp2_devices ─────────────────────────────────────────────────────
--
-- cp2_devices is where a POS licence is SOLD, and it belongs to the v2 backend:
-- Odyssey reads entitlement from it and writes a serial into a spot that was
-- provisioned elsewhere, but it never creates rows. A phone is not a till, is
-- not licensed per seat, and must not consume one — so it gets its own table,
-- named `odyssey_` like every other table this codebase owns outright.
--
-- ── THE TOKEN IS HASHED, LIKE A PASSWORD ────────────────────────────────────
--
-- Because that is what it is. Anyone holding the plaintext is signed in as this
-- user until the row is revoked, so a stolen database backup must not hand over
-- a working credential for every phone in the estate.
--
-- SHA-256 rather than bcrypt, and the difference from a password matters: this
-- is 32 bytes of CSPRNG output, not something a human chose. There is no
-- dictionary to run against it and nothing to slow an attacker down FOR, so a
-- deliberately expensive KDF would only make every app launch slower. The
-- lookup is a constant-time compare on the digest.
--
-- ── NO FOREIGN KEY ON user_id, DELIBERATELY ─────────────────────────────────
--
-- The same rule cp2_signin_log (003) and cp2_user_sessions (006) follow, for
-- the same reason: cp2_users belongs to the v2 backend and a user purge there
-- must not fail on rows it knows nothing about. A stale row here cannot admit
-- anybody — the exchange re-reads the user and the site link on every call, so
-- a deleted user's phone gets refused on the strength of that, not on the
-- presence of this row.
--
-- ── WHY THIS IS A HISTORY AND cp2_user_sessions IS NOT ──────────────────────
--
-- 006 is keyed on user_id because "one live session per user" IS its schema.
-- This table is deliberately the opposite shape: a person may hold a phone and
-- a tablet, and the whole point of enrolling a device is that the OTHER one
-- keeps working. Revoking is a row-level act here, which is what "I have lost
-- my phone" actually means.
--
-- Note what that implies and is meant to: a mobile session is minted with NO
-- `sid` claim, so it is not enrolled in 006's registry and never evicts the
-- desktop. See the field's own comment in src/lib/session.ts — the till's PIN
-- unlock takes the same exit for the same reason. A manager on the shop floor
-- must not sign themselves out of the desk they left.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
--
-- No site_id. A device belongs to a PERSON, not a store: the same phone follows
-- a multi-store manager between branches, and the site is chosen per session
-- from the user's real access at exchange time. Pinning a store here would mean
-- re-enrolling to look at a different one.
--
-- No push token. It will be needed, and it belongs to whichever device row it
-- arrives from — but nothing sends a notification yet, and a column nothing
-- writes is a column nobody maintains.

CREATE TABLE IF NOT EXISTS odyssey_mobile_devices (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,

  -- cp2_users.id. No FK, per the note above.
  user_id       INT UNSIGNED NOT NULL,

  -- SHA-256 of the refresh token, hex. UNIQUE so a presented token resolves in
  -- one indexed lookup rather than a scan-and-compare over every live device,
  -- and so the same token can never be enrolled twice.
  token_hash    CHAR(64)     NOT NULL,

  -- 'ios' | 'android'. Free text rather than an ENUM: this is shown to a human
  -- deciding which row to revoke, and a third platform must not need a schema
  -- change to be listed.
  platform      VARCHAR(16)  NOT NULL,

  -- What the user will recognise in the revoke list — "Tiaan's iPhone". Chosen
  -- by the app from the device's own name, so two phones are tellable apart by
  -- the person who owns both.
  label         VARCHAR(120) NOT NULL,

  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Touched on each exchange, so a device silent for months is visibly the safe
  -- one to revoke. Not throttled the way 006's is: this is written once per app
  -- cold start, not once per guarded request.
  last_seen_at  DATETIME     NULL,

  -- NULL means live. Set rather than deleted, so "when did we cut that phone
  -- off?" survives the act of cutting it off.
  revoked_at    DATETIME     NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_mobile_token (token_hash),

  -- The revoke list: one user's devices, newest first.
  KEY idx_mobile_user (user_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
