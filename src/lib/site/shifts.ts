import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { getNumericSetting } from './settings'
import type { Actor } from './activityLog'

/**
 * Shifts and cash-up.
 *
 * THE IDEA: EXPECTED is derived from what was actually rung up; COUNTED is what
 * a person found in the drawer. Variance is the difference, and it is the only
 * figure anyone cares about.
 *
 * Expected is never stored while a shift is open — deriving it means it cannot
 * drift from the sales it came from. It is frozen into shift_counts only at
 * close, so the figure someone signed off stays the figure on the report.
 *
 * Only tenders flagged `counts_as_drawer_cash` are physically in the drawer, so
 * only those can be short. Card and EFT are reconciled against the bank, not
 * the till, and are reported for completeness rather than counted.
 */

export type Shift = {
  id: number
  terminalId: number
  terminalCode: string
  userId: number | null
  userName: string
  openedAt: Date
  closedAt: Date | null
  openingFloat: number
  countedTotal: number
  expectedTotal: number
  variance: number
  varianceNote: string | null
  closedByName: string | null
  isOpen: boolean
}

type Row = RowDataPacket & Record<string, unknown>

function mapShift(r: Row): Shift {
  return {
    id: Number(r.id),
    terminalId: Number(r.terminal_id),
    terminalCode: String(r.terminal_code),
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: String(r.user_name ?? ''),
    openedAt: r.opened_at as Date,
    closedAt: (r.closed_at as Date | null) ?? null,
    openingFloat: toNum(r.opening_float),
    countedTotal: toNum(r.counted_total),
    expectedTotal: toNum(r.expected_total),
    variance: toNum(r.variance),
    varianceNote: (r.variance_note as string | null) ?? null,
    closedByName: (r.closed_by_name as string | null) ?? null,
    isOpen: r.closed_at === null,
  }
}

const SELECT_SHIFT = `
  SELECT id, terminal_id, terminal_code, user_id, user_name, opened_at, closed_at,
         opening_float, counted_total, expected_total, variance, variance_note, closed_by_name
    FROM shifts
`

export async function getShift(siteId: number, id: number): Promise<Shift | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_SHIFT} WHERE id = ? LIMIT 1`, [id])
  return row ? mapShift(row) : null
}

/** The open shift on a till, if any. What the sale posting engine stamps onto documents. */
export async function openShiftFor(siteId: number, terminalId: number): Promise<Shift | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_SHIFT} WHERE terminal_id = ? AND closed_at IS NULL LIMIT 1`,
    [terminalId],
  )
  return row ? mapShift(row) : null
}

export async function listShifts(
  siteId: number,
  opts: { terminalId?: number; from?: string; to?: string; limit?: number } = {},
): Promise<Shift[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.terminalId) {
    where.push('terminal_id = ?')
    params.push(opts.terminalId)
  }
  if (opts.from) {
    where.push('DATE(opened_at) >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('DATE(opened_at) <= ?')
    params.push(opts.to)
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_SHIFT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY opened_at DESC LIMIT ${limit}`,
    params,
  )
  return rows.map(mapShift)
}

/* ── Opening ─────────────────────────────────────────────────────────────── */

export type OpenResult = { ok: true; shiftId: number } | { ok: false; error: string }

/**
 * Starts a shift.
 *
 * The float is COUNTED, not assumed: a float that is wrong at the start makes
 * every variance for the rest of the shift wrong in the same direction, and
 * nobody can tell afterwards which end it came from.
 */
export async function openShift(
  siteId: number,
  actor: Actor,
  terminalId: number,
  openingFloat: number,
): Promise<OpenResult> {
  if (openingFloat < 0) return { ok: false, error: 'The opening float cannot be negative.' }

  const terminal = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, is_active FROM terminals WHERE id = ? LIMIT 1',
    [terminalId],
  )
  if (!terminal) return { ok: false, error: 'That till no longer exists.' }
  if (!terminal.is_active) return { ok: false, error: 'That till is deactivated.' }

  const existing = await openShiftFor(siteId, terminalId)
  if (existing) {
    return {
      ok: false,
      error: `${existing.userName || 'Someone'} already has a shift open on this till. Cash it up first.`,
    }
  }

  try {
    const res = await siteExecute(
      siteId,
      `INSERT INTO shifts (terminal_id, terminal_code, user_id, user_name, opening_float)
       VALUES (?,?,?,?,?)`,
      [
        terminalId,
        String(terminal.code),
        actor.userId,
        actor.userName.slice(0, 120),
        round(openingFloat, 2).toFixed(4),
      ],
    )
    return { ok: true, shiftId: res.insertId }
  } catch {
    // The unique index on open_terminal_id is the real guard — the check above
    // is only to give a better message. Two people opening at once land here.
    return { ok: false, error: 'A shift was just opened on this till. Refresh and try again.' }
  }
}

/* ── The drawer position ─────────────────────────────────────────────────── */

export type TenderPosition = {
  tenderTypeId: number
  tenderCode: string
  tenderName: string
  countsAsDrawerCash: boolean
  /** Net of change given and refunds — what should physically be there. */
  expected: number
  transactionCount: number
}

export type ShiftPosition = {
  shift: Shift
  openingFloat: number
  /** Non-sale drawer movements: payouts, pay-ins, drops. Signed. */
  movementsTotal: number
  tenders: TenderPosition[]
  /** Float + cash tenders + movements — what the drawer should hold. */
  expectedCash: number
  /** Everything taken, including card and account. */
  takingsTotal: number
  salesCount: number
}

/**
 * What the shift SHOULD have, derived from its sales.
 *
 * `amount - change_given` is the net into the drawer: a R100 tender on an
 * R87.50 sale put R100 in and took R12.50 out, so R87.50 stayed. Storing the
 * gross and the change separately (rather than just the net) is what makes this
 * derivable at all — see the tender rule in 015_sales_core.sql.
 */
export async function shiftPosition(siteId: number, shiftId: number): Promise<ShiftPosition | null> {
  const shift = await getShift(siteId, shiftId)
  if (!shift) return null

  const [tenderRows, movementRow, salesRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT t.tender_type_id, t.tender_code, t.tender_name,
              tt.counts_as_drawer_cash,
              SUM(t.amount - t.change_given) AS expected,
              COUNT(*)                       AS n
         FROM sales_tenders t
         JOIN sales_documents d ON d.id = t.document_id
         JOIN tender_types   tt ON tt.id = t.tender_type_id
        -- Finalised only. A voided sale keeps its tenders as history, but the
        -- money went back over the counter, so counting them would leave every
        -- drawer that had a void looking short by exactly that sale.
        WHERE d.shift_id = ? AND d.status = 'finalised'
        GROUP BY t.tender_type_id, t.tender_code, t.tender_name, tt.counts_as_drawer_cash
        ORDER BY tt.position`,
      [shiftId],
    ),
    siteQueryOne<Row>(
      siteId,
      'SELECT COALESCE(SUM(amount), 0) AS total FROM shift_movements WHERE shift_id = ?',
      [shiftId],
    ),
    siteQueryOne<Row>(
      siteId,
      "SELECT COUNT(*) AS n FROM sales_documents WHERE shift_id = ? AND status = 'finalised'",
      [shiftId],
    ),
  ])

  const tenders: TenderPosition[] = tenderRows.map((r) => ({
    tenderTypeId: Number(r.tender_type_id),
    tenderCode: String(r.tender_code),
    tenderName: String(r.tender_name),
    countsAsDrawerCash: !!r.counts_as_drawer_cash,
    expected: toNum(r.expected),
    transactionCount: Number(r.n),
  }))

  const movementsTotal = toNum(movementRow?.total)
  const cashTaken = tenders
    .filter((t) => t.countsAsDrawerCash)
    .reduce((sum, t) => round(sum + t.expected, 2), 0)

  return {
    shift,
    openingFloat: shift.openingFloat,
    movementsTotal,
    tenders,
    expectedCash: round(shift.openingFloat + cashTaken + movementsTotal, 2),
    takingsTotal: tenders.reduce((sum, t) => round(sum + t.expected, 2), 0),
    salesCount: Number(salesRow?.n ?? 0),
  }
}

/* ── Drawer movements ────────────────────────────────────────────────────── */

export type MovementResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Records money in or out of the drawer that is not a sale.
 *
 * Without this, a cash-up is wrong every time someone takes a note out to pay
 * for milk, and the cashier is blamed for a variance that was an errand.
 */
export async function recordDrawerMovement(
  siteId: number,
  actor: Actor,
  shiftId: number,
  input: { type: 'payout' | 'payin' | 'drop'; amount: number; reason: string },
): Promise<MovementResult> {
  if (!input.reason?.trim()) return { ok: false, error: 'Give a reason.' }
  if (input.amount <= 0) return { ok: false, error: 'Enter an amount.' }

  const shift = await getShift(siteId, shiftId)
  if (!shift) return { ok: false, error: 'That shift no longer exists.' }
  if (!shift.isOpen) return { ok: false, error: 'That shift is already cashed up.' }

  // Signed here, so the drawer position stays a plain SUM. A payout and a drop
  // both take money out; only a pay-in adds.
  const signed = input.type === 'payin' ? Math.abs(input.amount) : -Math.abs(input.amount)

  const res = await siteExecute(
    siteId,
    `INSERT INTO shift_movements (shift_id, movement_type, amount, reason, user_id, user_name)
     VALUES (?,?,?,?,?,?)`,
    [
      shiftId,
      input.type,
      round(signed, 2).toFixed(4),
      input.reason.trim().slice(0, 190),
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )
  return { ok: true, id: res.insertId }
}

export async function listDrawerMovements(siteId: number, shiftId: number) {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, movement_type, amount, reason, user_name, created_at
       FROM shift_movements WHERE shift_id = ? ORDER BY created_at`,
    [shiftId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    type: String(r.movement_type) as 'payout' | 'payin' | 'drop',
    amount: toNum(r.amount),
    reason: String(r.reason),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }))
}

/* ── Closing ─────────────────────────────────────────────────────────────── */

export type CloseResult =
  | { ok: true; variance: number; withinTolerance: boolean }
  | { ok: false; error: string }

/**
 * Cashes up.
 *
 * Freezes expected alongside counted, so the report shows what was signed off
 * rather than a figure that could be recomputed differently later. Refuses a
 * variance outside tolerance without an explanation — a short drawer with no
 * reason is exactly what a manager needs to see, and letting it through
 * unremarked defeats the point of counting.
 */
export async function closeShift(
  siteId: number,
  actor: Actor,
  shiftId: number,
  counted: { tenderTypeId: number; amount: number }[],
  varianceNote?: string | null,
): Promise<CloseResult> {
  const position = await shiftPosition(siteId, shiftId)
  if (!position) return { ok: false, error: 'That shift no longer exists.' }
  if (!position.shift.isOpen) return { ok: false, error: 'That shift is already cashed up.' }

  const countedBy = new Map(counted.map((c) => [c.tenderTypeId, round(c.amount, 2)]))

  // The drawer holds the float plus the cash taken; card and EFT are settled by
  // the bank, so they are compared to what was rung up rather than counted.
  const rows = position.tenders.map((tender) => {
    const expected = tender.countsAsDrawerCash
      ? round(tender.expected + position.openingFloat + position.movementsTotal, 2)
      : tender.expected
    const countedAmount = countedBy.get(tender.tenderTypeId) ?? 0
    return {
      ...tender,
      expected,
      counted: countedAmount,
      variance: round(countedAmount - expected, 2),
    }
  })

  const expectedTotal = rows.reduce((sum, r) => round(sum + r.expected, 2), 0)
  const countedTotal = rows.reduce((sum, r) => round(sum + r.counted, 2), 0)
  const variance = round(countedTotal - expectedTotal, 2)

  const tolerance = await getNumericSetting(siteId, 'cashup_variance_tolerance')
  const withinTolerance = Math.abs(variance) <= tolerance

  if (!withinTolerance && !varianceNote?.trim()) {
    return {
      ok: false,
      error: `The drawer is ${variance < 0 ? 'short' : 'over'} by ${Math.abs(variance).toFixed(2)}, which is outside the ${tolerance.toFixed(2)} tolerance. Explain it before closing.`,
    }
  }

  await siteTransaction(siteId, async (tx) => {
    for (const row of rows) {
      await tx.execute(
        `INSERT INTO shift_counts (shift_id, tender_type_id, tender_code, tender_name, expected, counted, variance)
              VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE expected = VALUES(expected), counted = VALUES(counted), variance = VALUES(variance)`,
        [
          shiftId,
          row.tenderTypeId,
          row.tenderCode,
          row.tenderName,
          row.expected.toFixed(4),
          row.counted.toFixed(4),
          row.variance.toFixed(4),
        ] as never,
      )
    }

    await tx.execute(
      `UPDATE shifts
          SET closed_at = NOW(), counted_total = ?, expected_total = ?, variance = ?,
              variance_note = ?, closed_by_user_id = ?, closed_by_name = ?
        WHERE id = ?`,
      [
        countedTotal.toFixed(4),
        expectedTotal.toFixed(4),
        variance.toFixed(4),
        varianceNote?.trim()?.slice(0, 400) ?? null,
        actor.userId,
        actor.userName.slice(0, 120),
        shiftId,
      ] as never,
    )
  })

  return { ok: true, variance, withinTolerance }
}

/** The frozen counts for a closed shift, for its report. */
export async function shiftCounts(siteId: number, shiftId: number) {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT tender_code, tender_name, expected, counted, variance
       FROM shift_counts WHERE shift_id = ? ORDER BY id`,
    [shiftId],
  )
  return rows.map((r) => ({
    tenderCode: String(r.tender_code),
    tenderName: String(r.tender_name),
    expected: toNum(r.expected),
    counted: toNum(r.counted),
    variance: toNum(r.variance),
  }))
}
