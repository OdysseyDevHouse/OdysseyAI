import 'server-only'
import type { PoolConnection } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '@/lib/siteDb'
import { toNum } from '@/lib/decimals'
import { mainLocationId } from './stockLocations'
import type { Actor } from './activityLog'

/**
 * Serial numbers — knowing which individual unit went where.
 *
 * A serial product is an ordinary stocked item plus one promise: every unit is
 * identifiable, so the shop can answer "who bought THIS one" when it comes
 * back under warranty a year later. That question is the entire reason to
 * carry serials, and it is why a row per unit is the only workable shape — a
 * count cannot tell you which handset left on which invoice.
 *
 * ── THE SECOND INVARIANT ─────────────────────────────────────────────────
 *
 * For a serial product, `stock_on_hand` must equal the number of serials whose
 * status is 'in_stock'. That sits alongside Σ qty_change = stock_on_hand, and
 * `reconcileSerials` proves it the same way the other reconciliations do. Two
 * figures that must agree, checkable on demand, rather than one figure everyone
 * hopes is right.
 *
 * ── WHAT SELLING ONE DOES ────────────────────────────────────────────────
 *
 * Stock moves exactly as it does for any normal product — the serial machinery
 * does not replace the movement, it records WHICH unit moved. So the existing
 * reconciliation keeps working untouched, and the serial table is an extra
 * layer of truth rather than a competing one.
 */

type Row = Record<string, unknown>

/* The statuses and their labels live in lib/serialStatus.ts so client screens
   can read them without pulling this server-only module — and its database
   pool — into the browser bundle. Re-exported here so server callers still find
   them where they have always been. */
export { SERIAL_STATUSES, SERIAL_LABELS, type SerialStatus } from '@/lib/serialStatus'
// Re-exporting does not bind the names locally, and the refusal messages below
// read from SERIAL_LABELS.
import { SERIAL_LABELS, type SerialStatus } from '@/lib/serialStatus'

export type Serial = {
  id: number
  productId: number
  productCode: string
  productDescription: string
  serial: string
  status: SerialStatus
  /** Which room it is in. NULL once it is sold, returned faulty or written off. */
  locationId: number | null
  locationCode: string | null
  costExcl: number
  receivedAt: Date | null
  soldDocId: number | null
  soldDocNumber: string | null
  soldAt: Date | null
  customerId: number | null
  customerName: string | null
  warrantyUntil: string | null
  note: string | null
}

const SELECT_SERIAL = `
  SELECT s.id, s.product_id, s.location_id, s.serial, s.status, s.cost_excl, s.received_at,
         s.sold_doc_id, s.sold_at, s.customer_id, s.warranty_until, s.note,
         p.code AS product_code, p.description AS product_description,
         d.document_number AS sold_doc_number,
         c.name AS customer_name,
         l.code AS location_code
    FROM product_serials s
    JOIN products p            ON p.id = s.product_id
    LEFT JOIN sales_documents d ON d.id = s.sold_doc_id
    LEFT JOIN customers c       ON c.id = s.customer_id
    LEFT JOIN stock_locations l ON l.id = s.location_id
`

function mapSerial(r: Row): Serial {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    productCode: String(r.product_code),
    productDescription: String(r.product_description),
    serial: String(r.serial),
    status: r.status as SerialStatus,
    locationId: r.location_id === null || r.location_id === undefined ? null : Number(r.location_id),
    locationCode: (r.location_code as string | null) ?? null,
    costExcl: toNum(r.cost_excl),
    receivedAt: (r.received_at as Date | null) ?? null,
    soldDocId: r.sold_doc_id === null ? null : Number(r.sold_doc_id),
    soldDocNumber: (r.sold_doc_number as string | null) ?? null,
    soldAt: (r.sold_at as Date | null) ?? null,
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    customerName: (r.customer_name as string | null) ?? null,
    warrantyUntil: (r.warranty_until as string | null) ?? null,
    note: (r.note as string | null) ?? null,
  }
}

export type SerialListOptions = {
  productId?: number
  status?: SerialStatus
  q?: string
  limit?: number
  offset?: number
}

export async function listSerials(
  siteId: number,
  options: SerialListOptions = {},
): Promise<{ items: Serial[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (options.productId) {
    where.push('s.product_id = ?')
    params.push(options.productId)
  }
  if (options.status) {
    where.push('s.status = ?')
    params.push(options.status)
  }
  if (options.q?.trim()) {
    where.push('(s.serial LIKE ? OR p.code LIKE ? OR p.description LIKE ?)')
    const like = `%${options.q.trim()}%`
    params.push(like, like, like)
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_SERIAL} ${clause} ORDER BY s.status, s.serial LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS total FROM product_serials s JOIN products p ON p.id = s.product_id ${clause}`,
      params,
    ),
  ])

  return { items: rows.map(mapSerial), total: Number(countRow?.total ?? 0) }
}

/** Look one up by number alone — what the warranty desk actually has. */
export async function findSerial(siteId: number, serial: string): Promise<Serial[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_SERIAL} WHERE s.serial = ? ORDER BY s.id DESC`,
    [serial.trim()],
  )
  return rows.map(mapSerial)
}

/**
 * What is available to sell right now, for the capture screen's picker.
 *
 * Restricted to ONE location, defaulting to main — the same rule
 * availableToSell follows for quantities. A unit in the back warehouse is
 * owned but not sellable at this counter, and offering it would let the till
 * hand over a serial that is in another building.
 *
 * Pass a locationId to pick from a specific room instead; pass null explicitly
 * to see every in-stock unit wherever it is, which is what a stock take or a
 * transfer picker wants.
 */
export async function availableSerials(
  siteId: number,
  productId: number,
  locationId?: number | null,
): Promise<Serial[]> {
  if (locationId === null) {
    const rows = await siteQuery<Row>(
      siteId,
      `${SELECT_SERIAL} WHERE s.product_id = ? AND s.status = 'in_stock' ORDER BY s.serial`,
      [productId],
    )
    return rows.map(mapSerial)
  }

  const target = locationId ?? (await mainLocationId(siteId))
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_SERIAL}
      WHERE s.product_id = ? AND s.status = 'in_stock' AND s.location_id = ?
      ORDER BY s.serial`,
    [productId, target],
  )
  return rows.map(mapSerial)
}

export type AddResult = { ok: true; added: number; skipped: string[] } | { ok: false; error: string }

/**
 * Takes serials into stock.
 *
 * Does NOT move stock. Receiving goods is what moves stock — a GRV, an opening
 * balance, an adjustment — and this records which individual units those goods
 * were. Moving stock here as well would double it, and `reconcileSerials` is
 * what catches the mismatch if the two ever get out of step.
 *
 * Duplicates are skipped and named rather than failing the batch: someone
 * pasting fifty serials off a delivery note should not lose all fifty because
 * one was already captured.
 */
export async function addSerials(
  siteId: number,
  actor: Actor,
  productId: number,
  serials: readonly string[],
  options: {
    costExcl?: number
    warrantyUntil?: string | null
    receivedDocId?: number | null
    /**
     * Which room the units went into. Defaults to main, matching what a GRV
     * line without a location does — the two have to agree, or the quantity
     * lands in one place and the serials in another.
     */
    locationId?: number | null
  } = {},
): Promise<AddResult> {
  const product = await siteQueryOne<Row>(
    siteId,
    'SELECT id, product_type FROM products WHERE id = ?',
    [productId],
  )
  if (!product) return { ok: false, error: 'That product no longer exists.' }
  if (String(product.product_type) !== 'serial') {
    return { ok: false, error: 'Only a serial-tracked product carries serial numbers.' }
  }

  const cleaned = [...new Set(serials.map((s) => s.trim()).filter((s) => s.length > 0))]
  if (cleaned.length === 0) return { ok: false, error: 'Enter at least one serial number.' }

  const tooLong = cleaned.find((s) => s.length > 64)
  if (tooLong) return { ok: false, error: `"${tooLong.slice(0, 20)}…" is too long for a serial number.` }

  const existing = await siteQuery<Row>(
    siteId,
    `SELECT serial FROM product_serials
      WHERE product_id = ? AND serial IN (${cleaned.map(() => '?').join(',')})`,
    [productId, ...cleaned],
  )
  const already = new Set(existing.map((r) => String(r.serial)))
  const fresh = cleaned.filter((s) => !already.has(s))

  if (fresh.length > 0) {
    const locationId = options.locationId ?? (await mainLocationId(siteId))

    await siteTransaction(siteId, async (tx) => {
      for (const serial of fresh) {
        const [res] = await tx.execute(
          `INSERT INTO product_serials
             (product_id, location_id, serial, status, cost_excl, warranty_until, received_doc_id, received_at)
           VALUES (?,?,?,'in_stock',?,?,?,NOW())`,
          [
            productId,
            locationId,
            serial,
            (options.costExcl ?? 0).toFixed(4),
            options.warrantyUntil || null,
            options.receivedDocId ?? null,
          ] as never,
        )
        await tx.execute(
          `INSERT INTO serial_movements
             (serial_id, action, document_id, to_location_id, user_id, user_name)
           VALUES (?, 'received', ?, ?, ?, ?)`,
          [
            (res as { insertId: number }).insertId,
            options.receivedDocId ?? null,
            locationId,
            actor.userId,
            actor.userName.slice(0, 120),
          ] as never,
        )
      }
    })
  }

  return { ok: true, added: fresh.length, skipped: [...already] }
}

export type SellResult = { ok: true; sold: number } | { ok: false; error: string }

/**
 * Marks serials sold, inside the caller's open transaction.
 *
 * Takes the transaction rather than opening its own, for the same reason
 * `recordMovement` does: a sale that moved stock but did not mark its serials
 * would leave the two figures disagreeing with no way to tell which was right.
 * Either both commit or neither does.
 */
export async function markSold(
  tx: PoolConnection,
  actor: Actor,
  input: {
    serialIds: readonly number[]
    productId: number
    documentId: number
    documentLineId?: number | null
    customerId?: number | null
  },
): Promise<void> {
  for (const serialId of input.serialIds) {
    // Read the room BEFORE clearing it, so the history can say where the unit
    // went out from. Once location_id is NULL that answer is gone for good.
    const [before] = await tx.execute(
      'SELECT location_id FROM product_serials WHERE id = ?',
      [serialId] as never,
    )
    const fromLocationId = (before as Row[])[0]?.location_id ?? null

    // location_id goes NULL: a sold unit is not in any room, and leaving it
    // pointing at the shelf it left would have it counted there by the
    // per-location reconciliation.
    await tx.execute(
      `UPDATE product_serials
          SET status = 'sold', location_id = NULL,
              sold_doc_id = ?, sold_line_id = ?, sold_at = NOW(), customer_id = ?
        WHERE id = ? AND product_id = ?`,
      [
        input.documentId,
        input.documentLineId ?? null,
        input.customerId ?? null,
        serialId,
        input.productId,
      ] as never,
    )
    await tx.execute(
      `INSERT INTO serial_movements
         (serial_id, action, document_id, document_line_id, from_location_id, user_id, user_name)
       VALUES (?, 'sold', ?, ?, ?, ?, ?)`,
      [
        serialId,
        input.documentId,
        input.documentLineId ?? null,
        fromLocationId,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
  }
}

/**
 * Checks serials can be sold, BEFORE anything moves.
 *
 * Every reason a serial cannot go out is knowable in advance, so all of them
 * are checked here and the sale is refused with the specific serial named. A
 * cashier told "serial ABC123 has already been sold" can fix it; one told
 * "invalid serial" cannot.
 */
export async function checkSellable(
  siteId: number,
  productId: number,
  serialIds: readonly number[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (serialIds.length === 0) return { ok: true }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, serial, status, product_id FROM product_serials
      WHERE id IN (${serialIds.map(() => '?').join(',')})`,
    [...serialIds],
  )

  if (rows.length !== new Set(serialIds).size) {
    return { ok: false, error: 'One of those serial numbers no longer exists.' }
  }

  for (const row of rows) {
    if (Number(row.product_id) !== productId) {
      return { ok: false, error: `Serial ${row.serial} belongs to a different product.` }
    }
    if (String(row.status) !== 'in_stock') {
      const status = String(row.status) as SerialStatus
      return {
        ok: false,
        error: `Serial ${row.serial} is not in stock — it is marked ${SERIAL_LABELS[status].toLowerCase()}.`,
      }
    }
  }

  return { ok: true }
}

export type ReturnResult = { ok: true } | { ok: false; error: string }

/**
 * Brings a sold serial back.
 *
 * `resellable` decides the status, and it is the caller's decision because it
 * is a judgement about the goods, not about the data. A resellable unit goes
 * back to 'in_stock' and counts toward stock again; a faulty one goes to
 * 'returned' and does not, which is why the credit note's stock movement and
 * this call have to agree.
 */
export async function markReturned(
  siteId: number,
  actor: Actor,
  serialIds: readonly number[],
  options: {
    resellable: boolean
    documentId?: number | null
    note?: string | null
    /**
     * Where the returned unit is put. Defaults to main, because that is where
     * the credit note's stock movement puts the quantity — the two have to
     * land in the same room or the per-location counts disagree.
     */
    locationId?: number | null
  },
): Promise<ReturnResult> {
  if (serialIds.length === 0) return { ok: true }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, serial, status FROM product_serials
      WHERE id IN (${serialIds.map(() => '?').join(',')})`,
    [...serialIds],
  )
  const notSold = rows.find((r) => String(r.status) !== 'sold')
  if (notSold) {
    return { ok: false, error: `Serial ${notSold.serial} was not sold, so it cannot be returned.` }
  }

  const status: SerialStatus = options.resellable ? 'in_stock' : 'returned'

  // Only a resellable unit goes back on a shelf. A faulty one is 'returned' —
  // it does not count toward stock, so giving it a room would have the
  // per-location reconciliation expect a pile that is not there.
  const locationId = options.resellable
    ? (options.locationId ?? (await mainLocationId(siteId)))
    : null

  await siteTransaction(siteId, async (tx) => {
    for (const serialId of serialIds) {
      await tx.execute(
        `UPDATE product_serials
            SET status = ?, location_id = ?,
                sold_doc_id = NULL, sold_line_id = NULL, sold_at = NULL, customer_id = NULL,
                note = COALESCE(?, note)
          WHERE id = ?`,
        [status, locationId, options.note?.slice(0, 190) ?? null, serialId] as never,
      )
      await tx.execute(
        `INSERT INTO serial_movements
           (serial_id, action, document_id, to_location_id, user_id, user_name, note)
         VALUES (?, 'returned', ?, ?, ?, ?, ?)`,
        [
          serialId,
          options.documentId ?? null,
          locationId,
          actor.userId,
          actor.userName.slice(0, 120),
          options.resellable ? 'Back in stock' : 'Not resellable',
        ] as never,
      )
    }
  })

  return { ok: true }
}

/**
 * Moves serials between rooms, inside the caller's open transaction.
 *
 * ── WHY THIS TAKES THE TRANSACTION ─────────────────────────────────────────
 *
 * A transfer of a serialised product moves the QUANTITY through
 * recordMovement and the UNITS through here. If only the first ran, the pile
 * in each room would be right while every serial still claimed the room the
 * goods left — invariant (S2) broken, and the warranty desk sending someone to
 * the wrong shelf. They commit together or not at all, exactly as markSold
 * does for the same reason.
 *
 * Refuses rather than silently skipping when a unit is not in the source room:
 * a transfer naming three serials and moving two is a discrepancy someone has
 * to resolve, not something to paper over.
 */
export async function markTransferred(
  tx: PoolConnection,
  actor: Actor,
  input: {
    serialIds: readonly number[]
    fromLocationId: number
    toLocationId: number
    transferId?: number | null
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.serialIds.length === 0) return { ok: true }

  const [rows] = await tx.execute(
    `SELECT id, serial, status, location_id FROM product_serials
      WHERE id IN (${input.serialIds.map(() => '?').join(',')})
      FOR UPDATE`,
    [...input.serialIds] as never,
  )
  const found = rows as Row[]

  if (found.length !== new Set(input.serialIds).size) {
    return { ok: false, error: 'One of those serial numbers no longer exists.' }
  }

  for (const row of found) {
    if (String(row.status) !== 'in_stock') {
      return {
        ok: false,
        error: `Serial ${String(row.serial)} is not in stock, so it cannot be transferred.`,
      }
    }
    if (Number(row.location_id) !== input.fromLocationId) {
      return {
        ok: false,
        error: `Serial ${String(row.serial)} is not in the location this transfer is moving out of.`,
      }
    }
  }

  for (const serialId of input.serialIds) {
    await tx.execute('UPDATE product_serials SET location_id = ? WHERE id = ?', [
      input.toLocationId,
      serialId,
    ] as never)

    await tx.execute(
      `INSERT INTO serial_movements
         (serial_id, action, document_id, from_location_id, to_location_id, user_id, user_name)
       VALUES (?, 'transferred', ?, ?, ?, ?, ?)`,
      [
        serialId,
        input.transferId ?? null,
        input.fromLocationId,
        input.toLocationId,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
  }

  return { ok: true }
}

/** Takes a serial permanently out — lost, stolen or scrapped. */
export async function writeOffSerial(
  siteId: number,
  actor: Actor,
  serialId: number,
  reason: string,
): Promise<ReturnResult> {
  if (!reason.trim()) return { ok: false, error: 'Give a reason for writing it off.' }

  const serial = await siteQueryOne<Row>(
    siteId,
    'SELECT id, serial, status FROM product_serials WHERE id = ?',
    [serialId],
  )
  if (!serial) return { ok: false, error: 'That serial no longer exists.' }
  if (String(serial.status) === 'sold') {
    return { ok: false, error: 'That serial has been sold. Credit the sale first.' }
  }
  if (String(serial.status) === 'written_off') {
    return { ok: false, error: 'That serial is already written off.' }
  }

  // location_id goes NULL with the status: a written-off unit is not on a
  // shelf, and leaving it pointing at one would have the per-location
  // reconciliation expect a pile that no longer includes it.
  await siteExecute(
    siteId,
    "UPDATE product_serials SET status = 'written_off', location_id = NULL, note = ? WHERE id = ?",
    [reason.trim().slice(0, 190), serialId],
  )
  await siteExecute(
    siteId,
    `INSERT INTO serial_movements (serial_id, action, user_id, user_name, note)
     VALUES (?, 'written_off', ?, ?, ?)`,
    [serialId, actor.userId, actor.userName.slice(0, 120), reason.trim().slice(0, 190)],
  )

  return { ok: true }
}

export type SerialDrift = {
  productId: number
  code: string
  description: string
  stockOnHand: number
  inStockSerials: number
  drift: number
  /**
   * Which room disagrees, or null when the SITE TOTAL is what does not add up.
   *
   * A named row means the pile in that location and the serials assigned to it
   * differ. A null row means an in_stock serial has no location at all, which
   * is its own bug — see reconcileSerials.
   */
  locationId: number | null
  locationCode: string | null
}

/**
 * Proves the serial invariant, per location.
 *
 * 021_serials.sql promised, for a serial product:
 *
 *   (S1)  count(in_stock serials)              = products.stock_on_hand
 *
 * Locations sharpen that to the per-room version, which is strictly stronger
 * and is what this checks:
 *
 *   (S2)  count(in_stock serials in location L) = the pile in L
 *
 * (S2) implies (S1) by summing over locations — the same relationship (B) has
 * to (A) — so checking it separately would report the same product twice with
 * no extra information. What (S2) catches and (S1) never could is a transfer
 * that moved the quantity but left the serials pointing at the room the goods
 * left: the totals still agree while every room is wrong.
 *
 * Any row is a bug in a posting path, not rounding — both sides are counts of
 * whole units. The same promise `reconcileStock` and `reconcileBalances` make,
 * for the same reason: a figure nobody can check is a figure nobody can trust.
 */
export async function reconcileSerials(siteId: number): Promise<SerialDrift[]> {
  // (S2) — every room holding either a pile or some serials for a serial
  // product. FULL OUTER JOIN is not available, so the two sides are unioned:
  // a pile with no serials and serials with no pile are both drift, and each
  // would be invisible to a plain join from the other side.
  const perLocation = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, x.location_id, l.code AS location_code,
            COALESCE(pls.stock_on_hand, 0) AS stock_on_hand,
            COALESCE((SELECT COUNT(*) FROM product_serials s2
                       WHERE s2.product_id = p.id
                         AND s2.location_id = x.location_id
                         AND s2.status = 'in_stock'), 0) AS in_stock
       FROM products p
       JOIN (
             SELECT product_id, location_id FROM product_location_stock
              UNION
             SELECT product_id, location_id FROM product_serials
              WHERE status = 'in_stock' AND location_id IS NOT NULL
            ) x ON x.product_id = p.id
       JOIN stock_locations l ON l.id = x.location_id
       LEFT JOIN product_location_stock pls
              ON pls.product_id = p.id AND pls.location_id = x.location_id
      WHERE p.product_type = 'serial'
     HAVING ABS(stock_on_hand - in_stock) > 0.0005`,
  )

  // An in_stock serial with no room at all. Not covered above — it belongs to
  // no location, so no per-location comparison can see it — and it is exactly
  // the state the migration was written to prevent.
  const unplaced = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.code, p.description, p.stock_on_hand,
            COUNT(*) AS in_stock
       FROM product_serials s
       JOIN products p ON p.id = s.product_id
      WHERE s.status = 'in_stock' AND s.location_id IS NULL
      GROUP BY p.id, p.code, p.description, p.stock_on_hand`,
  )

  const mapDrift = (r: Row, locationAware: boolean): SerialDrift => {
    const stockOnHand = toNum(r.stock_on_hand)
    const inStockSerials = Number(r.in_stock)
    return {
      productId: Number(r.id),
      code: String(r.code),
      description: String(r.description),
      stockOnHand,
      inStockSerials,
      drift: stockOnHand - inStockSerials,
      locationId: locationAware && r.location_id != null ? Number(r.location_id) : null,
      locationCode: locationAware ? ((r.location_code as string | null) ?? null) : null,
    }
  }

  return [
    ...perLocation.map((r) => mapDrift(r, true)),
    ...unplaced.map((r) => mapDrift(r, false)),
  ]
}

/** The history of one unit, for the warranty desk. */
export async function serialHistory(
  siteId: number,
  serialId: number,
): Promise<{ action: string; documentNumber: string | null; userName: string; note: string | null; at: Date }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT m.action, m.user_name, m.note, m.created_at, d.document_number
       FROM serial_movements m
       LEFT JOIN sales_documents d ON d.id = m.document_id
      WHERE m.serial_id = ?
      ORDER BY m.created_at DESC, m.id DESC`,
    [serialId],
  )

  return rows.map((r) => ({
    action: String(r.action),
    documentNumber: (r.document_number as string | null) ?? null,
    userName: String(r.user_name),
    note: (r.note as string | null) ?? null,
    at: r.created_at as Date,
  }))
}
