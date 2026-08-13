import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { getNumericSetting, getSetting } from './settings'
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
 *
 * WHAT A SHIFT OWNS depends on the site's mode. In 'terminal' mode it owns a
 * register's drawer; in 'user' mode it owns one person and their own float,
 * across whatever tills they worked. Everything below the point where a sale is
 * banked is identical either way, because the reconciliation only ever keys on
 * shift_id — which is exactly why one table serves both.
 */

export type CashupMode = 'terminal' | 'user'

/** How this site reconciles. Defensive, like every other setting read. */
export async function cashupMode(siteId: number): Promise<CashupMode> {
  return (await getSetting(siteId, 'cashup_mode')) === 'user' ? 'user' : 'terminal'
}

export type Shift = {
  id: number
  mode: CashupMode
  /** Null in user mode — the person is the owner, not a register. */
  terminalId: number | null
  terminalCode: string | null
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
    mode: r.mode === 'user' ? 'user' : 'terminal',
    terminalId: r.terminal_id === null ? null : Number(r.terminal_id),
    terminalCode: (r.terminal_code as string | null) ?? null,
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
  SELECT id, mode, terminal_id, terminal_code, user_id, user_name, opened_at, closed_at,
         opening_float, counted_total, expected_total, variance, variance_note, closed_by_name
    FROM shifts
`

export async function getShift(siteId: number, id: number): Promise<Shift | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_SHIFT} WHERE id = ? LIMIT 1`, [id])
  return row ? mapShift(row) : null
}

/**
 * The open shift on a till, if any.
 *
 * Scoped to terminal-mode rows: in user mode a till has no shift of its own,
 * and matching one there would bank a waiter's sale into whichever colleague
 * happened to be reconciling that register.
 */
export async function openShiftFor(siteId: number, terminalId: number): Promise<Shift | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_SHIFT} WHERE terminal_id = ? AND mode = 'terminal' AND closed_at IS NULL LIMIT 1`,
    [terminalId],
  )
  return row ? mapShift(row) : null
}

/** The open shift belonging to a person, if any. The user-mode counterpart. */
export async function openShiftForUser(siteId: number, userId: number): Promise<Shift | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_SHIFT} WHERE user_id = ? AND mode = 'user' AND closed_at IS NULL LIMIT 1`,
    [userId],
  )
  return row ? mapShift(row) : null
}

/**
 * Which shift banks a sale.
 *
 * THE HINGE OF THE WHOLE FEATURE. Everything downstream — the drawer position,
 * the count screen, the variance — keys on shift_id alone, so getting this one
 * lookup right is what makes both modes work without touching any of it.
 *
 * Null is a legitimate answer in both modes: a store that does not cash up
 * still needs to trade, and a waiter who has not opened a shift must still be
 * able to serve a table. The sale keeps its user_id and terminal_id either way,
 * so nothing about it is lost — it simply belongs to no reconciliation.
 */
export async function shiftToBankInto(
  siteId: number,
  terminalId: number | null,
  userId: number | null,
): Promise<number | null> {
  if ((await cashupMode(siteId)) === 'user') {
    return userId ? ((await openShiftForUser(siteId, userId))?.id ?? null) : null
  }
  return terminalId ? ((await openShiftFor(siteId, terminalId))?.id ?? null) : null
}

/** Open shifts, for the cash-up screen. Ordered so the oldest is dealt with first. */
export async function openShifts(siteId: number): Promise<Shift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_SHIFT} WHERE closed_at IS NULL ORDER BY opened_at`,
  )
  return rows.map(mapShift)
}

export async function listShifts(
  siteId: number,
  opts: { terminalId?: number; userId?: number; from?: string; to?: string; limit?: number } = {},
): Promise<Shift[]> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.terminalId) {
    where.push('terminal_id = ?')
    params.push(opts.terminalId)
  }
  if (opts.userId) {
    where.push('user_id = ?')
    params.push(opts.userId)
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
 *
 * The till is required in terminal mode and ignored in user mode, where the
 * shift belongs to the person opening it and their own float travels with them.
 */
export async function openShift(
  siteId: number,
  actor: Actor,
  terminalId: number | null,
  openingFloat: number,
): Promise<OpenResult> {
  if (openingFloat < 0) return { ok: false, error: 'The opening float cannot be negative.' }

  const mode = await cashupMode(siteId)

  let terminalCode: string | null = null
  if (mode === 'terminal') {
    if (!terminalId) return { ok: false, error: 'Choose a till.' }

    const terminal = await siteQueryOne<Row>(
      siteId,
      'SELECT id, code, is_active FROM terminals WHERE id = ? LIMIT 1',
      [terminalId],
    )
    if (!terminal) return { ok: false, error: 'That till no longer exists.' }
    if (!terminal.is_active) return { ok: false, error: 'That till is deactivated.' }
    terminalCode = String(terminal.code)

    const existing = await openShiftFor(siteId, terminalId)
    if (existing) {
      return {
        ok: false,
        error: `${existing.userName || 'Someone'} already has a shift open on this till. Cash it up first.`,
      }
    }
  } else {
    if (!actor.userId) return { ok: false, error: 'Sign in at the till before opening a shift.' }

    const existing = await openShiftForUser(siteId, actor.userId)
    if (existing) {
      return { ok: false, error: 'You already have a shift open. Cash it up first.' }
    }
  }

  try {
    const res = await siteExecute(
      siteId,
      `INSERT INTO shifts (mode, terminal_id, terminal_code, user_id, user_name, opening_float)
       VALUES (?,?,?,?,?,?)`,
      [
        mode,
        mode === 'terminal' ? terminalId : null,
        terminalCode,
        actor.userId,
        actor.userName.slice(0, 120),
        round(openingFloat, 2).toFixed(4),
      ],
    )
    return { ok: true, shiftId: res.insertId }
  } catch {
    // The unique index is the real guard — the checks above only buy a better
    // message. Two people opening at once land here.
    return {
      ok: false,
      error:
        mode === 'terminal'
          ? 'A shift was just opened on this till. Refresh and try again.'
          : 'A shift was just opened for you. Refresh and try again.',
    }
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
  input: {
    type: 'payout' | 'payin' | 'drop'
    amount: number
    reason: string
    /**
     * Which drawer it came out of. The shift already answers this in terminal
     * mode; in user mode it is the only record, and a waiter paying out of
     * their own float is a different event from one raiding a till.
     */
    terminalId?: number | null
  },
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
    `INSERT INTO shift_movements (shift_id, terminal_id, movement_type, amount, reason, user_id, user_name)
     VALUES (?,?,?,?,?,?,?)`,
    [
      shiftId,
      input.terminalId ?? shift.terminalId,
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
    `SELECT m.id, m.movement_type, m.amount, m.reason, m.user_name, m.created_at, t.code AS terminal_code
       FROM shift_movements m
       LEFT JOIN terminals t ON t.id = m.terminal_id
      WHERE m.shift_id = ? ORDER BY m.created_at`,
    [shiftId],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    type: String(r.movement_type) as 'payout' | 'payin' | 'drop',
    amount: toNum(r.amount),
    reason: String(r.reason),
    userName: String(r.user_name ?? ''),
    terminalCode: (r.terminal_code as string | null) ?? null,
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

  /*
   * Mirror the drawer variance to the ledger — drawer-cash tenders only. A
   * card row's "variance" is a bank-settlement question, not missing cash.
   * Fail-soft like every mirror: a drawer count must never be refused because
   * a mapping is missing. A clean drawer skips entirely rather than logging a
   * fake mirror_failed for the normal case.
   */
  const cashVariances = rows
    .filter((r) => r.countsAsDrawerCash && Math.abs(r.variance) >= 0.005)
    .map((r) => ({ tenderTypeId: r.tenderTypeId, variance: r.variance }))
  if (cashVariances.length > 0) {
    const now = new Date()
    const closedDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const { mirrorCashup } = await import('./glPosting')
    await mirrorCashup(siteId, actor, {
      shiftId,
      closedDate,
      terminalCode: position.shift.terminalCode,
      tenderVariances: cashVariances,
    })
  }

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
