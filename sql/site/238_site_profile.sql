-- The site profile: who this shop IS, kept where the shop can read it.
--
-- ── THE FAILURE THIS CLOSES ─────────────────────────────────────────────────
--
-- An adopted local install holds every byte of its own trading data on the
-- machine in the office: stock, prices, customers, staff, permissions, the
-- day's takings. It signs in with a name and a PIN against its own `users`
-- table and never asks the control panel who anybody is.
--
-- And then it cannot open a single screen without internet, because
-- requireSite() reads cp2_sites — over the wire — to find out what the shop is
-- CALLED. Every authenticated page calls it, twice per render, and there are
-- around 250 call sites that lead to it. A shop with a dead line can sign in
-- and then watch a stock screen made entirely of local data fail on a TCP
-- timeout.
--
-- That is the whole of it. Not permissions, not entitlements, not the licence —
-- all three of those already have local answers. The company name.
--
-- ── WHY A MIRROR AND NOT A MOVE ─────────────────────────────────────────────
--
-- cp2_sites stays the authority, and deliberately. Support changes an address
-- or a VAT number in the control panel, and that has to keep working without
-- anybody visiting the shop. This is a COPY of the last answer, not a second
-- place where the truth might live.
--
-- Which means the copy can be stale, and the design has to be honest about
-- that: `mirrored_at` records when it was last confirmed. It is refreshed on
-- every successful read — not merely at sign-in — so on a machine with a line
-- it is never more than one page load old. On a machine without one it is as
-- old as the outage, which is exactly the right answer to give.
--
-- ── WHY IT LIVES HERE, BESIDE licence_lease ─────────────────────────────────
--
-- Same reasoning as 178, and the same shape: a singleton row in the SITE
-- database, written whenever the control panel answers, read when it cannot.
-- 178 did this for the modules the shop holds. This is the other half, and the
-- two are read by the same request for the same reason.
--
-- It is NOT in the control database for the obvious reason and NOT in the
-- config file for a less obvious one: a server component has to read it on
-- every request, and re-reading a DPAPI-sealed file per request to answer
-- "what is this shop called" is worse than one indexed single-row select.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
--
-- The membership half — site_role, is_default — which lives in cp2_user_sites
-- and belongs to a PERSON rather than to this machine. getSite() already
-- returns them as NULL and 1 for a local install, because a machine that serves
-- one shop has no "which of your stores" question to answer. Mirroring them
-- would invent an answer to a question nobody is asking.
--
-- Nothing about billing, licensing or device registration is mirrored either.
-- Those genuinely need the control panel and are online-only features by
-- design; a local copy of them would be a licence nobody can withdraw.
CREATE TABLE IF NOT EXISTS site_profile (
  -- Singleton, exactly like licence_lease. One database serves one shop, so a
  -- second row would mean this database had been restored somewhere it should
  -- not be — and the CHECK below makes that impossible rather than merely
  -- unlikely.
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,

  -- Which shop this database belongs to. Verified against ODYSSEY_SITE_ID
  -- before the mirror is trusted, the same way resolveOfflineSite() verifies
  -- the lease — so a database restored onto the wrong machine cannot present
  -- itself as a different shop.
  site_id INT NOT NULL,

  site_code           VARCHAR(64)  NOT NULL,
  company_name        VARCHAR(255) NOT NULL,
  trading_name        VARCHAR(255) NULL,
  registration_number VARCHAR(64)  NULL,
  vat_number          VARCHAR(64)  NULL,

  address1    VARCHAR(255) NULL,
  address2    VARCHAR(255) NULL,
  address3    VARCHAR(255) NULL,
  postal_code VARCHAR(32)  NULL,

  phone        VARCHAR(64)  NULL,
  email        VARCHAR(255) NULL,
  contact_name VARCHAR(255) NULL,

  -- cloud | local | hybrid. Mirrored because tabRouting reads it to decide
  -- whether a tab lives on the shop's box or in the cloud, and because the back
  -- office EXE refuses to open a cloud store at all.
  connection_type VARCHAR(16) NOT NULL DEFAULT 'cloud',

  -- What KIND of shop. The till's sign-in screen picks its background from it,
  -- and that screen stands between a cashier and the till at 07:00.
  site_type_id INT NULL,

  is_paid TINYINT(1)  NOT NULL DEFAULT 0,
  status  VARCHAR(16) NOT NULL DEFAULT 'active',

  -- When the control panel last confirmed all of the above. The column that
  -- makes a stale copy legible rather than silent.
  mirrored_at DATETIME NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  CONSTRAINT site_profile_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
