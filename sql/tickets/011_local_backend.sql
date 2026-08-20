-- ============================================================================
-- 011_local_backend.sql — a site whose database lives in the shop
-- ============================================================================
--
-- Until now every Odyssey site has kept its trading data on a server we run.
-- The desktop shell is only a window onto that: Electron boots the same Next
-- build and opens the same MySQL connection, so a shop with no internet has no
-- till, no back office and no stock file.
--
-- A LOCAL backend inverts that. MariaDB ships inside the installer, the site
-- database is created on the customer's own machine at first run, and the shop
-- trades whether or not the line is up. The control panel keeps exactly two
-- jobs: saying who may sign in, and saying what the shop has paid for.
--
-- ── WHAT THIS MIGRATION IS FOR ──────────────────────────────────────────────
--
-- Three facts have nowhere to live today:
--
--   1. The generated root password for the shop's own MariaDB. The customer
--      must never learn it — if they can reach the database directly they can
--      edit their own takings — but support must be able to, or a machine
--      needing recovery is a machine needing a reinstall.
--   2. The shared secret behind the offline unlock code, so a locked machine
--      with no internet can still be released over the telephone.
--   3. A record of every unlock granted, because a scheme that hands out
--      access without verifying anything can only be kept honest by being
--      visible afterwards.
--
-- ── WHY A NEW TABLE AND NOT COLUMNS ON cp2_devices ──────────────────────────
--
-- 005 altered cp2_devices, which the v2 backend owns, and said plainly that it
-- was an exception taken with the owner's agreement. Nothing here has that
-- agreement, and none of it needs it: this is all new, Odyssey-only state, so
-- it goes in Odyssey-only tables and v2 never sees a schema it did not expect.
--
-- cp2_sites.connection_type already carries 'cloud' | 'local' | 'hybrid' and is
-- read in src/lib/sites.ts. It is currently displayed and never acted upon.
-- That column stays the switch — this migration adds the state a 'local' site
-- needs, not another flag deciding the same thing.
--
-- (It was named backoffice_type, 'windows' | 'cloud', when this ran. The column
-- was renamed and widened later; the tables below are unaffected.)

-- ── The shop's own database, as the control panel knows it ──────────────────
--
-- One row per site that runs a local backend. A cloud site never gets a row,
-- and the absence IS the answer: no row means nothing was ever provisioned on
-- a customer's machine, which is a different and safer statement than a row
-- full of nulls.
CREATE TABLE IF NOT EXISTS cp2_local_backends (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id INT NOT NULL,

  -- The machine this backend runs on, matching cp2_devices.serial_number. A
  -- site could in principle have a second machine hosting a second local
  -- database (a shop that split its counter), so this is not unique on site.
  device_serial VARCHAR(190) NOT NULL,

  -- ── The escrowed credential ──────────────────────────────────────────────
  --
  -- Generated ON THE MACHINE at first run, then sent here. Deliberately that
  -- way round: the installer must be able to bring a database up with no
  -- network at all, so the machine cannot wait to be told its password. It
  -- makes one, starts, and escrows at first contact.
  --
  -- Encrypted with the enc:v1 envelope in src/lib/crypto/secrets.ts — the same
  -- scheme as cp2_site_databases.db_password_enc, and reversible for the same
  -- reason: a password nobody can read back is not an escrow.
  db_password_enc TEXT NULL,

  -- Where that database listens, for support to reproduce a connection. Not
  -- 3306: a bundled server on a customer's desktop must not fight whatever
  -- else they have installed, so the installer picks a high port and records
  -- it here.
  db_port INT UNSIGNED NULL,
  db_name VARCHAR(190) NULL,

  -- ── The offline unlock secret ────────────────────────────────────────────
  --
  -- 32 random bytes, base64, generated here and handed to the machine at first
  -- contact. Both sides keep it; neither ever transmits it again. The unlock
  -- code is an HMAC over (secret, challenge), so a support agent can compute a
  -- response the machine will accept without either end being online together.
  --
  -- Encrypted at rest: a leaked control database would otherwise let anyone
  -- mint an unlock for any machine.
  unlock_secret_enc TEXT NULL,

  -- ── Escrow provenance ────────────────────────────────────────────────────
  --
  -- When the machine last confirmed these values. A row whose escrow is months
  -- stale against a machine that has been trading is a machine that reinstalled
  -- without re-escrowing, and support should know before promising a password.
  escrowed_at DATETIME NULL,

  -- The lease this site was last granted, mirrored from the machine's own
  -- licence_lease row. Lets the control panel show "this machine has been
  -- offline for 9 days" without waiting for the customer to ring.
  last_seen_at DATETIME NULL,
  lease_expires_at DATETIME NULL,

  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- One backend per machine per site. The machine re-escrows on every
  -- reinstall, and that must UPDATE the row rather than accumulate a history
  -- of passwords support has to choose between.
  UNIQUE KEY uq_cp2_local_backends_site_serial (site_id, device_serial),
  KEY ix_cp2_local_backends_site (site_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── Every unlock ever granted ───────────────────────────────────────────────
--
-- The honest limitation of an offline unlock is that it grants access without
-- verifying anything over the wire. A support agent who wants to can keep a
-- non-paying shop trading indefinitely, a fortnight at a time, and no
-- cryptography can prevent it — the whole premise is working without a
-- connection.
--
-- So this table is the control that DOES work: not prevention, accountability.
-- Every code issued is one row naming the supervisor, the site, the machine and
-- the moment. A site appearing here four times running is a business
-- conversation, and it is one somebody can actually find.
CREATE TABLE IF NOT EXISTS cp2_unlock_grants (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id INT NOT NULL,
  device_serial VARCHAR(190) NULL,

  -- The code the customer read out, and the one read back. Both stored: a
  -- dispute about what was said on the phone is settled by the pair, and a
  -- challenge that does not match any issued code is a sign somebody is
  -- guessing at the algorithm.
  challenge VARCHAR(64) NOT NULL,
  response VARCHAR(64) NOT NULL,

  -- The counter value this code was minted against. Redeeming increments the
  -- machine's counter, so a second code for the same counter means the first
  -- never landed — the customer misheard, or rang twice.
  unlock_counter INT NOT NULL,

  -- How long it bought, so "we granted 14 days on the 3rd" needs no arithmetic.
  granted_days INT NOT NULL,

  -- cp2_users.id of whoever issued it. Not a foreign key: cp2_users belongs to
  -- the v2 backend, and 005's note about terminal_id applies the same way — a
  -- constraint across an ownership boundary is a constraint somebody else can
  -- break without knowing we existed.
  granted_by INT NULL,
  reason VARCHAR(255) NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY ix_cp2_unlock_grants_site (site_id, created_at),
  KEY ix_cp2_unlock_grants_serial (device_serial, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
