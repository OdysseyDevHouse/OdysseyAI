import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQueryOne, siteExecute } from '@/lib/siteDb'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import type { ModuleKey, AccountStatus } from '@/lib/control/modules'
import type { LicenceRefusal } from '@/lib/control/devices'
import {
  parseModules,
  parseEndingOn,
  leaseExpiryFrom,
  unlockExpiryFrom,
  type Lease,
} from './leaseRules'

/**
 * Reading and writing the licence lease.
 *
 * The RULES live in leaseRules.ts and have no database attached — this file is
 * only the I/O around them. Everything here either fails soft or says plainly
 * why it did not: a lease is a safety net, and a safety net that can throw is
 * one more way for the shop to stop.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * Two places fail open today when the control database cannot be read:
 * `entitlementsForSite()` hands out every module, and DesktopLicenceGate treats
 * the device as licensed. Both are right for a CLOUD install, where the outage
 * lasts seconds and the alternative is a shop watching the back office eat half
 * of itself mid-task.
 *
 * On a LOCAL backend that reasoning stops holding. Being unable to reach the
 * control panel is not a blip there — it is the ordinary state of a machine
 * with no internet, and it lasts forever. Failing open forever is not graceful
 * degradation; it is an unlicensed product that works perfectly.
 *
 * The lease is the missing middle: between "we just checked" and "we have no
 * idea" sits "we checked on Tuesday, and Tuesday was recent enough".
 *
 * ── THE CLOCK IS THE WHOLE IDEA ─────────────────────────────────────────────
 *
 * `checked_at` moves only on a real, successful conversation with the control
 * panel — never on a cached read, a restart, or an unlock. That is what makes
 * the seven days honest: nothing available to the machine locally can renew its
 * own lease.
 */

type Row = RowDataPacket & Record<string, unknown>

export type { Lease } from './leaseRules'
export {
  leaseState,
  daysRemaining,
  daysSinceCheck,
  shouldWarn,
  LEASE_DAYS,
  UNLOCK_GRANT_DAYS,
  type LeaseState,
} from './leaseRules'

/**
 * DATETIME comes back as a driver Date built from a UTC-parsed wall clock — the
 * pool sets timezone 'Z'. Compare it as an instant; never format it with local
 * getters, which would shift every lease by the machine's offset.
 */
function toDate(v: unknown): Date | null {
  if (!v) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}

function rowToLease(row: Row): Lease {
  return {
    siteId: Number(row.site_id),
    deviceSerial: row.device_serial ? String(row.device_serial) : null,
    licenceStatus: String(row.licence_status) as 'licensed' | LicenceRefusal,
    held: parseModules(row.modules_json ? String(row.modules_json) : null),
    endingOn: parseEndingOn(row.ending_on_json ? String(row.ending_on_json) : null),
    accountStatus: row.account_status ? (String(row.account_status) as AccountStatus) : null,
    /* Epoch on a malformed date, which reads as long expired. A lease we cannot
       date is a lease we cannot trust, and the safe direction is locked. */
    checkedAt: toDate(row.checked_at) ?? new Date(0),
    expiresAt: toDate(row.expires_at) ?? new Date(0),
    unlockCounter: Number(row.unlock_counter ?? 0),
    lastUnlockAt: toDate(row.last_unlock_at),
  }
}

/**
 * Read this site's lease.
 *
 * Returns null rather than throwing when the table is absent: a site database
 * that has not run migration 178 is a cloud site, or a local one mid-upgrade,
 * and neither should 500 the back office over a table it never needed. Schema
 * drifts between sites — probing rather than assuming is the house rule.
 */
export async function readLease(siteId: number): Promise<Lease | null> {
  try {
    const row = await siteQueryOne<Row>(siteId, `SELECT * FROM licence_lease WHERE id = 1 LIMIT 1`)
    if (!row) return null
    const lease = rowToLease(row)
    /* A lease belongs to the site it was issued to. A database restored onto
       another site's machine would otherwise present that site's entitlements
       as this one's. */
    if (lease.siteId !== siteId) return null
    return lease
  } catch {
    return null
  }
}

export type LeaseWrite = {
  siteId: number
  deviceSerial: string | null
  licenceStatus: 'licensed' | LicenceRefusal
  held: ReadonlySet<ModuleKey>
  endingOn: ReadonlyMap<ModuleKey, string>
  accountStatus: AccountStatus | null
  /** Planted on first contact only; a later write without one keeps it. */
  unlockSecret?: string
}

/**
 * Record a successful conversation with the control panel.
 *
 * THE ONLY path that moves `checked_at`, and therefore the only path that
 * renews a lease. Call it after a real read of cp2_devices and cp2_site_modules
 * succeeded — never on a cached or degraded result, or the machine would renew
 * itself from its own memory and the seven days would mean nothing.
 *
 * Best-effort: a failure to write must not fail the request that triggered it.
 * A missed write costs a lease that expires slightly earlier than it might
 * have, which is the safe direction to be wrong in.
 */
export async function writeLease(w: LeaseWrite, now: Date = new Date()): Promise<boolean> {
  const secretEnc = w.unlockSecret ? encryptSecret(w.unlockSecret) : null

  try {
    await siteExecute(
      w.siteId,
      `INSERT INTO licence_lease
         (id, site_id, device_serial, licence_status, modules_json, ending_on_json,
          account_status, checked_at, expires_at, unlock_secret_enc)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         site_id = VALUES(site_id),
         device_serial = VALUES(device_serial),
         licence_status = VALUES(licence_status),
         modules_json = VALUES(modules_json),
         ending_on_json = VALUES(ending_on_json),
         account_status = VALUES(account_status),
         checked_at = VALUES(checked_at),
         expires_at = VALUES(expires_at),
         unlock_secret_enc = COALESCE(VALUES(unlock_secret_enc), unlock_secret_enc)`,
      /* COALESCE above keeps a secret already planted: the machine is told its
         unlock secret once, at first contact, and a later check that does not
         carry one must not erase it — that would strand a locked machine with
         no way to be released. */
      [
        w.siteId,
        w.deviceSerial,
        w.licenceStatus,
        JSON.stringify([...w.held]),
        JSON.stringify(Object.fromEntries(w.endingOn)),
        w.accountStatus,
        now,
        leaseExpiryFrom(now),
        secretEnc,
      ],
    )
    return true
  } catch (err) {
    console.error('[lease] could not record the licence check', err)
    return false
  }
}

/** The machine's copy of the unlock secret, or null if none was ever planted. */
export async function leaseUnlockSecret(siteId: number): Promise<string | null> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT unlock_secret_enc FROM licence_lease WHERE id = 1 LIMIT 1`,
    )
    if (!row?.unlock_secret_enc) return null
    return tryDecryptSecret(String(row.unlock_secret_enc))
  } catch {
    return null
  }
}

/**
 * Redeem an unlock: extend the lease, bump the counter, leave checked_at alone.
 *
 * The counter bump is the load-bearing part — it feeds the next challenge, so
 * incrementing it is what makes a code single-use. Doing it in the same UPDATE
 * as the extension leaves no window in which the machine has been extended but
 * would still accept the code again.
 *
 * `checked_at` deliberately does not move: the machine still has not spoken to
 * anyone, and the record should keep saying so.
 */
export async function applyUnlock(
  siteId: number,
  grantDays: number,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const res = await siteExecute(
      siteId,
      `UPDATE licence_lease
          SET expires_at = ?,
              unlock_counter = unlock_counter + 1,
              last_unlock_at = ?
        WHERE id = 1`,
      [unlockExpiryFrom(now, grantDays), now],
    )
    return res.affectedRows > 0
  } catch (err) {
    console.error('[lease] could not apply the unlock', err)
    return false
  }
}
