import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { query, queryOne, transaction } from '@/lib/db'

/**
 * POS device licensing.
 *
 * ── WHAT A LICENCE IS ───────────────────────────────────────────────────────
 *
 * One row in `cp2_devices` — the control database's device register, shared with
 * the v2 backend, which is where a licence is SOLD. Odyssey only ever reads
 * entitlement from it and writes the serial when a spot is claimed; it never
 * creates rows. That is the whole enforcement model: a shop can only trade from
 * as many tills as were provisioned for it, because neither the desktop app nor
 * a browser can provision one for itself.
 *
 * ── WHY THE RULE LIVES HERE AND NOT AT THE CALL SITES ───────────────────────
 *
 * "Registered, active, and either paid or inside its trial" reads as three
 * conditions but is one question, asked from the till gate, from the sale path
 * and from setup. Three copies would be three chances for one of them to answer
 * `true` where the others say `false` — and the copy that drifts is always the
 * one guarding the money.
 *
 * ── THE TRIAL FALLS OUT OF THE SAME RULE ────────────────────────────────────
 *
 * A shop can be sold two tills and given a third on evaluation. That is not a
 * special case in the code: the trial row is simply `is_paid = 0` with a future
 * `expiry_date`, so it trades until the day it lapses and then stops. No
 * separate trial flag, no separate branch, no way for one to be updated without
 * the other.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Why a device may not trade. Each maps to a sentence the till can show. */
export type LicenceRefusal =
  /** No row carries this serial. A desktop till that was never provisioned. */
  | 'unregistered'
  /** Registered, but retired or returned in the back office. */
  | 'inactive'
  /** Never paid for, and no trial period was set. */
  | 'unpaid'
  /** Paid trial or licence has run out. */
  | 'expired'

export type DeviceLicence =
  | {
      ok: true
      /** `cp2_devices.id` — the licence row, not the terminal. */
      deviceRowId: number
      /** The site terminal this licence drives, if one has been bound. */
      terminalId: number | null
      /** What to call it in support: "Front counter", "Till 2". */
      name: string
      /** Set while an unpaid device is inside its evaluation period. */
      trialEndsOn: string | null
    }
  | { ok: false; reason: LicenceRefusal }

/**
 * A licence row as the setup screen lists it.
 *
 * `serial` null means the spot is PRE-PROVISIONED and unclaimed — a paid licence
 * with no machine in it yet, which is exactly what a browser is allowed to take.
 */
export type LicenceSpot = {
  deviceRowId: number
  name: string
  serial: string | null
  terminalId: number | null
  isPaid: boolean
  expiryDate: string | null
  status: string
  lastSeenAt: Date | null
}

const SELECT_DEVICE = `
  SELECT id, site_id, device_name, serial_number, terminal_id, status,
         is_paid, expiry_date, last_seen_at
    FROM cp2_devices`

/**
 * Is this row entitled to trade today?
 *
 * Date comparison in SQL rather than JavaScript would be one fewer round trip,
 * but it would also compare against the DATABASE's clock while every other date
 * in this app is the app server's. A licence that expires an hour early because
 * two machines disagree about midnight is a support call nobody can reproduce.
 */
function entitlement(row: Row): { ok: true; trialEndsOn: string | null } | { ok: false; reason: LicenceRefusal } {
  if (String(row.status) !== 'active') return { ok: false, reason: 'inactive' }

  const paid = Number(row.is_paid) === 1
  const expiry = row.expiry_date ? String(row.expiry_date).slice(0, 10) : null

  if (paid) return { ok: true, trialEndsOn: null }

  // Unpaid: only an unexpired evaluation period keeps it trading.
  if (!expiry) return { ok: false, reason: 'unpaid' }

  const todayIso = new Date().toISOString().slice(0, 10)
  // Inclusive: a licence dated today has not run out until today is over.
  if (expiry < todayIso) return { ok: false, reason: 'expired' }

  return { ok: true, trialEndsOn: expiry }
}

/**
 * The licence for one machine.
 *
 * Scoped by site as well as serial, and the site half is load-bearing: one
 * machine may hold a licence in each store it works, so a serial identifies a
 * row only together with the store asking. The pair is what `cp2_devices` is
 * unique on.
 *
 * That also keeps the property the site scope was originally added for — a
 * device registered to one shop must not resolve while somebody is signed in to
 * another, which is the store's licence being spent by a different store.
 */
export async function licenceForSerial(siteId: number, serial: string): Promise<DeviceLicence> {
  const trimmed = serial.trim()
  if (!trimmed) return { ok: false, reason: 'unregistered' }

  const row = await queryOne<Row>(
    `${SELECT_DEVICE} WHERE site_id = ? AND serial_number = ? LIMIT 1`,
    [siteId, trimmed],
  )
  if (!row) return { ok: false, reason: 'unregistered' }

  const verdict = entitlement(row)
  if (!verdict.ok) return verdict

  return {
    ok: true,
    deviceRowId: Number(row.id),
    terminalId: row.terminal_id ? Number(row.terminal_id) : null,
    name: String(row.device_name ?? ''),
    trialEndsOn: verdict.trialEndsOn,
  }
}

/**
 * Licences this site holds that no machine has claimed yet.
 *
 * Only ENTITLED ones: offering a browser a spot that is expired or unpaid would
 * let it claim its way into a refusal, which is a worse experience than being
 * told plainly that there is nothing free.
 */
export async function freeSpots(siteId: number): Promise<LicenceSpot[]> {
  const rows = await query<Row>(
    `${SELECT_DEVICE}
      WHERE site_id = ? AND serial_number IS NULL
      ORDER BY device_name, id`,
    [siteId],
  )
  return rows.filter((r) => entitlement(r).ok).map(toSpot)
}

/**
 * How many till licences this site is billed for.
 *
 * ── ONE NUMBER, NOT TWO ─────────────────────────────────────────────────────
 *
 * This counts the SAME rows, through the SAME `entitlement()` predicate, that
 * decide whether a till may trade. There is deliberately no stored "billed
 * device count" anywhere: the moment the billed figure and the enforced figure
 * are two separate numbers, they drift, and a shop ends up paying for two tills
 * while trading from five — which is exactly what the previous system did.
 *
 * The consequence worth knowing: the only way to change this number is to
 * provision or retire a licence, which is why the billing screen shows it
 * read-only and links to the tills screen rather than offering a stepper.
 */
export async function billableDeviceCount(siteId: number): Promise<number> {
  const rows = await query<Row>(`${SELECT_DEVICE} WHERE site_id = ?`, [siteId])
  return rows.filter((r) => entitlement(r).ok).length
}

/** Every licence row for the site, claimed or not — for the setup screen. */
export async function listLicences(siteId: number): Promise<LicenceSpot[]> {
  const rows = await query<Row>(`${SELECT_DEVICE} WHERE site_id = ? ORDER BY device_name, id`, [
    siteId,
  ])
  return rows.map(toSpot)
}

function toSpot(r: Row): LicenceSpot {
  return {
    deviceRowId: Number(r.id),
    name: String(r.device_name ?? ''),
    serial: (r.serial_number as string | null) ?? null,
    terminalId: r.terminal_id ? Number(r.terminal_id) : null,
    isPaid: Number(r.is_paid) === 1,
    expiryDate: r.expiry_date ? String(r.expiry_date).slice(0, 10) : null,
    status: String(r.status ?? ''),
    lastSeenAt: (r.last_seen_at as Date | null) ?? null,
  }
}

export type ClaimResult =
  | { ok: true; deviceRowId: number; terminalId: number | null }
  | { ok: false; error: string }

/**
 * Bind this machine to a free licence.
 *
 * ── WHY A TRANSACTION AND A RE-CHECK ────────────────────────────────────────
 *
 * Two browsers opened at once on the last free spot would both see it free and
 * both try to take it. The row is re-read `FOR UPDATE` inside the transaction,
 * so the second one waits and then finds it gone — and the unique index on
 * `serial_number` is the backstop if a path ever skips this function entirely.
 *
 * Claiming is deliberately NOT idempotent-by-overwrite: a serial already bound
 * to another row is refused rather than moved, because a machine silently
 * changing which licence it holds is how a till's invoice sequence changes
 * underneath it.
 */
export async function claimSpot(
  siteId: number,
  deviceRowId: number,
  serial: string,
  label: string,
  /**
   * The till this machine will ring up as.
   *
   * Set in the SAME act as the licence, deliberately. They were two separate
   * claims once — a licence here and a `terminals.device_id` over in the site
   * database — and a machine could hold one without the other, which meant a
   * licensed till numbering its invoices from the shared shop sequence instead
   * of its own. One action, one outcome: this machine IS that till.
   */
  terminalId?: number | null,
): Promise<ClaimResult> {
  const trimmed = serial.trim()
  if (!trimmed) return { ok: false, error: 'This machine has no identifier to register.' }

  return transaction(async (tx) => {
    /* Scoped to the site, matching the unique index.

       A machine may hold one licence in each store it works — an operator with
       two linked stores runs both from one back-office PC, and each store's
       licence is separately sold and separately paid. What stays forbidden is
       two licences in the SAME store, which is how a shop paying for two tills
       would trade from one browser twice. */
    const [existing] = await tx.execute(
      'SELECT id FROM cp2_devices WHERE site_id = ? AND serial_number = ? LIMIT 1',
      [siteId, trimmed],
    )
    const already = (existing as Row[])[0]
    if (already && Number(already.id) !== deviceRowId) {
      return {
        ok: false as const,
        error: 'This machine is already registered as another till in this store.',
      }
    }

    const [rows] = await tx.execute(
      `${SELECT_DEVICE} WHERE id = ? AND site_id = ? FOR UPDATE`,
      [deviceRowId, siteId],
    )
    const row = (rows as Row[])[0]
    if (!row) return { ok: false as const, error: 'That till licence no longer exists.' }

    // Re-checked under the lock: the spot may have been taken, released or
    // expired between the list being drawn and this confirm being tapped.
    if (row.serial_number && String(row.serial_number) !== trimmed) {
      return { ok: false as const, error: 'Another machine claimed that till first.' }
    }
    const verdict = entitlement(row)
    if (!verdict.ok) {
      return { ok: false as const, error: 'That till licence is not active.' }
    }

    /* `terminalId === undefined` means "leave it alone" — a re-link that is only
       refreshing the serial. An explicit null clears it. */
    const nextTerminal =
      terminalId === undefined ? (row.terminal_id ? Number(row.terminal_id) : null) : terminalId

    await tx.execute(
      `UPDATE cp2_devices
          SET serial_number = ?, device_type = COALESCE(device_type, ?),
              terminal_id = ?, last_seen_at = NOW(), updated_at = NOW()
        WHERE id = ?`,
      [trimmed, label.slice(0, 60) || null, nextTerminal, deviceRowId],
    )

    return { ok: true as const, deviceRowId, terminalId: nextTerminal }
  })
}

/**
 * Hand a licence back, so a replacement machine can take it.
 *
 * The manager's answer to a dead till or a wiped browser profile. Clears the
 * serial only — the licence itself, and whether it is paid, are not Odyssey's to
 * change.
 */
export async function releaseSpot(siteId: number, deviceRowId: number): Promise<void> {
  await transaction(async (tx) => {
    await tx.execute(
      `UPDATE cp2_devices
          SET serial_number = NULL, last_seen_at = NULL, updated_at = NOW()
        WHERE id = ? AND site_id = ?`,
      [deviceRowId, siteId],
    )
  })
}

/**
 * Note that a licensed device is alive.
 *
 * Best-effort and deliberately unawaited by its callers: this is the column a
 * manager reads to decide which spot is safe to release, and a write that failed
 * must never take a till down with it.
 */
export async function touchDevice(deviceRowId: number): Promise<void> {
  try {
    await transaction(async (tx) => {
      await tx.execute('UPDATE cp2_devices SET last_seen_at = NOW() WHERE id = ?', [deviceRowId])
    })
  } catch {
    // A heartbeat is not worth failing a sale over.
  }
}
