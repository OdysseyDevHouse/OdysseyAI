import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { siteQueryOne, siteExecute, MASTER, type SitePurpose } from '@/lib/siteDb'
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

/**
 * Which database this site's lease lives in.
 *
 * ── WHY A HYBRID SITE READS ITS LEASE FROM THE BOX ────────────────────────
 *
 * The lease answers "has this shop been offline too long?", so it must be
 * readable WHILE offline. A hybrid till's control database and site database
 * are both in the cloud; the one thing it can reach with the line down is the
 * box in the building. A lease in the cloud would be unreadable in exactly the
 * situation it exists for.
 *
 * ── AND WHY THAT MEANS ONE LEASE PER SITE, NOT TEN ────────────────────────
 *
 * Ten tills each keeping their own would drift: three locking on Tuesday and
 * the rest on Thursday is confusing to support and worse to explain to a
 * customer. The box renews once for the shop and all ten read the same row.
 *
 * Everything else is unchanged. The table is the same `licence_lease` the local
 * backend uses, `checked_at` and `expires_at` stay separate columns, and the
 * telephone unlock works exactly as it does today — an agent unlocks the site,
 * the box holds it, and every till sees it.
 */
async function leasePurpose(siteId: number): Promise<SitePurpose> {
  const { tabsAreLocal, HYBRID } = await import('@/lib/site/tabRouting')
  return (await tabsAreLocal(siteId)) ? HYBRID : MASTER
}

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

    /* ── THE DEVICE'S OWN FACTS, FOR deviceLicenceState ──────────────────────
     *
     * Null-preserving, and that matters: null means "nothing was recorded", not
     * "inactive" or "unpaid". A lease written before a device claimed a spot
     * has all three null, and the evaluator reads that as nothing to enforce
     * rather than as a refusal — see deviceLicenceState.
     *
     * The date is sliced to YYYY-MM-DD rather than passed through toDate. A
     * DATE column comes back as a driver Date at UTC midnight, and formatting
     * it with local getters would move it a day in either direction depending
     * on the machine's offset — which on this column is the difference between
     * a licence that lapses tonight and one that lapsed last night. */
    deviceStatus: row.device_status ? String(row.device_status) : null,
    deviceIsPaid: row.device_is_paid === null || row.device_is_paid === undefined
      ? null
      : Number(row.device_is_paid) === 1,
    deviceExpiryDate: row.device_expiry_date
      ? String(row.device_expiry_date instanceof Date
          ? row.device_expiry_date.toISOString()
          : row.device_expiry_date).slice(0, 10)
      : null,
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
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT * FROM licence_lease WHERE id = 1 LIMIT 1`,
      [],
      await leasePurpose(siteId),
    )
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

  /* ── WHAT THE DEVICE ROW SAID, SO THE MACHINE CAN RE-DECIDE OFFLINE ───────
   *
   * Optional, because two callers write a lease and only one of them knows
   * about devices: modules.ts writes it off the back of an entitlements read,
   * and leaseSubject supplies these. A write that omits them LEAVES THE STORED
   * VALUES ALONE rather than clearing them — see the COALESCE in the SQL —
   * because a machine that could not resolve its device this minute must not
   * thereby forget the expiry date it was told yesterday. */
  deviceStatus?: string | null
  deviceIsPaid?: boolean | null
  /** `YYYY-MM-DD`, as cp2_devices stores it. */
  deviceExpiryDate?: string | null
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
          account_status, checked_at, expires_at, unlock_secret_enc,
          device_status, device_is_paid, device_expiry_date)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         site_id = VALUES(site_id),
         device_serial = VALUES(device_serial),
         licence_status = VALUES(licence_status),
         modules_json = VALUES(modules_json),
         ending_on_json = VALUES(ending_on_json),
         account_status = VALUES(account_status),
         checked_at = VALUES(checked_at),
         expires_at = VALUES(expires_at),
         unlock_secret_enc = COALESCE(VALUES(unlock_secret_enc), unlock_secret_enc),
         device_status = COALESCE(VALUES(device_status), device_status),
         device_is_paid = COALESCE(VALUES(device_is_paid), device_is_paid),
         device_expiry_date = COALESCE(VALUES(device_expiry_date), device_expiry_date)`,
      /* COALESCE above keeps a secret already planted: the machine is told its
         unlock secret once, at first contact, and a later check that does not
         carry one must not erase it — that would strand a locked machine with
         no way to be released.

         The three device columns are COALESCEd for a related but distinct
         reason. modules.ts writes a lease off the back of an entitlements read
         and does not always know the device — a background refresh with no
         request cookie, for instance. Overwriting with NULL there would erase
         the expiry date this machine is meant to enforce OFFLINE, which is
         precisely the state it needs it in. So a write that does not know
         leaves what was known. A device genuinely deregistered comes back as
         status 'inactive', not as an absent value. */
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
        w.deviceStatus ?? null,
        w.deviceIsPaid === null || w.deviceIsPaid === undefined ? null : w.deviceIsPaid ? 1 : 0,
        w.deviceExpiryDate ?? null,
      ],
      await leasePurpose(w.siteId),
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
      [],
      await leasePurpose(siteId),
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
      await leasePurpose(siteId),
    )
    return res.affectedRows > 0
  } catch (err) {
    console.error('[lease] could not apply the unlock', err)
    return false
  }
}
