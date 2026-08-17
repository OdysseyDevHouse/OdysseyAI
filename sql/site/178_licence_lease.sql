-- The licence lease: what this machine is allowed to do while it cannot ask.
--
-- ── WHY THIS TABLE EXISTS ───────────────────────────────────────────────────
--
-- A desktop install pointed at a LOCAL database can trade with no internet at
-- all. Everything it needs — stock, prices, customers, the till — is on the
-- machine in front of the cashier. That is the point of a local backend.
--
-- The one thing it cannot answer for itself is whether the shop is still
-- paying. Today that question fails OPEN and unbounded: modules.ts hands out
-- every module when the control database cannot be read, and
-- DesktopLicenceGate.tsx does the same for the device licence. Neither records
-- that it happened. A machine unplugged from the internet therefore trades on
-- a licence nobody can withdraw, forever, and the only trace is a console line
-- nobody reads.
--
-- This table is that missing memory. Every successful conversation with the
-- control panel writes one row: what was true, and WHEN it was last confirmed.
-- When the control panel cannot be reached, the app reads the lease instead of
-- guessing — and because the lease carries a timestamp, "cannot be reached"
-- stops being indefinite. Seven days after the last confirmation the machine
-- locks.
--
-- ── WHY IT LIVES IN THE SITE DATABASE ───────────────────────────────────────
--
-- It has to be readable by a SERVER component. Entitlements are read on every
-- request from requireSiteUser(), so the lease must be reachable from the same
-- place. The existing offline machinery in src/lib/posOffline/ is Dexie in the
-- renderer and cannot be read by a server action at all.
--
-- The site database is the only local store the desktop server already has. On
-- a local-backend install it is MariaDB on the same machine; on a cloud-backend
-- install this table simply never gets read, because a machine that can reach
-- its cloud site database can always reach the control panel too.
--
-- ── ONE ROW ─────────────────────────────────────────────────────────────────
--
-- A site database serves exactly one site, so the lease is a singleton. The
-- CHECK pins it to id = 1 rather than trusting every writer to remember: a
-- second row would be a second opinion about when the lease expires, and the
-- lock would then depend on which one a query happened to read first.

CREATE TABLE IF NOT EXISTS licence_lease (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- Whose lease this is. Carried so a database copied to another machine, or
  -- restored into the wrong site, cannot present its lease as that site's.
  site_id INT NOT NULL,

  -- The device this was issued to, matching cp2_devices.serial_number. A lease
  -- is per MACHINE, not per site: one paid till does not license the shop's
  -- other four. Null only for a lease written before a device claimed a spot.
  device_serial VARCHAR(190) NULL,

  -- ── WHAT WAS TRUE AT THE LAST CHECK ──────────────────────────────────────

  -- 'licensed' | 'unregistered' | 'inactive' | 'unpaid' | 'expired', mirroring
  -- LicenceRefusal in src/lib/control/devices.ts plus the success case. Stored
  -- as the string rather than a boolean so the locked screen can say WHICH
  -- refusal it was — "your subscription lapsed" and "this machine is not
  -- registered" send the reader to two different conversations.
  licence_status VARCHAR(32) NOT NULL,

  -- The held module keys as a JSON array, e.g. ["starter","loyalty"]. A JSON
  -- blob rather than a row per module because it is written and read whole,
  -- always together, and never queried across sites.
  modules_json TEXT NOT NULL,

  -- module -> last day, mirroring ModuleEntitlements.endingOn, so an offline
  -- machine still shows the "ends 31 August" chip it showed yesterday.
  ending_on_json TEXT NULL,

  -- Mirrors cp2_billing_accounts.status: trial | active | suspended | closed.
  account_status VARCHAR(32) NULL,

  -- ── THE CLOCK ────────────────────────────────────────────────────────────

  -- The last time the control panel actually answered. THE field: every lock
  -- decision is a comparison against this. Set only on a real, successful
  -- round trip, never on a cached read, or the lease would renew itself.
  checked_at DATETIME NOT NULL,

  -- When the machine locks. Normally checked_at + 7 days, but stored rather
  -- than computed so an offline unlock code can extend it without pretending
  -- a conversation happened that did not. Keeping "when did we last speak"
  -- separate from "how long may this run" is what lets support grant 14 days
  -- while the record still shows the machine has been silent for three weeks.
  expires_at DATETIME NOT NULL,

  -- ── OFFLINE UNLOCK ───────────────────────────────────────────────────────

  -- The shared secret for challenge/response, base64, planted at first contact
  -- while the machine WAS online. The control panel holds the same bytes
  -- against this device. Encrypted at rest with the enc:v1 envelope in
  -- src/lib/crypto/secrets.ts.
  unlock_secret_enc TEXT NULL,

  -- Monotonic count of unlock codes redeemed on this machine. Part of the
  -- challenge, which is what makes a code single-use: redeeming one changes
  -- the next challenge, so replaying the same response cannot work.
  unlock_counter INT NOT NULL DEFAULT 0,

  -- When support last granted an override, for the report that catches a site
  -- phoning in every fortnight instead of paying.
  last_unlock_at DATETIME NULL,

  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT licence_lease_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
