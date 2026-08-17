-- ============================================================================
-- 013_credential_reveals.sql — who read a customer's database password, and why
-- ============================================================================
--
-- A local-backend shop's database password is generated on the shop's own
-- machine and escrowed here, for exactly one purpose: support recovering a
-- machine that cannot recover itself.
--
-- The customer must never learn it. A shop owner who can reach their own
-- database directly can edit their own takings, and every control that rests on
-- those figures — VAT, stock valuation, commission, the audit trail — quietly
-- stops meaning anything at the same moment.
--
-- ── WHY ITS OWN TABLE AND NOT cp2_unlock_grants ─────────────────────────────
--
-- The first version of this wrote reveals into cp2_unlock_grants with a fake
-- challenge of 'DB-PASSWORD'. It worked, and it was wrong: that table answers
-- "how often has this shop been let off a licence check", and a report counting
-- its rows would have silently started counting password reads too.
--
-- Two different events with two different meanings belong in two tables, or
-- every query against either has to remember which rows to exclude. The one
-- that gets forgotten is the one that matters.
--
-- ── THIS IS ACCOUNTABILITY, NOT A GATE ──────────────────────────────────────
--
-- The reveal is guarded by setup.edit, which is the highest bar this product
-- has — there is no platform-administrator role, so there is nothing stronger
-- to require. That means the real control is this table: every read named,
-- reasoned and timestamped, so a pattern is visible afterwards even though no
-- single read is prevented.
--
-- Stated plainly so nobody mistakes the gate for the protection.

CREATE TABLE IF NOT EXISTS cp2_credential_reveals (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  site_id INT NOT NULL,

  -- Which machine's credential. A site may have more than one local install.
  device_serial VARCHAR(190) NULL,

  -- What was read: 'db_password' today; 'backup_key' and 'root_password' are
  -- the ones that will follow, and naming the kind now means they do not each
  -- need a table of their own.
  credential VARCHAR(40) NOT NULL,

  -- cp2_users.id of whoever read it. Not a foreign key: cp2_users belongs to
  -- the v2 backend, and 005's note about crossing an ownership boundary applies
  -- the same way here.
  revealed_by INT NULL,

  -- Required by the action, not merely encouraged. An entry with no reason
  -- cannot distinguish "support recovered a machine" from "somebody read a
  -- customer's password", which is the entire question this table exists to
  -- answer six months later.
  reason VARCHAR(255) NOT NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The two queries anybody runs: everything for one site, and everything one
  -- person has read lately.
  KEY ix_cp2_credential_reveals_site (site_id, created_at),
  KEY ix_cp2_credential_reveals_by (revealed_by, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
