import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { isPeriodLocked } from './settings'
import { mirrorStockAdjustment } from './glPosting'
import type { Actor } from './activityLog'

/**
 * Writing stock on or off, deliberately.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 *
 * Before this, `movement_type = 'adjustment'` was only ever a side effect: a
 * stock take variance, a voided GRV, a supplier return. Recording that three
 * bottles broke meant raising a stock take over the whole location, which is a
 * days work to write off a case and which corrupts the count history of every
 * other product on the sheet.
 *
 * This is the document that says so directly.
 *
 * ── ONE-SIDED, ON PURPOSE ──────────────────────────────────────────────────
 *
 * A transfer writes two movements because the business still owns the same
 * goods. An adjustment writes ONE, because it does not:
 *
 *   (A) Σ qty_change            = products.stock_on_hand   — the total moves
 *   (B) Σ per (product,location) = product_location_stock   — the pile moves
 *   (C) Σ piles                  = products.stock_on_hand   — by the same amount
 *
 * recordMovement() moves both figures inside one statement each, so all three
 * hold with no arithmetic here beyond passing through it.
 *
 * ── COST IS RECORDED, NOT RECALCULATED ─────────────────────────────────────
 *
 * average_cost is untouched, matching transfers and unlike a GRV. Writing off a
 * damaged case does not change what the surviving units cost. The cost is
 * carried onto the line and the movement so the VALUE written off is answerable,
 * and that value is what the GL journal posts to account 5100.
 */

export type AdjustmentStatus = 'draft' | 'posted' | 'cancelled'
export type ReasonDirection = 'in' | 'out' | 'both'

export type AdjustmentReason = {
  id: number
  code: string
  name: string
  direction: ReasonDirection
  isActive: boolean
  sortOrder: number
  /** Posted lines naming it. Shown before offering to retire one. */
  useCount: number
}

export type AdjustmentLine = {
  id: number
  productId: number
  productCode: string | null
  description: string
  /** What the pile held when the line was captured. A snapshot, not a condition. */
  qtyBefore: number
  /** Signed. Negative writes stock off. */
  qtyChange: number
  unitCostExcl: number
  reasonId: number | null
  reasonCode: string | null
  reasonName: string | null
  serials: number[]
  note: string | null
  movementId: number | null
}

export type StockAdjustment = {
  id: number
  documentNumber: string | null
  documentDate: string
  locationId: number
  locationCode: string
  locationName: string
  status: AdjustmentStatus
  reasonId: number | null
  reasonCode: string | null
  reasonName: string | null
  reference: string | null
  note: string | null
  varianceQty: number
  varianceValue: number
  postedAt: Date | null
  cancelReason: string | null
  cancelledAt: Date | null
  userName: string
  createdAt: Date
  lines: AdjustmentLine[]
  /** For a list that does not load the lines. */
  lineCount: number
}

type Row = RowDataPacket & Record<string, unknown>

/* ── Reasons ─────────────────────────────────────────────────────────────── */

function mapReason(r: Row): AdjustmentReason {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    direction: String(r.direction) as ReasonDirection,
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order ?? 0),
    useCount: Number(r.use_count ?? 0),
  }
}

export async function listReasons(
  siteId: number,
  includeInactive = false,
): Promise<AdjustmentReason[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT r.id, r.code, r.name, r.direction, r.is_active, r.sort_order,
            (SELECT COUNT(*) FROM stock_adjustment_lines l WHERE l.reason_id = r.id) AS use_count
       FROM stock_adjustment_reasons r
      ${includeInactive ? '' : 'WHERE r.is_active = 1'}
      ORDER BY r.sort_order ASC, r.name ASC`,
  )
  return rows.map(mapReason)
}

export type ReasonInput = {
  code: string
  name: string
  direction: ReasonDirection
  isActive?: boolean
  sortOrder?: number
}

export function validateReason(input: ReasonInput): string | null {
  const code = input.code.trim().toUpperCase()
  if (!/^[A-Z0-9-]{2,24}$/.test(code)) {
    return 'A reason code is 2 to 24 letters, digits or hyphens.'
  }
  if (!input.name.trim()) return 'Give the reason a name.'
  return null
}

export async function saveReason(
  siteId: number,
  input: ReasonInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const invalid = validateReason(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM stock_adjustment_reasons WHERE code = ? AND id <> ? LIMIT 1',
    [code, id ?? 0],
  )
  if (clash) return { ok: false, error: `Another reason already uses the code ${code}.` }

  if (id) {
    await siteExecute(
      siteId,
      `UPDATE stock_adjustment_reasons
          SET code = ?, name = ?, direction = ?, is_active = ?, sort_order = ?
        WHERE id = ?`,
      [
        code,
        input.name.trim().slice(0, 120),
        input.direction,
        input.isActive === false ? 0 : 1,
        input.sortOrder ?? 0,
        id,
      ],
    )
    return { ok: true, id }
  }

  const res = await siteExecute(
    siteId,
    `INSERT INTO stock_adjustment_reasons (code, name, direction, is_active, sort_order)
     VALUES (?,?,?,?,?)`,
    [
      code,
      input.name.trim().slice(0, 120),
      input.direction,
      input.isActive === false ? 0 : 1,
      input.sortOrder ?? 0,
    ],
  )
  return { ok: true, id: res.insertId }
}

/**
 * Retires a reason, or deletes it when nothing has ever used it.
 *
 * The same rule as a location: history naming it has to keep reading correctly,
 * so a used reason is deactivated rather than removed.
 */
export async function deleteReason(
  siteId: number,
  id: number,
): Promise<{ ok: true; retired: boolean } | { ok: false; error: string }> {
  const used = await siteQueryOne<Row>(
    siteId,
    `SELECT (SELECT COUNT(*) FROM stock_adjustment_lines WHERE reason_id = ?) +
            (SELECT COUNT(*) FROM stock_adjustments      WHERE reason_id = ?) AS n`,
    [id, id],
  )
  if (Number(used?.n ?? 0) > 0) {
    await siteExecute(siteId, 'UPDATE stock_adjustment_reasons SET is_active = 0 WHERE id = ?', [id])
    return { ok: true, retired: true }
  }
  await siteExecute(siteId, 'DELETE FROM stock_adjustment_reasons WHERE id = ?', [id])
  return { ok: true, retired: false }
}

/* ── Reading adjustments ─────────────────────────────────────────────────── */

function mapAdjustment(r: Row, lines: AdjustmentLine[] = []): StockAdjustment {
  return {
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date).slice(0, 10),
    locationId: Number(r.location_id),
    locationCode: String(r.location_code ?? ''),
    locationName: String(r.location_name ?? ''),
    status: String(r.status) as AdjustmentStatus,
    reasonId: r.reason_id === null ? null : Number(r.reason_id),
    reasonCode: (r.reason_code as string | null) ?? null,
    reasonName: (r.reason_name as string | null) ?? null,
    reference: (r.reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    varianceQty: toNum(r.variance_qty),
    varianceValue: toNum(r.variance_value),
    postedAt: (r.posted_at as Date | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    cancelledAt: (r.cancelled_at as Date | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
    lines,
    lineCount: Number(r.line_count ?? lines.length),
  }
}

const SELECT_ADJUSTMENT = `
  SELECT a.id, a.document_number, a.document_date, a.location_id, a.status,
         a.reason_id, a.reference, a.note, a.variance_qty, a.variance_value,
         a.posted_at, a.cancel_reason, a.cancelled_at, a.user_name, a.created_at,
         l.code AS location_code, l.name AS location_name,
         r.code AS reason_code,   r.name AS reason_name,
         (SELECT COUNT(*) FROM stock_adjustment_lines ln WHERE ln.adjustment_id = a.id) AS line_count
    FROM stock_adjustments a
    JOIN stock_locations l ON l.id = a.location_id
    LEFT JOIN stock_adjustment_reasons r ON r.id = a.reason_id
`

export async function listAdjustments(
  siteId: number,
  opts: {
    status?: AdjustmentStatus | 'all'
    locationId?: number
    reasonId?: number
    limit?: number
    offset?: number
  } = {},
): Promise<StockAdjustment[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const where: string[] = []
  const params: unknown[] = []
  if (opts.status && opts.status !== 'all') {
    where.push('a.status = ?')
    params.push(opts.status)
  }
  if (opts.locationId) {
    where.push('a.location_id = ?')
    params.push(opts.locationId)
  }
  if (opts.reasonId) {
    where.push('a.reason_id = ?')
    params.push(opts.reasonId)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_ADJUSTMENT}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.document_date DESC, a.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  return rows.map((r) => mapAdjustment(r))
}

export async function countAdjustments(
  siteId: number,
  opts: { status?: AdjustmentStatus | 'all'; locationId?: number; reasonId?: number } = {},
): Promise<number> {
  const where: string[] = []
  const params: unknown[] = []
  if (opts.status && opts.status !== 'all') {
    where.push('status = ?')
    params.push(opts.status)
  }
  if (opts.locationId) {
    where.push('location_id = ?')
    params.push(opts.locationId)
  }
  if (opts.reasonId) {
    where.push('reason_id = ?')
    params.push(opts.reasonId)
  }
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM stock_adjustments ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  )
  return Number(row?.n ?? 0)
}

function parseSerials(raw: unknown): number[] {
  if (!raw) return []
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []
  } catch {
    // A malformed blob must not take the whole document down. An empty list
    // reads as "no units chosen", which the post path then refuses by name.
    return []
  }
}

export async function getAdjustment(siteId: number, id: number): Promise<StockAdjustment | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_ADJUSTMENT} WHERE a.id = ? LIMIT 1`, [id])
  if (!row) return null

  const lineRows = await siteQuery<Row>(
    siteId,
    `SELECT ln.id, ln.product_id, ln.product_code, ln.description,
            ln.qty_before, ln.qty_change, ln.unit_cost_excl, ln.reason_id,
            ln.serial_ids, ln.note, ln.movement_id,
            r.code AS reason_code, r.name AS reason_name
       FROM stock_adjustment_lines ln
       LEFT JOIN stock_adjustment_reasons r ON r.id = ln.reason_id
      WHERE ln.adjustment_id = ?
      ORDER BY ln.line_number ASC, ln.id ASC`,
    [id],
  )

  return mapAdjustment(
    row,
    lineRows.map((l) => ({
      id: Number(l.id),
      productId: Number(l.product_id),
      productCode: (l.product_code as string | null) ?? null,
      description: String(l.description),
      qtyBefore: toNum(l.qty_before),
      qtyChange: toNum(l.qty_change),
      unitCostExcl: toNum(l.unit_cost_excl),
      reasonId: l.reason_id === null ? null : Number(l.reason_id),
      reasonCode: (l.reason_code as string | null) ?? null,
      reasonName: (l.reason_name as string | null) ?? null,
      serials: parseSerials(l.serial_ids),
      note: (l.note as string | null) ?? null,
      movementId: l.movement_id === null ? null : Number(l.movement_id),
    })),
  )
}

/* ── Capture ─────────────────────────────────────────────────────────────── */

export type AdjustmentLineInput = {
  productId: number
  productCode?: string | null
  description: string
  /** What the screen showed as on hand when the line was captured. */
  qtyBefore?: number
  /** Signed. Negative writes stock off. */
  qtyChange: number
  unitCostExcl?: number
  reasonId?: number | null
  /**
   * For a serial-tracked product being written OFF, which units are going.
   *
   * Required, and its length must equal the quantity — the same rule transfers
   * apply, and for the same reason: the pile would come out right while every
   * unit still claimed to be on a shelf.
   */
  serialIds?: readonly number[]
  note?: string | null
}

export type AdjustmentInput = {
  locationId: number
  documentDate?: string
  reasonId?: number | null
  reference?: string | null
  note?: string | null
  lines: AdjustmentLineInput[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }
export type PostResult =
  | { ok: true; id: number; documentNumber: string; movements: number; varianceValue: number }
  | { ok: false; error: string }

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Validates without touching the database, so the screen can refuse the same
 * things for the same reasons before anyone clicks post.
 */
export function validateAdjustment(input: AdjustmentInput): string | null {
  if (!input.locationId) return 'Choose which location is being adjusted.'

  const lines = input.lines.filter((l) => l.productId)
  if (lines.length === 0) return 'Add at least one product to adjust.'

  if (lines.some((l) => !Number.isFinite(l.qtyChange))) {
    return 'Every line needs a quantity.'
  }
  // A line of zero is the one thing that looks captured and does nothing. It is
  // refused rather than skipped so the person can see which row they left blank.
  if (lines.some((l) => Math.abs(round(l.qtyChange, 3)) < 0.0005)) {
    return 'Every line needs a quantity that is not zero — say how many were gained or lost.'
  }

  const seen = new Set<number>()
  for (const line of lines) {
    if (seen.has(line.productId)) {
      return `${line.productCode ?? line.description} appears twice. Put the whole quantity on one line.`
    }
    seen.add(line.productId)
  }

  /*
   * A reason is not decoration. "How much did we lose to breakage last quarter"
   * is the question this document exists to answer, and one unreasoned line is
   * enough to make that figure a lie. The document reason covers every line
   * that does not override it, so this only refuses a genuinely blank one.
   */
  if (!input.reasonId && lines.some((l) => !l.reasonId)) {
    return 'Choose a reason — it is what makes an adjustment answerable later.'
  }
  return null
}

/**
 * Creates or replaces a DRAFT.
 *
 * Lines are deleted and rewritten wholesale rather than diffed. A draft has no
 * movements against it, so nothing downstream can be pointing at a line id, and
 * the alternative is a three-way merge to save a handful of rows.
 */
export async function saveAdjustment(
  siteId: number,
  actor: Actor,
  input: AdjustmentInput,
  id?: number,
): Promise<SaveResult> {
  const invalid = validateAdjustment(input)
  if (invalid) return { ok: false, error: invalid }

  const docDate = input.documentDate ?? todayIso()
  const lines = input.lines.filter((l) => l.productId)

  try {
    return await siteTransaction(siteId, async (tx) => {
      let adjustmentId = id ?? 0

      if (adjustmentId) {
        const [rows] = await tx.execute(
          'SELECT status FROM stock_adjustments WHERE id = ? FOR UPDATE',
          [adjustmentId] as never,
        )
        const existing = (rows as Row[])[0]
        if (!existing) return { ok: false as const, error: 'That adjustment no longer exists.' }
        if (String(existing.status) !== 'draft') {
          return { ok: false as const, error: 'Only a draft adjustment can be changed.' }
        }

        await tx.execute(
          `UPDATE stock_adjustments
              SET document_date = ?, location_id = ?, reason_id = ?, reference = ?, note = ?
            WHERE id = ?`,
          [
            docDate,
            input.locationId,
            input.reasonId ?? null,
            input.reference?.trim()?.slice(0, 60) || null,
            input.note?.trim()?.slice(0, 400) || null,
            adjustmentId,
          ] as never,
        )
        await tx.execute('DELETE FROM stock_adjustment_lines WHERE adjustment_id = ?', [
          adjustmentId,
        ] as never)
      } else {
        const [res] = await tx.execute(
          `INSERT INTO stock_adjustments
             (document_date, location_id, status, reason_id, reference, note, user_id, user_name)
           VALUES (?,?, 'draft', ?,?,?,?,?)`,
          [
            docDate,
            input.locationId,
            input.reasonId ?? null,
            input.reference?.trim()?.slice(0, 60) || null,
            input.note?.trim()?.slice(0, 400) || null,
            actor.userId,
            actor.userName.slice(0, 120),
          ] as never,
        )
        adjustmentId = (res as { insertId: number }).insertId
      }

      for (const [index, line] of lines.entries()) {
        await tx.execute(
          `INSERT INTO stock_adjustment_lines
             (adjustment_id, line_number, product_id, product_code, description,
              qty_before, qty_change, unit_cost_excl, reason_id, serial_ids, note)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [
            adjustmentId,
            index + 1,
            line.productId,
            line.productCode ?? null,
            line.description.trim().slice(0, 190),
            round(line.qtyBefore ?? 0, 3).toFixed(3),
            round(line.qtyChange, 3).toFixed(3),
            round(line.unitCostExcl ?? 0, 4).toFixed(4),
            line.reasonId ?? null,
            line.serialIds && line.serialIds.length > 0 ? JSON.stringify([...line.serialIds]) : null,
            line.note?.trim()?.slice(0, 190) || null,
          ] as never,
        )
      }

      return { ok: true as const, id: adjustmentId }
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The adjustment could not be saved.',
    }
  }
}

/** Removes a draft outright. A posted document is cancelled, never deleted. */
export async function deleteAdjustment(
  siteId: number,
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT status FROM stock_adjustments WHERE id = ?', [
    id,
  ])
  if (!row) return { ok: false, error: 'That adjustment no longer exists.' }
  if (String(row.status) !== 'draft') {
    return { ok: false, error: 'Only a draft adjustment can be deleted. Cancel it instead.' }
  }
  await siteExecute(siteId, 'DELETE FROM stock_adjustments WHERE id = ?', [id])
  return { ok: true }
}

/* ── Serial units ────────────────────────────────────────────────────────── */

/**
 * Takes chosen units off the shelf, inside the caller's transaction.
 *
 * serials.ts has writeOffSerial(), but it takes a siteId and runs its own two
 * statements — a movement written here and a serial written there could not be
 * rolled back together, which is exactly the split that leaves invariant (S2)
 * broken with nothing to explain it. So the same two writes happen on `tx`.
 *
 * location_id goes NULL with the status, matching writeOffSerial(): a
 * written-off unit is not in a room, and leaving it pointing at one would have
 * the per-location serial reconciliation expect a pile that no longer holds it.
 */
async function writeOffSerialsTx(
  tx: PoolConnection,
  actor: Actor,
  input: {
    productId: number
    locationId: number
    serialIds: readonly number[]
    adjustmentId: number
    lineLabel: string
    note: string
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.serialIds.length === 0) return { ok: true }

  const placeholders = input.serialIds.map(() => '?').join(',')
  const [rows] = await tx.execute(
    `SELECT id, serial, status, location_id
       FROM product_serials
      WHERE id IN (${placeholders}) AND product_id = ?
      FOR UPDATE`,
    [...input.serialIds, input.productId] as never,
  )
  const found = rows as Row[]

  if (found.length !== input.serialIds.length) {
    return {
      ok: false,
      error: `${input.lineLabel}: one of the chosen serial numbers is no longer on this product.`,
    }
  }
  const notHere = found.find(
    (s) => String(s.status) !== 'in_stock' || Number(s.location_id) !== input.locationId,
  )
  if (notHere) {
    return {
      ok: false,
      error: `${input.lineLabel}: serial ${String(notHere.serial)} is not in stock in this location.`,
    }
  }

  await tx.execute(
    `UPDATE product_serials
        SET status = 'written_off', location_id = NULL, note = ?
      WHERE id IN (${placeholders})`,
    [input.note.slice(0, 190), ...input.serialIds] as never,
  )

  for (const serialId of input.serialIds) {
    await tx.execute(
      `INSERT INTO serial_movements
         (serial_id, action, document_id, from_location_id, user_id, user_name, note)
       VALUES (?, 'written_off', ?, ?, ?, ?, ?)`,
      [
        serialId,
        input.adjustmentId,
        input.locationId,
        actor.userId,
        actor.userName.slice(0, 120),
        input.note.slice(0, 190),
      ] as never,
    )
  }

  return { ok: true }
}

/** Puts written-off units back, for a cancellation. The exact inverse. */
async function restoreSerialsTx(
  tx: PoolConnection,
  actor: Actor,
  input: {
    serialIds: readonly number[]
    locationId: number
    adjustmentId: number
    note: string
  },
): Promise<void> {
  if (input.serialIds.length === 0) return

  const placeholders = input.serialIds.map(() => '?').join(',')
  await tx.execute(
    `UPDATE product_serials
        SET status = 'in_stock', location_id = ?, note = NULL
      WHERE id IN (${placeholders}) AND status = 'written_off'`,
    [input.locationId, ...input.serialIds] as never,
  )

  for (const serialId of input.serialIds) {
    await tx.execute(
      `INSERT INTO serial_movements
         (serial_id, action, document_id, to_location_id, user_id, user_name, note)
       VALUES (?, 'adjusted', ?, ?, ?, ?, ?)`,
      [
        serialId,
        input.adjustmentId,
        input.locationId,
        actor.userId,
        actor.userName.slice(0, 120),
        input.note.slice(0, 190),
      ] as never,
    )
  }
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

/**
 * Posts a draft: one movement per line, all in one transaction.
 *
 * ── THE ORDER OF WORK, AND WHY ─────────────────────────────────────────────
 *
 * 1. Every line is validated and its pile locked FOR UPDATE **before anything is
 *    written**, so a refusal leaves no half-posted document behind.
 * 2. Lines are handled in product id order, so two adjustments touching the same
 *    products queue rather than deadlock. Same rule as postStockTake.
 * 3. Movements through recordMovement(), the only legal way to move stock.
 * 4. The document number LAST, immediately before commit — it takes a row lock
 *    held until COMMIT, and allocating it early would serialise every other
 *    document in the system behind this one.
 *
 * ── WHY IT REFUSES TO DRIVE A PILE NEGATIVE ────────────────────────────────
 *
 * A sale may take a pile negative: a till that refuses to sell what is in the
 * customer's hand is worse than a figure that needs correcting. An adjustment
 * has no such excuse — nobody is waiting, and writing off 10 from a room holding
 * 3 records goods that were never there. Same reasoning as postTransfer.
 */
export async function postAdjustment(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<PostResult> {
  const adjustment = await getAdjustment(siteId, id)
  if (!adjustment) return { ok: false, error: 'That adjustment no longer exists.' }
  if (adjustment.status === 'posted') return { ok: false, error: 'That adjustment is already posted.' }
  if (adjustment.status === 'cancelled') return { ok: false, error: 'That adjustment was cancelled.' }
  if (adjustment.lines.length === 0) return { ok: false, error: 'This adjustment has no lines.' }

  if (await isPeriodLocked(siteId, adjustment.documentDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  const location = await siteQueryOne<Row>(
    siteId,
    'SELECT id, name, is_active FROM stock_locations WHERE id = ?',
    [adjustment.locationId],
  )
  if (!location) return { ok: false, error: 'That location no longer exists.' }
  if (!location.is_active) {
    return {
      ok: false,
      error: `${String(location.name)} is deactivated. Activate it before adjusting stock in it.`,
    }
  }

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      const ordered = [...adjustment.lines].sort((a, b) => a.productId - b.productId)

      // ── Pass one: check everything, write nothing ──────────────────────
      const checked: { line: AdjustmentLine; before: number; cost: number; isSerial: boolean }[] = []

      for (const line of ordered) {
        const [rows] = await tx.execute(
          `SELECT COALESCE(pls.stock_on_hand, 0) AS on_hand,
                  COALESCE(NULLIF(p.average_cost, 0), p.last_cost, 0) AS cost,
                  p.code, p.has_variants, p.product_type
             FROM products p
             LEFT JOIN product_location_stock pls
                    ON pls.product_id = p.id AND pls.location_id = ?
            WHERE p.id = ?
            FOR UPDATE`,
          [adjustment.locationId, line.productId] as never,
        )
        const row = (rows as Row[])[0]
        const label = line.productCode ?? line.description
        if (!row) return { ok: false as const, error: `${label} no longer exists.` }

        // recordMovement refuses a parent anyway; refusing here names the
        // product instead of failing halfway with a generic message.
        if (Number(row.has_variants) === 1) {
          return {
            ok: false as const,
            error: `${label} now has variants — adjust the variants instead.`,
          }
        }

        const before = toNum(row.on_hand)
        const qty = round(line.qtyChange, 3)
        if (round(before + qty, 3) < 0) {
          return {
            ok: false as const,
            error: `${label} has only ${before} in ${adjustment.locationName} — ${Math.abs(qty)} cannot be written off.`,
          }
        }

        const isSerial = String(row.product_type) === 'serial'
        if (isSerial) {
          /*
           * A write-ON of a serial product would have to invent unit numbers,
           * and a unit nobody has scanned is not a unit. The document that
           * handles found serials is the stock take, whose count sheet takes
           * the scans and reconciles them — so this points there rather than
           * creating serials from thin air.
           */
          if (qty > 0) {
            return {
              ok: false as const,
              error: `${label} is serial-tracked, so units cannot be written on here — count them on a stock take, which records the serial numbers found.`,
            }
          }
          if (line.serials.length !== Math.abs(qty)) {
            return {
              ok: false as const,
              error: `${label} is serial-tracked — choose exactly ${Math.abs(qty)} serial number${Math.abs(qty) === 1 ? '' : 's'} to write off.`,
            }
          }
        }

        const cost = line.unitCostExcl > 0 ? line.unitCostExcl : toNum(row.cost)
        checked.push({ line, before, cost, isSerial })
      }

      // ── Pass two: write ────────────────────────────────────────────────
      let movements = 0
      let netQty = 0
      let netValue = 0

      for (const { line, before, cost, isSerial } of checked) {
        const qty = round(line.qtyChange, 3)
        const reasonLabel = line.reasonName ?? adjustment.reasonName ?? 'Stock adjustment'

        if (isSerial) {
          const written = await writeOffSerialsTx(tx, actor, {
            productId: line.productId,
            locationId: adjustment.locationId,
            serialIds: line.serials,
            adjustmentId: adjustment.id,
            lineLabel: line.productCode ?? line.description,
            note: reasonLabel,
          })
          if (!written.ok) return { ok: false as const, error: written.error }
        }

        const movementId = await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: adjustment.locationId,
          movementType: 'adjustment',
          qtyChange: qty,
          unitCostExcl: cost,
          source: 'stock_adjustment',
          sourceDocId: adjustment.id,
          sourceLineId: line.id,
          note: reasonLabel.slice(0, 190),
        })

        await tx.execute(
          `UPDATE stock_adjustment_lines
              SET qty_before = ?, unit_cost_excl = ?, movement_id = ?
            WHERE id = ?`,
          [before.toFixed(3), cost.toFixed(4), movementId, line.id] as never,
        )

        // The column 001 reserved for exactly this. NOW() rather than the
        // document date: it is a DATETIME recording when the event happened,
        // like last_sold_date and last_purchase_date beside it.
        await tx.execute('UPDATE products SET last_adjust_date = NOW() WHERE id = ?', [
          line.productId,
        ] as never)

        movements += 1
        netQty = round(netQty + qty, 3)
        netValue = round(netValue + qty * cost, 4)
      }

      // Last write before commit. See the header.
      const documentNumber = await nextDocumentNumber(tx, 'stock_adjustment')

      await tx.execute(
        `UPDATE stock_adjustments
            SET status = 'posted', document_number = ?, posted_at = NOW(),
                variance_qty = ?, variance_value = ?
          WHERE id = ?`,
        [documentNumber, netQty.toFixed(3), netValue.toFixed(4), adjustment.id] as never,
      )

      return {
        ok: true as const,
        id: adjustment.id,
        documentNumber,
        movements,
        varianceValue: netValue,
      }
    })

    /*
     * The ledger entry is written AFTER the stock transaction commits, never
     * inside it. The stock genuinely moved whether or not anyone has mapped an
     * account for it, and a chart-of-accounts gap must not roll back a completed
     * adjustment. mirrorStockAdjustment swallows its own failure into a logged
     * reason, which ledgerHealth() then surfaces.
     */
    if (result.ok && Math.abs(result.varianceValue) >= 0.005) {
      await mirrorStockAdjustment(siteId, actor, {
        adjustmentId: adjustment.id,
        documentNumber: result.documentNumber,
        documentDate: adjustment.documentDate,
        varianceValue: result.varianceValue,
      })
    }

    return result
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The adjustment could not be posted.',
    }
  }
}

/**
 * Creates a draft and posts it in one call, for the capture screen.
 *
 * Deliberately TWO transactions rather than one long one. If the post is
 * refused — an overdrawn pile, a locked period — the capture survives as a draft
 * the person can fix and post, instead of a screenful of typing disappearing
 * with the error message.
 */
export async function postNewAdjustment(
  siteId: number,
  actor: Actor,
  input: AdjustmentInput,
): Promise<PostResult> {
  const saved = await saveAdjustment(siteId, actor, input)
  if (!saved.ok) return saved

  const posted = await postAdjustment(siteId, actor, saved.id)
  if (!posted.ok) {
    return {
      ok: false,
      error: `${posted.error} It has been kept as a draft so nothing you captured is lost.`,
    }
  }
  return posted
}

/**
 * Reverses a posted adjustment.
 *
 * Writes the exact inverse movement per line, at the cost the original was
 * valued at — never by deleting the movement rows. The stock genuinely was
 * written on or off, and erasing that would leave a pile whose history does not
 * explain it. Same reasoning as voiding a receipt or cancelling a count.
 *
 * A DRAFT is simply stamped: it moved nothing, so there is nothing to reverse.
 */
export async function cancelAdjustment(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason.trim()) return { ok: false, error: 'A reason is required to cancel an adjustment.' }

  const adjustment = await getAdjustment(siteId, id)
  if (!adjustment) return { ok: false, error: 'That adjustment no longer exists.' }
  if (adjustment.status === 'cancelled') {
    return { ok: false, error: 'That adjustment is already cancelled.' }
  }

  if (adjustment.status === 'draft') {
    await siteExecute(
      siteId,
      `UPDATE stock_adjustments
          SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW()
        WHERE id = ?`,
      [reason.trim().slice(0, 190), id],
    )
    return { ok: true }
  }

  if (await isPeriodLocked(siteId, adjustment.documentDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      const ordered = [...adjustment.lines].sort((a, b) => a.productId - b.productId)

      // Check every pile first, so a refusal leaves the document untouched.
      for (const line of ordered) {
        const [rows] = await tx.execute(
          `SELECT COALESCE(stock_on_hand, 0) AS on_hand
             FROM product_location_stock
            WHERE product_id = ? AND location_id = ?
            FOR UPDATE`,
          [line.productId, adjustment.locationId] as never,
        )
        const before = toNum((rows as Row[])[0]?.on_hand)
        // Reversing a write-ON takes stock back out, which can only be done if
        // it is still there. A write-OFF being reversed puts stock back and can
        // never be refused for this reason.
        if (round(before - line.qtyChange, 3) < 0) {
          return {
            ok: false as const,
            error: `${line.productCode ?? line.description} has only ${before} left in ${adjustment.locationName} — this adjustment can no longer be reversed.`,
          }
        }
      }

      for (const line of ordered) {
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: adjustment.locationId,
          movementType: 'adjustment',
          qtyChange: round(-line.qtyChange, 3),
          unitCostExcl: line.unitCostExcl,
          source: 'stock_adjust_cancel',
          sourceDocId: adjustment.id,
          sourceLineId: line.id,
          note: `Cancel of ${adjustment.documentNumber ?? `#${adjustment.id}`}`,
        })

        // The units come back with the quantity, or the pile would be right
        // while every unit still read as written off.
        if (line.serials.length > 0) {
          await restoreSerialsTx(tx, actor, {
            serialIds: line.serials,
            locationId: adjustment.locationId,
            adjustmentId: adjustment.id,
            note: `Cancel of ${adjustment.documentNumber ?? `#${adjustment.id}`}`,
          })
        }
      }

      await tx.execute(
        `UPDATE stock_adjustments
            SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW()
          WHERE id = ?`,
        [reason.trim().slice(0, 190), adjustment.id] as never,
      )

      return { ok: true as const }
    })

    // The mirror image of the posting journal, and fail-soft for the same
    // reason: the reversal is true whether or not the accounts are mapped.
    if (result.ok && Math.abs(adjustment.varianceValue) >= 0.005) {
      await mirrorStockAdjustment(siteId, actor, {
        adjustmentId: adjustment.id,
        documentNumber: adjustment.documentNumber,
        documentDate: adjustment.documentDate,
        varianceValue: adjustment.varianceValue,
        isReversal: true,
      })
    }

    return result
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The adjustment could not be cancelled.',
    }
  }
}

/* ── Reading stock for the capture screen ────────────────────────────────── */

export type LocationPile = {
  productId: number
  onHand: number
  averageCost: number
  productType: string
  hasVariants: boolean
}

/**
 * What a location holds for a set of products, for the capture grid.
 *
 * One query for the whole screen rather than one per line — the same reasoning
 * as reservedQtyFor(). A product with no pile in this location is absent from
 * the map, and the caller reads a missing key as zero.
 */
export async function pilesFor(
  siteId: number,
  locationId: number,
  productIds: readonly number[],
): Promise<Map<number, LocationPile>> {
  const ids = [...new Set(productIds)].filter((n) => Number.isFinite(n) && n > 0)
  if (ids.length === 0) return new Map()

  const placeholders = ids.map(() => '?').join(',')
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id,
            COALESCE(pls.stock_on_hand, 0)                      AS on_hand,
            COALESCE(NULLIF(p.average_cost, 0), p.last_cost, 0) AS cost,
            p.product_type, p.has_variants
       FROM products p
       LEFT JOIN product_location_stock pls
              ON pls.product_id = p.id AND pls.location_id = ?
      WHERE p.id IN (${placeholders})`,
    [locationId, ...ids],
  )

  return new Map(
    rows.map((r) => [
      Number(r.id),
      {
        productId: Number(r.id),
        onHand: toNum(r.on_hand),
        averageCost: toNum(r.cost),
        productType: String(r.product_type),
        hasVariants: Number(r.has_variants) === 1,
      },
    ]),
  )
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type AdjustmentDrift = {
  adjustmentId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  moved: number
}

/**
 * Posted lines whose movement does not match the line.
 *
 * The check that would catch a half-written adjustment. Reports rather than
 * repairs, like every other reconciliation here — silently correcting a drift
 * hides whatever caused it.
 */
export async function reconcileAdjustments(siteId: number): Promise<AdjustmentDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.id AS adjustment_id, a.document_number,
            l.product_id, l.product_code, l.qty_change AS expected,
            COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m
                       WHERE m.source = 'stock_adjustment'
                         AND m.source_doc_id = a.id
                         AND m.source_line_id = l.id), 0) AS moved
       FROM stock_adjustments a
       JOIN stock_adjustment_lines l ON l.adjustment_id = a.id
      WHERE a.status = 'posted'
     HAVING ABS(expected - moved) > 0.0005`,
  )

  return rows.map((r) => ({
    adjustmentId: Number(r.adjustment_id),
    documentNumber: (r.document_number as string | null) ?? null,
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    expected: toNum(r.expected),
    moved: toNum(r.moved),
  }))
}
