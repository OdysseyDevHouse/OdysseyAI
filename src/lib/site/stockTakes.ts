import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { stockedReferSql } from './productComposition'
import { guardPosting } from './periodLocks'
import { offlineExceptionCounts } from './offlineExceptions'
import { countSerialsTx } from './serials'
import { getNumericSetting } from './settings'
import { mirrorStockTake } from './glPosting'
import type { Actor } from './activityLog'

/**
 * Counting what is on the shelf, and writing the difference.
 *
 * ── THE ONE PIECE OF ARITHMETIC THAT MATTERS ───────────────────────────────
 *
 * A sheet stores what the system believed when it was made (snapshot_qty). The
 * count happens later — an hour later, or a weekend later — while the till keeps
 * selling. So at post time there are two candidate differences:
 *
 *   counted - snapshot   what the person counting would call the difference
 *   counted - current    what must be written to make the pile match the shelf
 *
 * This module writes the SECOND, always. Posting the first would leave the pile
 * disagreeing with the count sheet the instant anything sold mid-count, which is
 * precisely the outcome a stock take exists to prevent. Both figures are kept:
 * the first is the variance a manager reads, the second is the movement.
 *
 * ── IT IS NOT A SECOND WRITER OF COST ──────────────────────────────────────
 *
 * Found stock is valued at the average_cost the product already carries. A count
 * is a statement about QUANTITY. GRV posting remains the only thing in the
 * application that writes average_cost — the same rule purchaseReversal refuses
 * to weaken when it declines to unwind an average on a void.
 *
 * ── ZERO-VARIANCE LINES WRITE NOTHING ──────────────────────────────────────
 *
 * A full-store count of 4,000 products with 12 discrepancies writes 12 movement
 * rows, not 4,000. A movement of zero is noise in the one table people read to
 * answer "what happened to this product", and stock_movements is that table.
 */

export type StockTakeStatus = 'draft' | 'counting' | 'posted' | 'cancelled'
export type StockTakeScope = 'full' | 'department' | 'brand' | 'supplier' | 'manual'
export type LineMode = 'count' | 'topup' | 'recount'

/**
 * Product types that carry no pile and must never appear on a count sheet.
 *
 *   service  — carries no stock on hand, always zero
 *   refer    — sells THROUGH to another product, which holds the stock
 *   buyout   — bought per order, never kept
 *   recipe   — derives from its components; counting it would double-count them
 *
 * Listed here rather than inferred, because a new product type should have to
 * decide deliberately whether it is countable.
 *
 * `refer` has ONE exception, and it is not a type: a refer product on a
 * normal-method link owns its pack for real — ten cases of beer are ten cases
 * on a shelf, and a count sheet that skipped them would reconcile against
 * stock it cannot see. stockedReferSql() adds those back. See
 * 103_refer_methods.sql.
 */
const NON_STOCKED_TYPES = ['service', 'refer', 'buyout', 'recipe'] as const

/**
 * The most lines one sheet may carry.
 *
 * Not a technical limit — it is a statement about what a stock take IS. A real
 * catalogue on this dev site produces 40,062 countable products, and a single
 * sheet holding all of them is not a document anybody counts: it is a
 * two-week job with no way to hand a section to somebody else, no way to post
 * the part that is finished, and a screen that has to render 40,000 live inputs.
 *
 * Refusing at creation, with the scopes that would cut it down, is far kinder
 * than accepting it and producing a sheet that cannot be worked.
 */
export const MAX_SHEET_LINES = 5000

export type StockTakeLine = {
  id: number
  productId: number
  productCode: string | null
  description: string
  productType: string
  lineMode: LineMode
  snapshotQty: number
  /** NULL means NOT YET COUNTED, which is not the same fact as counted-as-zero. */
  countedQty: number | null
  enteredQty: number | null
  postedQtyBefore: number | null
  varianceQty: number | null
  unitCostExcl: number
  /**
   * The serial numbers found on the shelf, as scanned.
   *
   * STRINGS, not ids, and that is the whole point: a counter holds a scanner
   * pointed at a label, and a unit that turns up which the system has never
   * heard of has no id to record. Resolving each one to a row is countSerialsTx's
   * job at post time, where "not on file" is a legitimate outcome rather than a
   * lookup failure.
   */
  serials: string[] | null
  countedAt: Date | null
  countedBy: string | null
  note: string | null
  movementId: number | null

  /* ── Sign-off, for a line whose variance crosses a threshold (218) ───── */
  /**
   * Who agreed this variance is real, and when.
   *
   * NULL on the overwhelming majority of lines and always NULL when the
   * thresholds are off. A line is only ever flagged, and therefore only ever
   * approved, by crossing a line the owner drew deliberately.
   */
  approvedBy: string | null
  approvedAt: Date | null
  approvalReasonId: number | null
  approvalNote: string | null

  /* ── Variant grouping, for the sheet's benefit only ─────────────────── */
  /**
   * The parent this line's product belongs to, when it is a variant.
   *
   * Presentation only: the line counts an ordinary product and posts exactly as
   * any other does. It exists so the sheet can put a shirt's five sizes under
   * one heading instead of scattering five unrelated-looking rows through the
   * catalogue — see the count sheet for why that matters on a shelf.
   */
  parentId: number | null
  parentDescription: string | null
  /** What this variant is — "Large", "Blue". Empty on an ordinary product. */
  axis1: string
  axis2: string
}

export type StockTake = {
  id: number
  documentNumber: string | null
  documentDate: string
  locationId: number
  locationCode: string
  locationName: string
  status: StockTakeStatus
  scope: StockTakeScope
  scopeRefId: number | null
  /**
   * Whether the counter is shown what the system believes (218).
   *
   * Read by the GRID, and only while the sheet is still being counted. A
   * posted sheet always shows both figures — blindness protects the count, and
   * once the count is committed there is nothing left to bias.
   */
  isBlind: boolean
  /** The cycle-count programme that generated this sheet, if any (145). */
  programmeId: number | null
  reference: string | null
  note: string | null
  frozenAt: Date | null
  postedAt: Date | null
  cancelledAt: Date | null
  cancelReason: string | null
  varianceQty: number
  varianceValue: number
  userName: string
  lines: StockTakeLine[]
  /** For a list that does not load the lines. */
  lineCount: number
  countedCount: number
}

type Row = RowDataPacket & Record<string, unknown>

function parseSerials(value: unknown): string[] | null {
  if (value === null || value === undefined) return null
  try {
    // mysql2 hands back a JSON column already parsed on some driver versions and
    // as a string on others. Both shapes reach here, so both are handled.
    const raw = typeof value === 'string' ? JSON.parse(value) : value
    if (!Array.isArray(raw)) return null
    const serials = raw.map((v) => String(v).trim()).filter((s) => s.length > 0)
    return serials.length > 0 ? serials : null
  } catch {
    return null
  }
}

function mapLine(r: Row): StockTakeLine {
  return {
    id: Number(r.id),
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    description: String(r.description),
    productType: String(r.product_type ?? 'normal'),
    lineMode: String(r.line_mode) as LineMode,
    snapshotQty: toNum(r.snapshot_qty),
    countedQty: r.counted_qty === null || r.counted_qty === undefined ? null : toNum(r.counted_qty),
    enteredQty: r.entered_qty === null || r.entered_qty === undefined ? null : toNum(r.entered_qty),
    postedQtyBefore:
      r.posted_qty_before === null || r.posted_qty_before === undefined
        ? null
        : toNum(r.posted_qty_before),
    varianceQty:
      r.variance_qty === null || r.variance_qty === undefined ? null : toNum(r.variance_qty),
    unitCostExcl: toNum(r.unit_cost_excl),
    serials: parseSerials(r.serial_ids),
    countedAt: (r.counted_at as Date | null) ?? null,
    countedBy: (r.counted_by as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    movementId: r.movement_id === null || r.movement_id === undefined ? null : Number(r.movement_id),

    approvedBy: (r.approved_by as string | null) ?? null,
    approvedAt: (r.approved_at as Date | null) ?? null,
    approvalReasonId:
      r.approval_reason_id === null || r.approval_reason_id === undefined
        ? null
        : Number(r.approval_reason_id),
    approvalNote: (r.approval_note as string | null) ?? null,

    parentId: r.parent_id === null || r.parent_id === undefined ? null : Number(r.parent_id),
    parentDescription: (r.parent_description as string | null) ?? null,
    axis1: String(r.axis_1_value ?? ''),
    axis2: String(r.axis_2_value ?? ''),
  }
}

function mapTake(r: Row, lines: StockTakeLine[] = []): StockTake {
  return {
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date).slice(0, 10),
    locationId: Number(r.location_id),
    locationCode: String(r.location_code ?? ''),
    locationName: String(r.location_name ?? ''),
    status: String(r.status) as StockTakeStatus,
    scope: String(r.scope) as StockTakeScope,
    scopeRefId: r.scope_ref_id === null || r.scope_ref_id === undefined ? null : Number(r.scope_ref_id),
    isBlind: Number(r.is_blind ?? 0) === 1,
    programmeId:
      r.programme_id === null || r.programme_id === undefined ? null : Number(r.programme_id),
    reference: (r.reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    frozenAt: (r.frozen_at as Date | null) ?? null,
    postedAt: (r.posted_at as Date | null) ?? null,
    cancelledAt: (r.cancelled_at as Date | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    varianceQty: toNum(r.variance_qty),
    varianceValue: toNum(r.variance_value),
    userName: String(r.user_name ?? ''),
    lines,
    lineCount: Number(r.line_count ?? lines.length),
    countedCount: Number(r.counted_count ?? lines.filter((l) => l.countedQty !== null).length),
  }
}

const SELECT_TAKE = `
  SELECT t.id, t.document_number, t.document_date, t.location_id, t.status,
         t.scope, t.scope_ref_id, t.is_blind, t.programme_id, t.reference, t.note, t.frozen_at,
         t.posted_at, t.cancelled_at,
         t.cancel_reason, t.variance_qty, t.variance_value, t.user_name,
         l.code AS location_code, l.name AS location_name,
         (SELECT COUNT(*) FROM stock_take_lines s WHERE s.stock_take_id = t.id) AS line_count,
         (SELECT COUNT(*) FROM stock_take_lines s
           WHERE s.stock_take_id = t.id AND s.counted_qty IS NOT NULL)          AS counted_count
    FROM stock_takes t
    JOIN stock_locations l ON l.id = t.location_id
`

export async function listStockTakes(
  siteId: number,
  opts: { status?: StockTakeStatus | 'all'; locationId?: number; limit?: number } = {},
): Promise<StockTake[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const clauses: string[] = []
  const params: (string | number)[] = []

  if (opts.status && opts.status !== 'all') {
    clauses.push('t.status = ?')
    params.push(opts.status)
  }
  if (opts.locationId) {
    clauses.push('t.location_id = ?')
    params.push(opts.locationId)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_TAKE} ${where} ORDER BY t.document_date DESC, t.id DESC LIMIT ${limit}`,
    params,
  )
  return rows.map((r) => mapTake(r))
}

/**
 * One sheet and every line on it.
 *
 * Deliberately UNCAPPED, unlike every other list query here. postStockTake
 * reads its lines from this, so a LIMIT would silently post part of a sheet and
 * leave the rest counted-but-unposted with nothing saying so. The bound that
 * makes that safe is MAX_SHEET_LINES, applied when the sheet is created.
 */
export async function getStockTake(siteId: number, id: number): Promise<StockTake | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TAKE} WHERE t.id = ? LIMIT 1`, [id])
  if (!row) return null

  const lineRows = await siteQuery<Row>(
    siteId,
    /*
     * The parent join is presentation only — see StockTakeLine.parentId.
     *
     * line_number still decides the order, and buildSheetLines already emits a
     * group's variants consecutively and in picker order, so a sheet reads
     * down the shelf. Sorting here instead would re-order a sheet that has
     * already been printed and half counted.
     */
    `SELECT s.id, s.product_id, s.product_code, s.description, s.line_mode,
            s.snapshot_qty, s.counted_qty, s.entered_qty, s.posted_qty_before,
            s.variance_qty, s.unit_cost_excl, s.serial_ids, s.counted_at,
            s.counted_by, s.note, s.movement_id,
            s.approved_by, s.approved_at, s.approval_reason_id, s.approval_note,
            p.product_type,
            p.parent_id, p.axis_1_value, p.axis_2_value,
            parent.description AS parent_description
       FROM stock_take_lines s
       JOIN products p ON p.id = s.product_id
       LEFT JOIN products parent ON parent.id = p.parent_id
      WHERE s.stock_take_id = ?
      ORDER BY s.line_number ASC, s.id ASC`,
    [id],
  )

  return mapTake(row, lineRows.map(mapLine))
}

/* ── Creating a sheet ─────────────────────────────────────────────────────── */

export type StockTakeInput = {
  locationId: number
  documentDate?: string
  scope: StockTakeScope
  scopeRefId?: number | null
  reference?: string | null
  note?: string | null
  /** For scope 'manual' — the exact products to count. */
  productIds?: readonly number[]
  /** The cycle-count programme that generated this sheet (145). */
  programmeId?: number | null
  /**
   * Hide what the system believes while this sheet is counted (218).
   *
   * Off by default, so nothing about an existing workflow changes until
   * somebody asks for it. Chosen per sheet because a shrinkage count and a
   * stockroom reconciliation are different jobs — see the header of 218.
   */
  isBlind?: boolean
  /** Include products whose pile is zero. Off by default; see buildSheetLines. */
  includeZeroStock?: boolean
  /**
   * What every line on the new sheet is called.
   *
   * Only recountStockTake passes this. It is stored per line so the grid can
   * badge a second pass, and so the history says which counts were somebody
   * checking a figure they did not believe.
   */
  lineMode?: LineMode
}

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Validates a sheet without touching the database.
 *
 * Kept separate so the screen can refuse the same things for the same reasons
 * before anyone clicks create.
 */
export function validateStockTake(input: StockTakeInput): string | null {
  if (!input.locationId) return 'Choose which location is being counted.'
  if (input.scope === 'manual' && (input.productIds?.length ?? 0) === 0) {
    return 'Add at least one product to count.'
  }
  if (input.scope !== 'full' && input.scope !== 'manual' && !input.scopeRefId) {
    return `Choose which ${input.scope} to count.`
  }
  return null
}

/**
 * The snapshot query.
 *
 * Three exclusions, each of which would otherwise produce a sheet that cannot be
 * posted or a variance that is not real:
 *
 *   · variant PARENTS — recordMovement refuses them outright, so a parent on a
 *     sheet is a line that can never post. The children are included instead.
 *   · non-stocked types — a service has no pile to count.
 *   · archived products — they are out of the catalogue.
 *
 * The join to product_location_stock is a LEFT JOIN and the zero-pile filter is
 * opt-in, because a product that has drifted to a pile of nothing is exactly what
 * a count needs to surface. Defaulting it OFF keeps a full-store sheet down to
 * what is plausibly on a shelf rather than every product ever created.
 */
async function buildSheetLines(
  tx: PoolConnection,
  input: StockTakeInput,
): Promise<Array<{ productId: number; code: string | null; description: string; qty: number; cost: number }>> {
  const clauses: string[] = [
    'p.is_archived = 0',
    'p.has_variants = 0',
    `(p.product_type NOT IN (${NON_STOCKED_TYPES.map(() => '?').join(',')}) OR ${stockedReferSql('p')})`,
  ]
  const params: (string | number)[] = [...NON_STOCKED_TYPES]

  if (input.scope === 'department') {
    clauses.push('p.department_id = ?')
    params.push(input.scopeRefId!)
  } else if (input.scope === 'brand') {
    clauses.push('p.brand_id = ?')
    params.push(input.scopeRefId!)
  } else if (input.scope === 'supplier') {
    clauses.push('EXISTS (SELECT 1 FROM product_suppliers ps WHERE ps.product_id = p.id AND ps.supplier_id = ?)')
    params.push(input.scopeRefId!)
  } else if (input.scope === 'manual') {
    const ids = input.productIds ?? []
    clauses.push(`p.id IN (${ids.map(() => '?').join(',')})`)
    params.push(...ids)
  }

  // Opt-in, and deliberately not applied to a manual sheet: if someone named a
  // product explicitly, they mean to count it whatever its pile says.
  if (!input.includeZeroStock && input.scope !== 'manual') {
    clauses.push('COALESCE(pls.stock_on_hand, 0) <> 0')
  }

  /*
   * A group's variants land together, in the order the shelf is stacked.
   *
   * The rows are otherwise ordered by code, which scatters a shirt's five sizes
   * through the sheet whenever their codes are not sequential — and codes very
   * often are not. Someone counting then walks past the same shelf five times.
   *
   * So a variant sorts under its PARENT's code, then by variant_sort — the
   * order the picker uses, because sizes are not alphabetical (Large, Medium,
   * Small is not a shelf). An ordinary product sorts by its own code, exactly
   * as before, and the two interleave on one key.
   *
   * This is a sheet-BUILD decision, so it is fixed in line_number at creation.
   * A printed sheet and the screen then always agree, however the catalogue is
   * reorganised afterwards.
   */
  const [rows] = await tx.execute(
    `SELECT p.id, p.code, p.description,
            COALESCE(pls.stock_on_hand, 0) AS on_hand,
            COALESCE(NULLIF(p.average_cost, 0), p.last_cost, 0) AS cost
       FROM products p
       LEFT JOIN product_location_stock pls
              ON pls.product_id = p.id AND pls.location_id = ?
       LEFT JOIN products parent ON parent.id = p.parent_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY COALESCE(parent.code, p.code) ASC,
               p.parent_id IS NOT NULL,
               p.variant_sort ASC, p.axis_1_value ASC, p.axis_2_value ASC,
               p.code ASC, p.id ASC`,
    [input.locationId, ...params] as never,
  )

  return (rows as Row[]).map((r) => ({
    productId: Number(r.id),
    code: (r.code as string | null) ?? null,
    description: String(r.description ?? ''),
    qty: toNum(r.on_hand),
    cost: toNum(r.cost),
  }))
}

export type CreateResult = { ok: true; id: number; lineCount: number } | { ok: false; error: string }

export async function createStockTake(
  siteId: number,
  actor: Actor,
  input: StockTakeInput,
): Promise<CreateResult> {
  const invalid = validateStockTake(input)
  if (invalid) return { ok: false, error: invalid }

  const docDate = input.documentDate ?? todayIso()

  try {
    return await siteTransaction(siteId, async (tx) => {
      const [locRows] = await tx.execute(
        'SELECT id, name, is_active FROM stock_locations WHERE id = ?',
        [input.locationId] as never,
      )
      const location = (locRows as Row[])[0]
      if (!location) return { ok: false as const, error: 'That location no longer exists.' }
      if (!Number(location.is_active)) {
        return {
          ok: false as const,
          error: `${String(location.name)} is deactivated. Activate it before counting it.`,
        }
      }

      const lines = await buildSheetLines(tx, input)
      if (lines.length === 0) {
        return {
          ok: false as const,
          error: 'Nothing to count — no stocked products matched that selection.',
        }
      }

      // Refused rather than truncated. A silently shortened sheet would look
      // complete and post a variance for products nobody went and looked at.
      //
      // The advice names a NARROWER scope than the one that failed, rather than
      // always saying "count a department": on a big catalogue a department can
      // itself be 20,000 products, and telling someone to do the thing that
      // will also fail is worse than saying nothing.
      if (lines.length > MAX_SHEET_LINES) {
        const narrower =
          input.scope === 'full'
            ? 'Count one department, brand or supplier at a time'
            : 'Narrow it further — a supplier within it, or pick the products by hand'
        return {
          ok: false as const,
          error:
            `That selection covers ${lines.length.toLocaleString()} products, which is more than ` +
            `one sheet can hold (${MAX_SHEET_LINES.toLocaleString()}). ${narrower}. Several ` +
            'sheets can run at once, and each one posts on its own.',
        }
      }

      // No document_number here. It is allocated at POST, so a draft that gets
      // deleted does not burn a number out of the sequence.
      const [res] = await tx.execute(
        `INSERT INTO stock_takes
           (document_date, location_id, status, scope, scope_ref_id, is_blind, programme_id, reference, note, user_id, user_name)
         VALUES (?,?, 'draft', ?,?,?,?,?,?,?,?)`,
        [
          docDate,
          input.locationId,
          input.scope,
          input.scopeRefId ?? null,
          input.isBlind ? 1 : 0,
          input.programmeId ?? null,
          input.reference?.trim()?.slice(0, 60) || null,
          input.note?.trim()?.slice(0, 400) || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      const takeId = (res as { insertId: number }).insertId

      // One multi-row insert rather than a statement per line: a full-store sheet
      // is thousands of rows and a round trip each would make creating a sheet
      // take longer than counting one aisle.
      const lineMode = input.lineMode ?? 'count'
      const CHUNK = 500
      for (let i = 0; i < lines.length; i += CHUNK) {
        const chunk = lines.slice(i, i + CHUNK)
        const values = chunk.map(() => '(?,?,?,?,?,?,?,?)').join(',')
        const params = chunk.flatMap((line, j) => [
          takeId,
          i + j + 1,
          line.productId,
          line.code,
          line.description.slice(0, 190),
          line.qty.toFixed(3),
          line.cost.toFixed(4),
          lineMode,
        ])
        await tx.execute(
          `INSERT INTO stock_take_lines
             (stock_take_id, line_number, product_id, product_code, description,
              snapshot_qty, unit_cost_excl, line_mode)
           VALUES ${values}`,
          params as never,
        )
      }

      return { ok: true as const, id: takeId, lineCount: lines.length }
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The stock take could not be created.',
    }
  }
}

/**
 * Builds a new sheet from a posted one's variance lines.
 *
 * ── WHY THIS IS A FIRST-CLASS ACTION ───────────────────────────────────────
 *
 * The realistic workflow is: count, look at the variances, disbelieve half of
 * them, count those again. Somebody who has to hand-build a second sheet by
 * re-typing forty product codes will instead accept a bad count, because the
 * checking is more work than the counting was. Making the second pass one click
 * is the difference between a module people use properly and one they use once.
 *
 * The new sheet snapshots the pile AS IT IS NOW, not as the first sheet left
 * it. That matters: the first sheet already posted its adjustments, so the pile
 * now agrees with what was counted. A recount that found the same figure again
 * therefore shows a variance of zero and writes nothing — which is exactly the
 * right outcome for confirming a count.
 *
 * Only lines that actually varied come across. A recount of the lines that were
 * already right is just the first sheet again.
 */
export async function recountStockTake(
  siteId: number,
  actor: Actor,
  takeId: number,
): Promise<CreateResult> {
  const take = await getStockTake(siteId, takeId)
  if (!take) return { ok: false, error: 'That stock take no longer exists.' }
  if (take.status !== 'posted') {
    return { ok: false, error: 'Only a posted stock take can be re-counted.' }
  }

  const varied = take.lines.filter(
    (l) => l.varianceQty !== null && Math.abs(l.varianceQty) > 0.0005,
  )
  if (varied.length === 0) {
    return {
      ok: false,
      error: 'Every line on that sheet matched, so there is nothing to re-count.',
    }
  }

  return createStockTake(siteId, actor, {
    locationId: take.locationId,
    scope: 'manual',
    productIds: varied.map((l) => l.productId),
    reference: take.reference,
    lineMode: 'recount',
    /*
     * A re-count inherits blindness, and would deserve it even if the first
     * sheet had not been blind.
     *
     * This is the pass where seeing the expected figure does the most damage:
     * the whole purpose of a second count is an independent answer, and a
     * counter shown the number that is already in dispute will confirm it.
     * Every count methodology calls for the recount specifically to be blind.
     */
    isBlind: take.isBlind,
    note: `Re-count of ${take.documentNumber ?? `#${takeId}`} — ${varied.length} line${varied.length === 1 ? '' : 's'} that differed.`,
    // No includeZeroStock needed: a manual sheet never applies the zero-pile
    // filter, which matters here because a line that varied may well now sit at
    // zero and is precisely the one somebody asked to check.
  })
}

/* ── Counting ────────────────────────────────────────────────────────────── */

export type CountEntry = {
  lineId: number
  /** The absolute counted figure, or null to clear the line back to uncounted. */
  countedQty?: number | null
  /** For a topup line — what to ADD. countedQty is derived from it at post. */
  enteredQty?: number | null
  lineMode?: LineMode
  /** For a serial line — every serial number found, as scanned. */
  serials?: readonly string[] | null
  note?: string | null
}

/**
 * Saves counts against lines.
 *
 * Accepts a batch because the grid autosaves as someone works down a shelf, and
 * one round trip per keystroke would make counting feel like filling in a form.
 *
 * Allowed while draft OR counting: freezing fixes the SNAPSHOT and the set of
 * lines, not the quantities. Someone has to be able to type into a frozen sheet
 * or freezing would end the count rather than start it.
 */
export async function saveCounts(
  siteId: number,
  actor: Actor,
  takeId: number,
  entries: readonly CountEntry[],
): Promise<{ ok: true; saved: number } | { ok: false; error: string }> {
  if (entries.length === 0) return { ok: true, saved: 0 }

  const take = await siteQueryOne<Row>(siteId, 'SELECT status FROM stock_takes WHERE id = ?', [
    takeId,
  ])
  if (!take) return { ok: false, error: 'That stock take no longer exists.' }
  const status = String(take.status)
  if (status !== 'draft' && status !== 'counting') {
    return { ok: false, error: `A ${status} stock take cannot be counted into.` }
  }

  for (const entry of entries) {
    const counted = entry.countedQty ?? null
    const entered = entry.enteredQty ?? null
    if (counted !== null && (!Number.isFinite(counted) || counted < 0)) {
      return { ok: false, error: 'A counted quantity cannot be negative.' }
    }
    if (entered !== null && !Number.isFinite(entered)) {
      return { ok: false, error: 'That top-up quantity is not a number.' }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    for (const entry of entries) {
      const counted = entry.countedQty ?? null
      const entered = entry.enteredQty ?? null
      // Clearing a line back to uncounted must also clear who counted it, or the
      // grid would show an empty quantity attributed to someone.
      const touched = counted !== null || entered !== null

      /*
       * Re-typing a count REVOKES its sign-off.
       *
       * A signature is against a specific figure. Somebody who approves "40
       * where the books said 400", then types 4, has approved a number that no
       * longer exists — and leaving the approval attached would post a variance
       * ten times larger than the one anybody agreed to. That is the exact
       * shape of a control that reads as enforced and is not.
       *
       * Cleared unconditionally rather than only when the figure changes.
       * Re-saving the same value costs one wasted signature; working out
       * whether a rounded decimal "really" changed is the kind of comparison
       * that is wrong once and then wrong silently for years.
       */
      await tx.execute(
        `UPDATE stock_take_lines
            SET counted_qty = ?,
                entered_qty = ?,
                line_mode   = COALESCE(?, line_mode),
                serial_ids  = ?,
                note        = COALESCE(?, note),
                counted_at  = ${touched ? 'NOW()' : 'NULL'},
                counted_by  = ?,
                approved_by_id     = NULL,
                approved_by        = NULL,
                approved_at        = NULL,
                approval_reason_id = NULL,
                approval_note      = NULL
          WHERE id = ? AND stock_take_id = ?`,
        [
          counted === null ? null : round(counted, 3).toFixed(3),
          entered === null ? null : round(entered, 3).toFixed(3),
          entry.lineMode ?? null,
          entry.serials && entry.serials.length > 0 ? JSON.stringify([...entry.serials]) : null,
          entry.note?.slice(0, 190) ?? null,
          touched ? actor.userName.slice(0, 120) : null,
          entry.lineId,
          takeId,
        ] as never,
      )
    }
  })

  return { ok: true, saved: entries.length }
}

/**
 * Freezes the sheet.
 *
 * Re-snapshots against the CURRENT pile first, so the baseline is what was true
 * when counting actually began rather than when the sheet was created — a sheet
 * built on Friday and counted on Sunday would otherwise measure two days of
 * trading as variance.
 *
 * This does NOT stop the till selling. See the header of 081, and see
 * setBlocking() for the freeze that does.
 */
export async function freezeStockTake(
  siteId: number,
  actor: Actor,
  takeId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const take = await getStockTake(siteId, takeId)
  if (!take) return { ok: false, error: 'That stock take no longer exists.' }
  if (take.status !== 'draft') {
    return { ok: false, error: 'Only a draft stock take can be frozen.' }
  }

  await siteTransaction(siteId, async (tx) => {
    /*
     * Re-snapshotting also clears any sign-off, for the same reason saveCounts
     * does: a threshold is measured against the snapshot, so moving the
     * snapshot moves the line somebody signed. In practice a sheet is rarely
     * approved before it is frozen — but "rarely" is not "never", and the
     * failure is silent when it happens.
     */
    await tx.execute(
      `UPDATE stock_take_lines s
         JOIN products p ON p.id = s.product_id
         LEFT JOIN product_location_stock pls
                ON pls.product_id = s.product_id AND pls.location_id = ?
          SET s.snapshot_qty   = COALESCE(pls.stock_on_hand, 0),
              s.unit_cost_excl = COALESCE(NULLIF(p.average_cost, 0), p.last_cost, 0),
              s.approved_by_id     = NULL,
              s.approved_by        = NULL,
              s.approved_at        = NULL,
              s.approval_reason_id = NULL,
              s.approval_note      = NULL
        WHERE s.stock_take_id = ?`,
      [take.locationId, takeId] as never,
    )
    await tx.execute(
      `UPDATE stock_takes SET status = 'counting', frozen_at = NOW() WHERE id = ?`,
      [takeId] as never,
    )
  })

  void actor
  return { ok: true }
}

/* ── Sign-off on a large variance ────────────────────────────────────────── */

/**
 * The two thresholds, as the site has them set.
 *
 * Both default to zero, and zero means OFF for that half independently — a
 * shop can gate on value alone, on percentage alone, or on both.
 *
 * FAILS OPEN, matching approvalGate() in purchaseDocuments.ts. If settings
 * cannot be read, counting still works: the failure mode of a shop that can
 * still correct its books is far better than a shop that cannot post a count
 * because a settings row would not load.
 */
export type VarianceThresholds = { qtyPct: number; value: number }

export async function varianceThresholds(siteId: number): Promise<VarianceThresholds> {
  try {
    const [qtyPct, value] = await Promise.all([
      getNumericSetting(siteId, 'stock_take_variance_qty_pct'),
      getNumericSetting(siteId, 'stock_take_variance_value'),
    ])
    return {
      qtyPct: Number.isFinite(qtyPct) && qtyPct > 0 ? qtyPct : 0,
      value: Number.isFinite(value) && value > 0 ? value : 0,
    }
  } catch {
    return { qtyPct: 0, value: 0 }
  }
}

/** Why a line needs signing off, in the words the screen will use. */
export type FlaggedLine = {
  line: StockTakeLine
  /** counted − snapshot. The counter's claim, not the posted movement. */
  varianceQty: number
  varianceValue: number
  reason: string
}

/**
 * Which counted lines cross a threshold and therefore need a second signature.
 *
 * ── MEASURED AGAINST THE SNAPSHOT, NOT THE PILE AT POST TIME ───────────────
 *
 * This is the one place in the module that deliberately uses the FIRST of the
 * two differences 081 describes, and the reason is that the two figures answer
 * different questions. The movement must be counted−current, or mid-count
 * trading posts as shrinkage. But what is being checked here is the COUNTER'S
 * CLAIM — "I looked at this shelf and saw 40 where the sheet said 400" — and
 * that claim was made against the snapshot. Flagging on counted−current would
 * let a large miscount slip through unsigned whenever a sale happened to move
 * the pile toward the counted figure.
 *
 * ── ABSOLUTE VALUES, BOTH DIRECTIONS ──────────────────────────────────────
 *
 * Stock found is checked as carefully as stock lost. A count that only
 * questions losses teaches people that writing stock ON is the unexamined
 * direction, and a large unexplained write-on is usually a receipt that was
 * posted twice.
 *
 * ── A SNAPSHOT OF ZERO CANNOT BE A PERCENTAGE ─────────────────────────────
 *
 * Finding 10 units the books had at 0 is an infinite percentage, so the
 * percentage half simply does not apply — it is the VALUE half that catches
 * that case, which is the right instrument for it anyway. Guarded explicitly
 * rather than left to produce Infinity, because Infinity > threshold is true
 * and would flag every zero-snapshot line the moment a percentage was set.
 */
export function flagLines(
  lines: readonly StockTakeLine[],
  thresholds: VarianceThresholds,
): FlaggedLine[] {
  if (thresholds.qtyPct <= 0 && thresholds.value <= 0) return []

  const flagged: FlaggedLine[] = []

  for (const line of lines) {
    // A serial line's count is the length of its scanned list; a topup line's
    // claim is what was typed as the addition. Same derivation postStockTake
    // uses, so the two can never disagree about what was claimed.
    const counted =
      line.productType === 'serial'
        ? (line.serials?.length ?? null)
        : line.lineMode === 'topup'
          ? line.enteredQty === null
            ? null
            : round(line.snapshotQty + line.enteredQty, 3)
          : line.countedQty

    if (counted === null) continue

    const varianceQty = round(counted - line.snapshotQty, 3)
    if (Math.abs(varianceQty) < 0.0005) continue

    const varianceValue = round(varianceQty * line.unitCostExcl, 4)

    const reasons: string[] = []

    if (thresholds.qtyPct > 0 && Math.abs(line.snapshotQty) > 0.0005) {
      const pct = Math.abs(varianceQty / line.snapshotQty) * 100
      if (pct > thresholds.qtyPct + 0.0005) {
        reasons.push(`${pct.toFixed(1)}% off the expected ${formatPlain(line.snapshotQty)}`)
      }
    }

    if (thresholds.value > 0 && Math.abs(varianceValue) > thresholds.value + 0.005) {
      reasons.push(`R ${Math.abs(varianceValue).toFixed(2)} ${varianceValue < 0 ? 'written off' : 'written on'}`)
    }

    if (reasons.length > 0) {
      flagged.push({ line, varianceQty, varianceValue, reason: reasons.join(' · ') })
    }
  }

  return flagged
}

/** Quantities inside a sentence, without the thousands separators. */
function formatPlain(qty: number): string {
  return String(round(qty, 3))
}

/**
 * Everything a screen needs to show the sign-off state of a sheet.
 *
 * One call rather than making each caller pair flagLines() with a threshold
 * read — the two are only ever correct together, and a caller that reads the
 * thresholds and forgets to apply them silently shows a sheet as clear.
 */
export type ApprovalState = {
  thresholds: VarianceThresholds
  /** Every flagged line, approved or not. */
  flagged: FlaggedLine[]
  /** The subset still waiting for a signature — what blocks posting. */
  outstanding: FlaggedLine[]
}

export async function approvalState(
  siteId: number,
  take: StockTake,
): Promise<ApprovalState> {
  const thresholds = await varianceThresholds(siteId)
  const flagged = flagLines(take.lines, thresholds)
  return {
    thresholds,
    flagged,
    outstanding: flagged.filter((f) => f.line.approvedAt === null),
  }
}

export type ApproveResult = { ok: true; approved: number } | { ok: false; error: string }

/**
 * Signs off one or more flagged lines.
 *
 * ── THE APPROVER IS RECORDED, NOT ASSUMED ─────────────────────────────────
 *
 * The name is snapshotted beside the id for the same reason every other actor
 * column in this schema is: the user may be renamed or removed, and an
 * approval that stops naming anybody is not an approval.
 *
 * ── THE CAPABILITY CHECK IS NOT HERE ──────────────────────────────────────
 *
 * It is in the server action, which is the real boundary — the same place
 * every other capability in this application is enforced. Putting a second
 * copy here would drift from it.
 *
 * ── APPROVAL IS REVOCABLE UNTIL THE SHEET POSTS ───────────────────────────
 *
 * Passing an empty reasonId clears the approval instead of setting it. Somebody
 * who signs off the wrong line has to be able to take it back, and once the
 * sheet is posted nothing here can be touched at all.
 */
export async function approveVarianceLines(
  siteId: number,
  actor: Actor,
  takeId: number,
  lineIds: readonly number[],
  input: { reasonId: number | null; note?: string | null },
): Promise<ApproveResult> {
  if (lineIds.length === 0) return { ok: true, approved: 0 }

  const take = await siteQueryOne<Row>(siteId, 'SELECT status FROM stock_takes WHERE id = ?', [
    takeId,
  ])
  if (!take) return { ok: false, error: 'That stock take no longer exists.' }
  const status = String(take.status)
  if (status !== 'draft' && status !== 'counting') {
    return { ok: false, error: `A ${status} stock take can no longer be signed off.` }
  }

  const clearing = input.reasonId === null

  // A reason is what makes the approval worth having. "Approved" on its own
  // records that somebody clicked, which is not the same as somebody deciding.
  if (!clearing) {
    const reason = await siteQueryOne<Row>(
      siteId,
      'SELECT id, is_active FROM stock_adjustment_reasons WHERE id = ?',
      [input.reasonId],
    )
    if (!reason) return { ok: false, error: 'That reason no longer exists.' }
    if (!Number(reason.is_active)) {
      return { ok: false, error: 'That reason has been retired. Choose another one.' }
    }
  }

  const placeholders = lineIds.map(() => '?').join(',')
  await siteExecute(
    siteId,
    `UPDATE stock_take_lines
        SET approved_by_id     = ?,
            approved_by        = ?,
            approved_at        = ${clearing ? 'NULL' : 'NOW()'},
            approval_reason_id = ?,
            approval_note      = ?
      WHERE stock_take_id = ? AND id IN (${placeholders})`,
    [
      clearing ? null : actor.userId,
      clearing ? null : actor.userName.slice(0, 120),
      input.reasonId,
      clearing ? null : (input.note?.trim().slice(0, 190) || null),
      takeId,
      ...lineIds,
    ],
  )

  return { ok: true, approved: lineIds.length }
}

/* ── Posting ─────────────────────────────────────────────────────────────── */

export type PostStockTakeResult =
  | { ok: true; id: number; documentNumber: string; movements: number; varianceValue: number }
  | { ok: false; error: string }

/**
 * Sales that have left the shop but not reached the books.
 *
 * Not "did this shop trade offline" — it traded offline all morning and every one
 * of those sales posted, because offlineSync refuses nothing it can write. These
 * two slices are the ones that did NOT post: quarantined (a locked VAT period
 * blocked it) and stuck (claimed, never finalised). For both, goods have
 * physically gone while stock_on_hand still counts them, and a variance posted
 * against that writes off stock that was sold.
 *
 * Scoped this tightly on purpose. A guard that fires every Monday in a shop with
 * flaky internet is a guard people learn to route around.
 */
async function unpostedOfflineSales(siteId: number): Promise<number> {
  // Reusing the counts the offline screen already computes, rather than a second
  // copy of the predicate. "Quarantined" is not a status on sales_documents --
  // it is a draft or saved row carrying an offline_exception -- and a hand-rolled
  // version of that here would drift from the screen it tells people to go to.
  const counts = await offlineExceptionCounts(siteId).catch(() => null)
  return (counts?.quarantined ?? 0) + (counts?.stuck ?? 0)
}

/**
 * Posts a sheet: writes one adjustment movement per line that actually varies.
 *
 * ── THE ORDER OF WRITES IS LOAD-BEARING ────────────────────────────────────
 *
 * 1. Refusals that need no transaction, first, so a refusal leaves nothing behind.
 * 2. Lock and read every pile FOR UPDATE, in product order — two concurrent
 *    sheets touching the same products then queue rather than deadlock.
 * 3. Movements, through recordMovement, which is the only legal way to move stock.
 * 4. The document number LAST, immediately before commit. It takes an exclusive
 *    row lock held until COMMIT, so allocating it early would serialise every
 *    other document in the system behind a count of 4,000 lines.
 */
export async function postStockTake(
  siteId: number,
  actor: Actor,
  takeId: number,
): Promise<PostStockTakeResult> {
  const take = await getStockTake(siteId, takeId)
  if (!take) return { ok: false, error: 'That stock take no longer exists.' }
  if (take.status === 'posted') return { ok: false, error: 'That stock take is already posted.' }
  if (take.status === 'cancelled') return { ok: false, error: 'That stock take was cancelled.' }

  // A serial line is counted once units have been SCANNED, with or without a
  // typed quantity — the scanned list is its count. See the target calculation
  // below, which derives the quantity from that list rather than trusting one.
  const counted = take.lines.filter(
    (l) => l.countedQty !== null || l.enteredQty !== null || (l.serials?.length ?? 0) > 0,
  )
  if (counted.length === 0) {
    return { ok: false, error: 'Nothing has been counted on this sheet yet.' }
  }

  const lockRefusal = await guardPosting(siteId, take.documentDate, 'stock')
  if (lockRefusal) return { ok: false, error: lockRefusal }

  const unposted = await unpostedOfflineSales(siteId)
  if (unposted > 0) {
    return {
      ok: false,
      error:
        `${unposted} offline sale${unposted === 1 ? ' has' : 's have'} not reached the books yet. ` +
        'Those goods have left the shop but still count as stock, so a variance posted now would ' +
        'write off stock that was sold. Clear them on Sales > Offline sales first.',
    }
  }

  /*
   * Lines whose variance crosses a threshold the owner set, still unsigned.
   *
   * Refused HERE rather than in the screen, for the same reason approvalGate is
   * enforced in issueOrder rather than by hiding a button: posting is what
   * commits the write-off to the books, and a control that lives in the UI is a
   * suggestion. This action is reachable from the API and from a second tab.
   *
   * Named lines rather than a count. "3 lines need signing off" sends somebody
   * hunting through five thousand rows; naming the first few and saying how
   * many more there are gets them to the right shelf.
   */
  const { outstanding } = await approvalState(siteId, take)
  if (outstanding.length > 0) {
    const named = outstanding
      .slice(0, 3)
      .map((f) => `${f.line.productCode ?? f.line.description} (${f.reason})`)
      .join(', ')
    const more = outstanding.length > 3 ? `, and ${outstanding.length - 3} more` : ''
    return {
      ok: false,
      error:
        `${outstanding.length} line${outstanding.length === 1 ? '' : 's'} ` +
        `${outstanding.length === 1 ? 'has a variance' : 'have variances'} large enough to need signing off ` +
        `before this count can post: ${named}${more}. Someone with permission to approve a large ` +
        'variance must give each one a reason on the count sheet.',
    }
  }

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      // Product order, so two sheets over the same products queue behind each
      // other instead of each holding what the other needs.
      const ordered = [...counted].sort((a, b) => a.productId - b.productId)

      let movements = 0
      let netQty = 0
      let netValue = 0

      for (const line of ordered) {
        const [rows] = await tx.execute(
          `SELECT COALESCE(pls.stock_on_hand, 0) AS on_hand,
                  COALESCE(NULLIF(p.average_cost, 0), p.last_cost, 0) AS cost,
                  p.has_variants, p.product_type
             FROM products p
             LEFT JOIN product_location_stock pls
                    ON pls.product_id = p.id AND pls.location_id = ?
            WHERE p.id = ?
            FOR UPDATE`,
          [take.locationId, line.productId] as never,
        )
        const row = (rows as Row[])[0]
        if (!row) {
          return {
            ok: false as const,
            error: `${line.productCode ?? line.description} no longer exists.`,
          }
        }
        // recordMovement refuses a parent anyway; refusing here names the product
        // instead of failing halfway through with a generic message.
        if (Number(row.has_variants) === 1) {
          return {
            ok: false as const,
            error: `${line.productCode ?? line.description} now has variants — count the variants instead.`,
          }
        }

        const before = toNum(row.on_hand)
        const cost = line.unitCostExcl > 0 ? line.unitCostExcl : toNum(row.cost)
        const isSerial = String(row.product_type) === 'serial'

        /*
         * A serial line counts UNITS, and the quantity follows from them.
         *
         * Taking a typed quantity here would let somebody count 9 while scanning
         * 10 serials, and invariant (S1) — in_stock serials equal quantity on
         * hand — would break the moment it posted. So the scanned list IS the
         * count, and the two can never disagree.
         */
        const target = isSerial
          ? round((line.serials ?? []).length, 3)
          : line.lineMode === 'topup'
            ? round(before + (line.enteredQty ?? 0), 3)
            : round(line.countedQty ?? 0, 3)
        const delta = round(target - before, 3)

        if (isSerial) {
          const reconciled = await countSerialsTx(tx, actor, {
            productId: line.productId,
            locationId: take.locationId,
            scanned: line.serials ?? [],
            stockTakeId: takeId,
            lineLabel: line.productCode ?? line.description,
          })
          // Throwing rolls the whole transaction back, movements included. A
          // partial post here is the one outcome that breaks the invariant this
          // reconciliation exists to keep.
          if (!reconciled.ok) return { ok: false as const, error: reconciled.error }
        }

        await tx.execute(
          `UPDATE stock_take_lines
              SET posted_qty_before = ?, counted_qty = ?, variance_qty = ?, unit_cost_excl = ?
            WHERE id = ?`,
          [before.toFixed(3), target.toFixed(3), delta.toFixed(3), cost.toFixed(4), line.id] as never,
        )

        /*
         * When this product was last counted — stamped ABOVE the zero-variance
         * skip, because a shelf counted and found correct was still counted.
         * That is the question this column answers: when did somebody last walk
         * up and look, not when did the figure last change.
         */
        await tx.execute('UPDATE products SET last_stock_take_date = NOW() WHERE id = ?', [
          line.productId,
        ] as never)

        // The whole point of the skip: a movement of zero is noise.
        if (Math.abs(delta) < 0.0005) continue

        const movementId = await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: take.locationId,
          movementType: 'adjustment',
          qtyChange: delta,
          unitCostExcl: cost,
          source: 'stock_take',
          sourceDocId: takeId,
          sourceLineId: line.id,
          note: `Counted ${target} against ${before}`,
        })

        await tx.execute('UPDATE stock_take_lines SET movement_id = ? WHERE id = ?', [
          movementId,
          line.id,
        ] as never)

        // The column 001 reserved for this and nothing has ever written. NOW()
        // rather than the document date: it is a DATETIME, and its siblings
        // (last_sold_date, last_purchase_date) record when the event happened.
        await tx.execute('UPDATE products SET last_adjust_date = NOW() WHERE id = ?', [
          line.productId,
        ] as never)

        movements += 1
        netQty = round(netQty + delta, 3)
        netValue = round(netValue + delta * cost, 4)
      }

      // Last write before commit. See the header.
      const documentNumber = await nextDocumentNumber(tx, 'stock_take')

      await tx.execute(
        `UPDATE stock_takes
            SET status = 'posted', document_number = ?, posted_at = NOW(),
                variance_qty = ?, variance_value = ?
          WHERE id = ?`,
        [documentNumber, netQty.toFixed(3), netValue.toFixed(4), takeId] as never,
      )

      return {
        ok: true as const,
        id: takeId,
        documentNumber,
        movements,
        varianceValue: netValue,
      }
    })

    // The ledger entry is written AFTER the stock transaction commits, never
    // inside it. A count is true whether or not anyone has mapped an account for
    // it, and a chart-of-accounts gap must not be able to roll back a completed
    // count. mirrorStockTake swallows its own failure into a logged reason.
    if (result.ok && Math.abs(result.varianceValue) >= 0.005) {
      await mirrorStockTake(siteId, actor, {
        stockTakeId: takeId,
        documentNumber: result.documentNumber,
        documentDate: take.documentDate,
        varianceValue: result.varianceValue,
      })
    }

    return result
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The stock take could not be posted.',
    }
  }
}

/**
 * Cancels a sheet.
 *
 * A draft is simply stamped. A POSTED sheet is reversed by writing the exact
 * inverse movement per line, at the cost the original was valued at — never by
 * deleting the movement rows. The stock genuinely was written on or off, and
 * erasing that would leave a pile whose history does not explain it. Same
 * reasoning as voiding a transfer or a receipt.
 */
export async function cancelStockTake(
  siteId: number,
  actor: Actor,
  takeId: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason.trim()) return { ok: false, error: 'A reason is required to cancel a stock take.' }

  const take = await getStockTake(siteId, takeId)
  if (!take) return { ok: false, error: 'That stock take no longer exists.' }
  if (take.status === 'cancelled') return { ok: false, error: 'That stock take is already cancelled.' }

  if (take.status === 'posted') {
    const cancelLockRefusal = await guardPosting(siteId, take.documentDate, 'stock')
    if (cancelLockRefusal) return { ok: false, error: cancelLockRefusal }
  }

  try {
    const result = await siteTransaction(siteId, async (tx) => {
      if (take.status === 'posted') {
        const reversible = take.lines.filter((l) => l.movementId !== null && l.varianceQty !== null)
        for (const line of [...reversible].sort((a, b) => a.productId - b.productId)) {
          await recordMovement(tx, actor, {
            productId: line.productId,
            locationId: take.locationId,
            movementType: 'adjustment',
            qtyChange: -(line.varianceQty ?? 0),
            unitCostExcl: line.unitCostExcl,
            source: 'stock_take_cancel',
            sourceDocId: takeId,
            sourceLineId: line.id,
            note: `Reversal of ${take.documentNumber ?? `#${takeId}`}`,
          })
        }
      }

      await tx.execute(
        `UPDATE stock_takes
            SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW()
          WHERE id = ?`,
        [reason.trim().slice(0, 190), takeId] as never,
      )

      return { ok: true as const }
    })

    // The reversing journal, after the stock transaction and only for a sheet
    // that had posted one in the first place. Same fail-soft contract as the
    // original: the stock is already back, with or without the ledger.
    if (result.ok && take.status === 'posted' && Math.abs(take.varianceValue) >= 0.005) {
      await mirrorStockTake(siteId, actor, {
        stockTakeId: takeId,
        documentNumber: take.documentNumber,
        documentDate: take.documentDate,
        varianceValue: take.varianceValue,
        isReversal: true,
      })
    }

    return result
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The stock take could not be cancelled.',
    }
  }
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type StockTakeDrift = {
  stockTakeId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  moved: number
}

/**
 * Posted lines whose variance does not match the movement it produced.
 *
 * The check that would catch a half-written post — the failure mode where a
 * sheet says it wrote off 6 and the ledger only shows 4. Reports rather than
 * repairs, like every other reconciliation in this codebase.
 */
export async function reconcileStockTakes(siteId: number): Promise<StockTakeDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id AS stock_take_id, t.document_number,
            s.product_id, s.product_code,
            COALESCE(s.variance_qty, 0) AS expected,
            COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m
                       WHERE m.source = 'stock_take'
                         AND m.source_doc_id = t.id
                         AND m.source_line_id = s.id), 0) AS moved
       FROM stock_takes t
       JOIN stock_take_lines s ON s.stock_take_id = t.id
      WHERE t.status = 'posted'
     HAVING ABS(expected - moved) > 0.0005`,
  )

  return rows.map((r) => ({
    stockTakeId: Number(r.stock_take_id),
    documentNumber: (r.document_number as string | null) ?? null,
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    expected: toNum(r.expected),
    moved: toNum(r.moved),
  }))
}

/** Deletes a draft sheet outright. Only a draft — a posted one is cancelled. */
export async function deleteStockTake(
  siteId: number,
  takeId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await siteQueryOne<Row>(siteId, 'SELECT status FROM stock_takes WHERE id = ?', [takeId])
  if (!row) return { ok: false, error: 'That stock take no longer exists.' }
  if (String(row.status) !== 'draft') {
    return { ok: false, error: 'Only a draft stock take can be deleted. Cancel it instead.' }
  }
  // Lines go with it: the FK is ON DELETE CASCADE.
  await siteExecute(siteId, 'DELETE FROM stock_takes WHERE id = ?', [takeId])
  return { ok: true }
}
