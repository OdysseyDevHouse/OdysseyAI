import 'server-only'
import type { RowDataPacket } from 'mysql2'
import { query, queryOne, transaction } from '@/lib/db'
import * as portal from './devicesPortal'

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

  /* ── OVER HTTPS WHERE THIS MACHINE CAN ─────────────────────────────────
   *
   * Null means "not configured, or the portal could not answer", and the query
   * below runs exactly as it always has. See devicesPortal.ts for the three
   * cases that produce it and the one that deliberately does not. Every
   * function in this file follows the same two lines. */
  const viaPortal = await portal.licenceForSerial(trimmed)
  if (viaPortal) return viaPortal

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
  const viaPortal = await portal.freeSpots(siteId)
  if (viaPortal) return viaPortal

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
  const viaPortal = await portal.billableDeviceCount(siteId)
  if (viaPortal !== null) return viaPortal

  const rows = await query<Row>(`${SELECT_DEVICE} WHERE site_id = ?`, [siteId])
  return rows.filter((r) => entitlement(r).ok).length
}

/** Every licence row for the site, claimed or not — for the setup screen. */
export async function listLicences(siteId: number): Promise<LicenceSpot[]> {
  const viaPortal = await portal.listLicences(siteId)
  if (viaPortal) return viaPortal

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

  const viaPortal = await portal.claimSpot(deviceRowId, trimmed, label, terminalId)
  if (viaPortal) return viaPortal

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
  if (await portal.releaseSpot(deviceRowId)) return

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
    if (await portal.touchDevice(deviceRowId)) return
    await transaction(async (tx) => {
      await tx.execute('UPDATE cp2_devices SET last_seen_at = NOW() WHERE id = ?', [deviceRowId])
    })
  } catch {
    // A heartbeat is not worth failing a sale over.
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   SELF-REGISTRATION AT THE DOOR

   Everything above this line reads the register. Everything below it can write
   to it, which is the exception to the rule stated at the top of this file, and
   it is worth being precise about how narrow the exception is.

   A machine standing at the refusal screen may take exactly one of two things,
   and neither of them is a licence the shop has not got:

     · A PAID SLOT it is already billed for. `takePaidSlot` refuses the moment
       the count of live paid rows reaches what the shop ordered, so pressing the
       button can never make the bill go up.
     · A TRIAL, once per machine per store, recorded in `cp2_device_trials` so
       that a tidy-up in the register cannot hand out a second one.

   What is still impossible from here: marking a row paid, extending an expiry,
   or raising the ordered count. Those remain Odyssey's, and a shop that wants
   more tills still has to buy them.
   ─────────────────────────────────────────────────────────────────────────── */

/** How long an evaluation lasts. One number, read by the offer and the writer. */
export const TRIAL_DAYS = 30

/**
 * Today, and today plus n days, as ISO dates on the APP server's clock.
 *
 * Deliberately not CURDATE(): `entitlement()` above compares expiry against the
 * app server's date, so a trial dated by the database's clock could be written
 * one day long or one day short of the rule that will judge it.
 */
function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
function isoInDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * What this shop pays for, and how much of it is spoken for.
 *
 * ── WHICH NUMBER IS THE ENTITLEMENT ─────────────────────────────────────────
 *
 * `cp2_site_device_orders.requested` — the order this app's billing screen took,
 * not `cp2_sites.paid_device_count`. They are kept in step by `provisionDevices`
 * writing the first onto the second, and 020 re-seeded the first from the second
 * once to settle the disagreement 009 left behind. Reading the order row is what
 * makes "how many may I have" and "what am I billed for" the same question; see
 * sql/tickets/020_device_trials.sql for why the direction is that way round.
 *
 * `inUse` counts only PAID rows. A live trial is deliberately outside the cap —
 * it is not billed, so counting it would let a trial eat a slot the shop bought.
 */
export type PaidSlots = {
  /** Till licences this shop is billed for. Zero is legal. */
  paidFor: number
  /** Live paid licences, claimed or waiting for a machine. */
  inUse: number
  /** How many more paid licences this shop may put into service. */
  free: number
}

export async function paidSlots(siteId: number): Promise<PaidSlots> {
  const viaPortal = await portal.paidSlots(siteId)
  if (viaPortal) return viaPortal

  const [order, rows] = await Promise.all([
    queryOne<Row>('SELECT requested FROM cp2_site_device_orders WHERE site_id = ?', [siteId]),
    query<Row>(`${SELECT_DEVICE} WHERE site_id = ? AND status = 'active' AND is_paid = 1`, [siteId]),
  ])
  /* No order row means no site row was seeded — a site created outside both this
     app and migration 020. Zero, not one: inventing an entitlement is the one
     mistake here that costs the shop nothing and Odyssey a licence. */
  const paidFor = order ? Number(order.requested) : 0
  const inUse = rows.length
  return { paidFor, inUse, free: Math.max(0, paidFor - inUse) }
}

/** Has this machine already had its thirty days in this store? */
export async function trialTaken(
  siteId: number,
  serial: string,
): Promise<{ endsOn: string } | null> {
  const trimmed = serial.trim()
  if (!trimmed) return null
  const row = await queryOne<Row>(
    'SELECT ends_on FROM cp2_device_trials WHERE site_id = ? AND serial_number = ?',
    [siteId, trimmed],
  )
  return row ? { endsOn: String(row.ends_on).slice(0, 10) } : null
}

/**
 * What the refusal screen may offer this machine, if anything.
 *
 * ── ONE ANSWER, NOT A ROW OF BUTTONS ────────────────────────────────────────
 *
 * The screen shows at most one action, and this decides which. A paid slot beats
 * a trial whenever one is free, because the shop has already paid for it and
 * spending thirty free days first only moves the same conversation a month
 * later. The trial is the fallback for the shop that has nothing to claim.
 *
 * The `none` cases each name a DIFFERENT thing that is wrong, because they need
 * different sentences: a machine that has used its trial has to be sold a
 * licence, and a machine with no device id cannot be registered by anybody.
 */
export type DeviceOffer =
  /** A licence this shop is billed for is free. Taking it costs nothing more. */
  | { kind: 'paid'; free: number }
  /** Nothing paid is free, and this machine has never evaluated. */
  | { kind: 'trial'; days: number }
  /** Nothing left to offer this machine. */
  | { kind: 'none'; reason: 'trial-used' | 'no-serial'; paidFor: number }

export async function deviceOffer(siteId: number, serial: string | null): Promise<DeviceOffer> {
  const viaPortal = await portal.deviceOffer(serial)
  if (viaPortal) return viaPortal

  const trimmed = serial?.trim() ?? ''
  /* A browser with storage blocked has no identity to register. It is allowed to
     TRADE (see PosEntry) but it cannot hold a licence, because the row would
     have nothing in its serial to match on the next load. */
  if (!trimmed) return { kind: 'none', reason: 'no-serial', paidFor: 0 }

  const slots = await paidSlots(siteId)
  if (slots.free > 0) return { kind: 'paid', free: slots.free }

  const used = await trialTaken(siteId, trimmed)
  if (used) return { kind: 'none', reason: 'trial-used', paidFor: slots.paidFor }

  /* At the paid limit AND never trialled still offers the trial, deliberately. A
     shop with two paid tills in service that wants to evaluate a third should be
     able to, and the trial row sits outside the paid cap precisely so it can. */
  return { kind: 'trial', days: TRIAL_DAYS }
}

export type SelfRegisterResult =
  | { ok: true; deviceRowId: number; trialEndsOn: string | null }
  | { ok: false; error: string }

/**
 * Put this machine into a licence the shop already pays for.
 *
 * Prefers an UNCLAIMED existing row over creating one — that is the spot Odyssey
 * pre-provisioned, and creating a second row beside it would leave the shop with
 * one more licence than it ordered and an orphan nobody can explain.
 *
 * The cap is re-read under a lock rather than trusted from `deviceOffer`, which
 * ran before the button was pressed: two tills opened at once on the last free
 * slot would both have been offered it, and only one may have it.
 */
export async function takePaidSlot(
  siteId: number,
  serial: string,
  label: string,
  terminalId: number | null,
): Promise<SelfRegisterResult> {
  const trimmed = serial.trim()
  if (!trimmed) return { ok: false, error: 'This machine has no identifier to register.' }

  const viaPortal = await portal.selfRegister('paid', trimmed, label, terminalId)
  if (viaPortal) return viaPortal

  return transaction(async (tx) => {
    /* The order row is the lock as well as the number. Every site has one after
       migration 020, and taking it FOR UPDATE serialises every machine asking
       this store the same question. */
    const [orderRows] = await tx.execute(
      'SELECT requested FROM cp2_site_device_orders WHERE site_id = ? FOR UPDATE',
      [siteId],
    )
    const paidFor = Number((orderRows as Row[])[0]?.requested ?? 0)

    /* ── THE ROW THIS MACHINE IS ALREADY IN ─────────────────────────────────
       Almost always a LAPSED one: the thirty days ran out, and the shop has
       since bought licences. It still holds the serial, and `serial_number` is
       unique, so it would block the paid slot — which is the exact moment the
       user came here to fix, refused.

       So a DEAD row is stood down and the machine moves across. That is the
       "switch this machine onto a licence we pay for" this screen exists to
       offer, and it is safe because a row that fails `entitlement()` cannot
       trade anyway: nothing is being taken away.

       A LIVE row is a different matter and is still refused. Moving a machine
       off a licence that works would change which invoice sequence it numbers
       from, silently, mid-trade. Unlinking is a supervisor's deliberate act in
       Setup → Tills, and it stays that way.

       The till itself is untouched either way. `terminals.device_id` still names
       this machine, so `resolveTerminal` finds the same till afterwards and its
       invoice numbering carries straight on. */
    const [heldRows] = await tx.execute(
      `${SELECT_DEVICE} WHERE site_id = ? AND serial_number = ? LIMIT 1`,
      [siteId, trimmed],
    )
    const held = (heldRows as Row[])[0]
    if (held) {
      if (entitlement(held).ok) {
        return { ok: false as const, error: 'This machine is already registered in this store.' }
      }
      await tx.execute(
        `UPDATE cp2_devices
            SET serial_number = NULL, status = 'inactive', updated_at = NOW()
          WHERE id = ?`,
        [held.id],
      )
    }

    const [liveRows] = await tx.execute(
      `SELECT id, serial_number FROM cp2_devices
        WHERE site_id = ? AND status = 'active' AND is_paid = 1
        ORDER BY serial_number IS NULL DESC, id`,
      [siteId],
    )
    const live = liveRows as Row[]
    const spare = live.find((r) => !r.serial_number)

    if (spare) {
      await tx.execute(
        `UPDATE cp2_devices
            SET serial_number = ?, device_type = COALESCE(device_type, ?),
                terminal_id = ?, last_seen_at = NOW(), updated_at = NOW()
          WHERE id = ?`,
        [trimmed, label.slice(0, 60) || null, terminalId, spare.id],
      )
      return { ok: true as const, deviceRowId: Number(spare.id), trialEndsOn: null }
    }

    if (live.length >= paidFor) {
      return {
        ok: false as const,
        error:
          paidFor === 0
            ? 'This shop has no till licences to use.'
            : `All ${paidFor} till licences are in use. Free one under Setup → Tills first.`,
      }
    }

    const [result] = await tx.execute(
      `INSERT INTO cp2_devices
         (site_id, device_name, serial_number, device_type, terminal_id, status, is_paid, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'active', 1, NOW())`,
      [siteId, `Till ${live.length + 1}`, trimmed, label.slice(0, 60) || null, terminalId],
    )
    return {
      ok: true as const,
      deviceRowId: Number((result as unknown as { insertId: number }).insertId),
      trialEndsOn: null,
    }
  })
}

/**
 * Give this machine thirty days.
 *
 * Writes the licence and the record of the offer in ONE transaction. If they
 * could be written separately, a failure between them leaves either a trial
 * nobody can prove was taken — so the machine takes another next week — or a
 * record with no licence, which locks a shop out of the trial it never got.
 *
 * The row is an ordinary unpaid licence with a future expiry. Nothing about it
 * is special-cased downstream: `entitlement()` lets it trade, stops it the day
 * after `expiry_date`, and the refusal it then produces is `expired`.
 */
export async function startTrial(
  siteId: number,
  serial: string,
  label: string,
  terminalId: number | null,
  startedBy: string | null,
): Promise<SelfRegisterResult> {
  const trimmed = serial.trim()
  if (!trimmed) return { ok: false, error: 'This machine has no identifier to register.' }

  const viaPortal = await portal.selfRegister('trial', trimmed, label, terminalId, startedBy)
  if (viaPortal) return viaPortal

  const startedOn = isoToday()
  const endsOn = isoInDays(TRIAL_DAYS)

  return transaction(async (tx) => {
    /* The trial record is claimed FIRST, and its primary key is the race
       protection: two windows on one machine pressing the button together, and
       the second one waits here and then finds the row. */
    const [prior] = await tx.execute(
      'SELECT ends_on FROM cp2_device_trials WHERE site_id = ? AND serial_number = ? FOR UPDATE',
      [siteId, trimmed],
    )
    if ((prior as Row[])[0]) {
      return {
        ok: false as const,
        error: 'This machine has already had its free trial in this store.',
      }
    }

    const [held] = await tx.execute(
      'SELECT id FROM cp2_devices WHERE site_id = ? AND serial_number = ? LIMIT 1',
      [siteId, trimmed],
    )
    if ((held as Row[])[0]) {
      return { ok: false as const, error: 'This machine is already registered in this store.' }
    }

    const [result] = await tx.execute(
      `INSERT INTO cp2_devices
         (site_id, device_name, serial_number, device_type, terminal_id, status, is_paid,
          expiry_date, notes, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, NOW())`,
      [
        siteId,
        label.slice(0, 60) || 'Trial till',
        trimmed,
        label.slice(0, 60) || null,
        terminalId,
        endsOn,
        `${TRIAL_DAYS}-day evaluation started ${startedOn}`,
      ],
    )
    const deviceRowId = Number((result as unknown as { insertId: number }).insertId)

    await tx.execute(
      `INSERT INTO cp2_device_trials
         (site_id, serial_number, device_id, started_on, ends_on, started_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [siteId, trimmed, deviceRowId, startedOn, endsOn, startedBy?.slice(0, 120) ?? null],
    )

    return { ok: true as const, deviceRowId, trialEndsOn: endsOn }
  })
}
