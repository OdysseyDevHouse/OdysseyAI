import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { logActivity, type Actor } from './activityLog'
import {
  SERIAL_ALLOC_LABEL,
  isAllocatable,
  type SerialAllocState,
} from '../serialStatus'

/**
 * Which individual units are going on a job line (§31).
 *
 * ── WHY ALLOCATION MOVED TO THE VAN ────────────────────────────────────────
 *
 * The serial engine has always been sound, and none of it changes here:
 * `markSold` is still the only thing that consumes a unit, still inside
 * finaliseDocument's transaction, still writing serial_movements.
 *
 * What was missing is WHEN somebody says which unit. Until now the first and
 * only moment was invoice finalisation — an office clerk, days later, choosing
 * between four identical compressors none of which they have seen. The person
 * who knows is the technician holding the box, and they knew it on Tuesday.
 *
 * So this records the intent at fitting time and the invoice inherits it. The
 * unit stays `in_stock` and keeps its location until the invoice posts, because
 * nothing has physically happened yet — a job line naming a serial is a plan,
 * not a movement.
 *
 * ── THE SIX STATES ARE THE WHOLE POINT ─────────────────────────────────────
 *
 * `checkSellable` in serials.ts answers one question with one string, which is
 * right for a posting engine: it either posts or refuses. A person typing a
 * serial into a job needs to know WHICH way it is wrong, because the fix differs
 * every time — receive it, transfer it, find who has it, or look again at the
 * label. See SERIAL_ALLOC_STATES.
 *
 * ── AND WHY THIS RESERVES NOTHING ──────────────────────────────────────────
 *
 * An allocated serial is still counted by every stock read. The QUANTITY is
 * already claimed by job_stock_reservations (220), and deducting it again
 * because a specific unit was named is the double-count that table's header
 * exists to prevent. What the unique key stops is two lines claiming one unit.
 */

type Row = RowDataPacket & Record<string, unknown>

/** One serial a person has entered, and what the shop knows about it. */
export type SerialCheck = {
  /** Exactly what they typed, so the screen can echo it back. */
  entered: string
  /** The unit, when there is one on file. */
  serialId: number | null
  state: SerialAllocState
  /** Where it is, when that is the problem. */
  locationName: string | null
}

export type JobLineSerial = {
  id: number
  lineId: number
  serialId: number
  serial: string
  allocatedByName: string
  allocatedAt: Date
}

export type SerialResult = { ok: true } | { ok: false; error: string }

/**
 * Serial numbers are compared with spaces and case ignored (§18.3).
 *
 * A label read off a hot compressor at arm's length produces "sn 4471-a" for
 * what the box calls "SN4471A", and refusing that is refusing the person rather
 * than the data. The ORIGINAL text is what gets stored and displayed; this is
 * only ever used for matching.
 *
 * Deliberately the same normalisation customer_assets.serial_key applies, so a
 * fitted unit and the asset it becomes agree about what counts as the same
 * serial.
 */
function normalise(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase()
}

/**
 * What the shop knows about each serial somebody has entered for this line.
 *
 * Pure lookup — nothing is written, so a screen can call it on every keystroke
 * without committing anybody to anything.
 *
 * `lineId` is needed because `duplicate` and "already claimed by another line"
 * are different answers to the same-looking situation: the first is a slip in
 * this box, the second is a unit somebody else has spoken for.
 */
export async function checkSerials(
  siteId: number,
  productId: number,
  lineId: number,
  entries: readonly string[],
): Promise<SerialCheck[]> {
  const cleaned = entries.map((e) => e.trim()).filter((e) => e !== '')
  if (cleaned.length === 0) return []

  const keys = cleaned.map(normalise)

  /*
   * Matched on the NORMALISED form in SQL rather than by loading every serial
   * of the product and comparing in JavaScript. A shop with ten thousand units
   * on file would otherwise pull all of them to check three.
   */
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT s.id, s.serial, s.status, s.product_id, s.location_id,
            loc.name AS location_name, loc.is_main,
            jls.job_card_line_id AS claimed_by
       FROM product_serials s
       LEFT JOIN stock_locations loc ON loc.id = s.location_id
       LEFT JOIN job_line_serials jls ON jls.serial_id = s.id
      WHERE UPPER(REPLACE(s.serial, ' ', '')) IN (${keys.map(() => '?').join(',')})`,
    keys,
  ).catch(() => [])

  const byKey = new Map(rows.map((r) => [normalise(String(r.serial)), r]))

  // First occurrence wins; a repeat of the same key is the duplicate. Compared
  // on the normalised form, so "sn 4471" twice is caught however it was typed.
  const seen = new Set<string>()

  return cleaned.map((entered) => {
    const key = normalise(entered)
    if (seen.has(key)) {
      return { entered, serialId: null, state: 'duplicate' as const, locationName: null }
    }
    seen.add(key)

    const row = byKey.get(key)
    if (!row) {
      return { entered, serialId: null, state: 'unknown' as const, locationName: null }
    }

    const serialId = Number(row.id)
    const locationName = row.location_name === null ? null : String(row.location_name)

    if (Number(row.product_id) !== productId) {
      return { entered, serialId, state: 'wrong_product' as const, locationName }
    }
    if (String(row.status) !== 'in_stock') {
      return { entered, serialId, state: 'unavailable' as const, locationName }
    }
    /*
     * Claimed by a DIFFERENT line reads as unavailable, not as a duplicate.
     * From this person's side the unit is spoken for, which is the same problem
     * as it being sold — `duplicate` means "you typed it twice", and saying that
     * about somebody else's allocation would send them looking in the wrong box.
     */
    if (row.claimed_by !== null && Number(row.claimed_by) !== lineId) {
      return { entered, serialId, state: 'unavailable' as const, locationName }
    }
    /*
     * ── The state checkSellable cannot produce ────────────────────────────
     *
     * jobParts.ts records that `checkSellable` does not check location, and
     * `markSold` NULLs the serial's location when it consumes it — so "at
     * another branch" was specifically undetectable. It is detectable here
     * because a serial not yet sold still says where it is.
     *
     * A NULL location on an in_stock unit is treated as available rather than
     * elsewhere: it means nothing has ever told us where it sits, which is a
     * gap in the record and not evidence that it is somewhere else.
     */
    if (row.location_id !== null && Number(row.is_main) !== 1) {
      return { entered, serialId, state: 'elsewhere' as const, locationName }
    }

    return { entered, serialId, state: 'valid' as const, locationName }
  })
}

/** What is already allocated to a line. */
export async function serialsForLine(siteId: number, lineId: number): Promise<JobLineSerial[]> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, job_card_line_id, serial_id, serial_text, allocated_by_name, allocated_at
         FROM job_line_serials WHERE job_card_line_id = ? ORDER BY id`,
      [lineId],
    )
    return rows.map((r) => ({
      id: Number(r.id),
      lineId: Number(r.job_card_line_id),
      serialId: Number(r.serial_id),
      serial: String(r.serial_text),
      allocatedByName: String(r.allocated_by_name ?? ''),
      allocatedAt: r.allocated_at as Date,
    }))
  } catch {
    // Tolerant of a site without 221, as every job read is of its own migration.
    return []
  }
}

/** Serial counts for a set of lines, so a list can show progress without N reads. */
export async function serialCounts(
  siteId: number,
  lineIds: readonly number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(lineIds)].filter((id) => Number.isFinite(id) && id > 0)
  if (ids.length === 0) return new Map()
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT job_card_line_id, COUNT(*) AS n
         FROM job_line_serials
        WHERE job_card_line_id IN (${ids.map(() => '?').join(',')})
        GROUP BY job_card_line_id`,
      ids,
    )
    return new Map(rows.map((r) => [Number(r.job_card_line_id), Number(r.n)]))
  } catch {
    return new Map()
  }
}

/**
 * Record which units are going on this line.
 *
 * REPLACES the line's allocation rather than adding to it, so the screen can
 * send what the boxes say and does not have to work out a diff. Somebody who
 * scanned the wrong unit deletes it and re-sends four instead of three.
 *
 * Every entry is re-checked here regardless of what the screen decided. The
 * check is a lookup a client can call freely, which makes it advice; this is the
 * boundary, and §39.2 is explicit that a screen having already validated
 * something is not why a server may skip doing so.
 */
export async function allocateSerials(
  siteId: number,
  actor: Actor,
  lineId: number,
  entries: readonly string[],
): Promise<SerialResult> {
  const line = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.job_card_id, l.product_id, l.qty, l.description, l.invoiced_qty,
            p.product_type, j.status AS job_status, j.document_number
       FROM job_card_lines l
       JOIN job_cards j ON j.id = l.job_card_id
       LEFT JOIN products p ON p.id = l.product_id
      WHERE l.id = ?`,
    [lineId],
  ).then((r) => r[0] ?? null)

  if (!line) return { ok: false, error: 'That line no longer exists.' }
  if (String(line.job_status) !== 'open') {
    return { ok: false, error: 'This job is closed, so what was fitted cannot be changed.' }
  }
  if (String(line.product_type ?? '') !== 'serial') {
    return { ok: false, error: `${String(line.description)} is not a serial-tracked part.` }
  }
  /*
   * An invoiced line is settled. markSold has already consumed those units and
   * written serial_movements; rewriting the intent afterwards would leave the
   * job claiming one unit and the ledger recording another, with nothing to say
   * which is right.
   */
  if (Number(line.invoiced_qty) > 0) {
    return {
      ok: false,
      error: `${String(line.description)} has already been invoiced. Credit it to change what was fitted.`,
    }
  }

  const productId = Number(line.product_id)
  const cleaned = entries.map((e) => e.trim()).filter((e) => e !== '')

  if (cleaned.length > Number(line.qty)) {
    return {
      ok: false,
      error: `${String(line.description)} is for ${Number(line.qty)}, so ${cleaned.length} serial numbers is too many.`,
    }
  }

  const checks = await checkSerials(siteId, productId, lineId, cleaned)
  const bad = checks.find((c) => !isAllocatable(c.state))
  if (bad) {
    return {
      ok: false,
      error: `${bad.entered}: ${SERIAL_ALLOC_LABEL[bad.state].toLowerCase()}.`,
    }
  }

  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM job_line_serials WHERE job_card_line_id = ?`, [lineId] as never)
    for (const c of checks) {
      await tx.execute(
        `INSERT INTO job_line_serials
           (job_card_line_id, serial_id, serial_text, allocated_by_user_id, allocated_by_name)
         VALUES (?,?,?,?,?)`,
        [lineId, c.serialId, c.entered.slice(0, 64), actor.userId, actor.userName.slice(0, 120)] as never,
      )
    }
  })

  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: Number(line.job_card_id),
    action: 'serials_allocated',
    detail:
      checks.length === 0
        ? `Serial numbers cleared from ${String(line.description)}`
        : `${checks.length} serial ${checks.length === 1 ? 'number' : 'numbers'} on ${String(line.description)}: ${checks.map((c) => c.entered).join(', ')}`.slice(0, 400),
  })

  return { ok: true }
}

/**
 * The serial ids a job invoice should carry for one line, in allocation order.
 *
 * Read by jobInvoicing so the draft inherits what the technician recorded. An
 * empty array is a real answer — a line nobody allocated against, which the
 * invoicing guard refuses separately with a message about that.
 */
export async function allocatedSerialIds(
  tx: PoolConnection,
  lineId: number,
): Promise<number[]> {
  const [rows] = await tx.query<Row[]>(
    `SELECT serial_id FROM job_line_serials WHERE job_card_line_id = ? ORDER BY id`,
    [lineId] as never,
  )
  return rows.map((r) => Number(r.serial_id))
}

/**
 * The serials a draft invoice should carry, keyed by SALES line id.
 *
 * finaliseDocument takes serials as `{ [salesLineId]: number[] }`, and the job
 * holds them against job lines — so this is the translation, and it exists
 * because the two halves count lines differently.
 *
 * The join is `sales_document_lines.job_card_line_id`, the same link that lets
 * a draft be discarded back to the right line and that salesPosting now uses to
 * find which van a part came off. One column doing three jobs, all of them the
 * same question: which job line is this?
 *
 * Returns an empty object for an ordinary counter invoice, which reaches the
 * engine exactly as the previous `undefined` did.
 */
export async function serialsForInvoice(
  siteId: number,
  invoiceId: number,
): Promise<Record<number, number[]>> {
  try {
    const rows = await siteQuery<Row>(
      siteId,
      `SELECT sl.id AS sales_line_id, jls.serial_id
         FROM sales_document_lines sl
         JOIN job_line_serials jls ON jls.job_card_line_id = sl.job_card_line_id
        WHERE sl.document_id = ?
        ORDER BY sl.id, jls.id`,
      [invoiceId],
    )
    const out: Record<number, number[]> = {}
    for (const r of rows) {
      const lineId = Number(r.sales_line_id)
      ;(out[lineId] ??= []).push(Number(r.serial_id))
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Link a fitted serial to the customer asset it became (§31).
 *
 * `customer_assets.serial_id` has existed since 115 and nothing has ever
 * populated it. The relationship matters because a warranty claim two years
 * later asks "which unit is in this machine", and the only record connecting the
 * sold serial to the customer's asset is this column.
 *
 * Matched by NORMALISED serial text rather than by id, because the asset may
 * have been captured by hand from the same label — someone typing "SN 4471"
 * into the asset screen and scanning "sn4471" on the job means the same unit.
 *
 * Never fails its caller. This runs from the tail of invoicing; an asset link
 * that could not be made is worth reporting, not worth failing a posted invoice.
 */
export async function linkSerialsToAssets(
  siteId: number,
  jobId: number,
): Promise<number> {
  try {
    const result = await siteExecute(
      siteId,
      `UPDATE customer_assets a
         JOIN job_card_assets ja ON ja.asset_id = a.id AND ja.job_card_id = ?
         JOIN job_card_lines l   ON l.job_card_id = ja.job_card_id
         JOIN job_line_serials s ON s.job_card_line_id = l.id
          SET a.serial_id = s.serial_id
        WHERE a.serial_id IS NULL
          AND a.serial_key = UPPER(REPLACE(s.serial_text, ' ', ''))`,
      [jobId],
    )
    return result.affectedRows ?? 0
  } catch {
    return 0
  }
}

/* ── Drift ────────────────────────────────────────────────────────────────── */

export type SerialDrift = {
  /**
   * A line allocated fewer units than it is for.
   *
   * Not an error in itself — a technician half way through a job has fitted two
   * of three. It becomes one at invoicing, which refuses; this reports it
   * earlier so a dispatcher can see the job is not ready.
   */
  shortAllocated: {
    lineId: number
    jobId: number
    jobNumber: string | null
    description: string
    needed: number
    allocated: number
  }[]
  /**
   * An allocation naming a unit that is no longer in stock.
   *
   * The serial was sold, written off or returned by some OTHER path after the
   * technician claimed it. Invisible everywhere else: the job still shows a
   * serial against the line and the unit's own history says nothing about a
   * claim that was never acted on.
   */
  goneUnits: {
    lineId: number
    jobId: number
    serial: string
    description: string
    status: string
  }[]
}

export async function reconcileJobSerials(siteId: number): Promise<SerialDrift> {
  const [short, gone] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, j.document_number, l.description, l.qty AS needed,
              COUNT(s.id) AS allocated
         FROM job_card_lines l
         JOIN job_cards j  ON j.id = l.job_card_id
         JOIN products p   ON p.id = l.product_id
         LEFT JOIN job_line_serials s ON s.job_card_line_id = l.id
        WHERE p.product_type = 'serial' AND j.status = 'open'
        GROUP BY l.id, l.job_card_id, j.document_number, l.description, l.qty
       HAVING allocated < needed`,
    ).catch(() => []),
    siteQuery<Row>(
      siteId,
      `SELECT s.job_card_line_id AS id, l.job_card_id, s.serial_text, l.description, ps.status
         FROM job_line_serials s
         JOIN job_card_lines l   ON l.id = s.job_card_line_id
         JOIN product_serials ps ON ps.id = s.serial_id
        WHERE ps.status <> 'in_stock'`,
    ).catch(() => []),
  ])

  return {
    shortAllocated: short.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      jobNumber: r.document_number === null ? null : String(r.document_number),
      description: String(r.description),
      needed: Number(r.needed),
      allocated: Number(r.allocated),
    })),
    goneUnits: gone.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      serial: String(r.serial_text),
      description: String(r.description),
      status: String(r.status),
    })),
  }
}
