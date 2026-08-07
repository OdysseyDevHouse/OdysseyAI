import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { toHours } from '../timeModel'
import { payrollHours } from '../timesheetModel'
import { hourlyCostOf, BCEA_ORDINARY_HOURS_PW, type Employment } from '../employmentModel'
import { premiumMultiplier, type PayMultipliers } from '../timesheetModel'
import { payMultipliers } from './payRates'
import { timesheetsFor } from './timesheets'
import { listEmployment } from './employment'
import { salesByCashier } from './salesReports'

/**
 * What each person costs, and what they brought in.
 *
 * The point of the whole staff module. Everything before it — employment
 * terms, the clock, timesheets, leave — exists so this figure can be produced
 * from something other than memory.
 *
 * ── IT ASSEMBLES, IT DOES NOT STORE ─────────────────────────────────────
 *
 * While a period is open the figures are computed live, so a corrected
 * clock-out corrects the cost. Once a period is LOCKED the numbers are frozen
 * into `staff_pay_lines` and read from there — because a figure somebody has
 * been paid must not move when a rate changes six months later.
 *
 * ── WHY THERE ARE TWO REVENUE COLUMNS ───────────────────────────────────
 *
 * `salesByCashier` groups on `sales_documents.user_id` — who rang it up.
 * Commission uses `sales_document_lines.sales_rep_user_id` — who sold it. 047
 * exists precisely because those differ, and a report that silently picked one
 * would be wrong for whichever store meant the other. Both are shown, labelled.
 */

export type CostLine = {
  userId: number
  userName: string
  employeeNumber: string | null
  payBasis: 'hourly' | 'salaried'
  /** Null when the reader may not see pay — the whole line then shows hours only. */
  hourlyRate: number | null

  ordinaryHours: number
  overtimeHours: number
  premiumHours: number
  leaveDays: number

  ordinaryCost: number | null
  overtimeCost: number | null
  premiumCost: number | null
  leaveCost: number | null
  commission: number | null
  totalCost: number | null

  /** Sales on documents they captured. */
  revenueRungUp: number
  /** Sales on lines attributed to them — what commission pays on. */
  revenueSold: number
  grossProfit: number
  /** grossProfit − totalCost. Null when cost is hidden. */
  contribution: number | null

  /** No employment row, so nothing can be costed. Shown, never silently zero. */
  noRateOnFile: boolean
}

export type CostReport = {
  from: string
  to: string
  lines: CostLine[]
  totalCost: number | null
  totalRevenue: number
  totalProfit: number
}

/**
 * The report, for a date range.
 *
 * `withCost` comes from `staff.cost` and is threaded all the way down: without
 * it every money column is null rather than a number a screen might forget to
 * hide. Hiding a figure in JSX still ships it in the RSC payload.
 */
export async function costReport(
  siteId: number,
  from: string,
  to: string,
  withCost: boolean,
): Promise<CostReport> {
  const [sheets, employment, byCashier, commission, leave, rates] = await Promise.all([
    timesheetsFor(siteId, from, to),
    listEmployment(siteId, withCost),
    salesByCashier(siteId, { from, to }),
    commissionByUser(siteId, from, to),
    leaveTakenByUser(siteId, from, to),
    payMultipliers(siteId),
  ])

  const employmentByUser = new Map(employment.map((e) => [e.userId, e]))
  // `salesByCashier` keys on user id as a string, and uses 0 for the online
  // store pseudo-actor, which is not a person and must not appear as staff.
  const rungUpByUser = new Map(
    byCashier.filter((r) => r.key !== '0').map((r) => [Number(r.key), r]),
  )
  const soldByUser = await revenueSoldByUser(siteId, from, to)

  // Everyone who worked, took leave, sold something or has terms on file. A
  // person with terms and no hours is a real answer — they were away.
  const people = new Map<number, string>()
  for (const s of sheets) people.set(s.userId, s.userName)
  for (const e of employment) if (e.isCurrent) people.set(e.userId, e.userName)
  for (const [id, row] of rungUpByUser) people.set(id, row.label)
  for (const [id, row] of leave) people.set(id, row.userName)

  const lines: CostLine[] = [...people.entries()]
    .map(([userId, userName]) => {
      const sheet = sheets.find((s) => s.userId === userId)
      const terms = employmentByUser.get(userId)
      const hours = sheet
        ? payrollHours(sheet)
        : { ordinary: 0, overtime: 0, premium: 0, sunday: 0, holiday: 0, total: 0 }

      const leaveRow = leave.get(userId)
      const leaveDays = leaveRow?.days ?? 0
      const earned = commission.get(userId) ?? 0
      const rungUp = rungUpByUser.get(userId)
      const sold = soldByUser.get(userId) ?? { revenue: 0, profit: 0 }

      const rate = terms && withCost ? hourlyCostOf(terms) : null
      const costs = rate === null ? null : computeCosts(hours, leaveDays, rate, terms!, rates)

      const total =
        costs === null ? null : round(costs.ordinary + costs.overtime + costs.premium + costs.leave + earned, 2)

      return {
        userId,
        userName,
        employeeNumber: terms?.employeeNumber ?? null,
        payBasis: terms?.payBasis ?? 'hourly',
        hourlyRate: rate,

        ordinaryHours: hours.ordinary,
        overtimeHours: hours.overtime,
        premiumHours: hours.premium,
        leaveDays,

        ordinaryCost: costs?.ordinary ?? null,
        overtimeCost: costs?.overtime ?? null,
        premiumCost: costs?.premium ?? null,
        leaveCost: costs?.leave ?? null,
        commission: withCost ? earned : null,
        totalCost: total,

        revenueRungUp: toNum(rungUp?.salesExcl),
        revenueSold: sold.revenue,
        grossProfit: sold.profit,
        contribution: total === null ? null : round(sold.profit - total, 2),

        // Distinguished from "costs nothing". A person with no terms on file
        // cannot be costed at all, and showing zero would read as free labour.
        noRateOnFile: !terms,
      }
    })
    .sort((a, b) => a.userName.localeCompare(b.userName))

  return {
    from,
    to,
    lines,
    totalCost: withCost
      ? round(
          lines.reduce((sum, l) => sum + (l.totalCost ?? 0), 0),
          2,
        )
      : null,
    totalRevenue: round(
      lines.reduce((sum, l) => sum + l.revenueSold, 0),
      2,
    ),
    totalProfit: round(
      lines.reduce((sum, l) => sum + l.grossProfit, 0),
      2,
    ),
  }
}

/**
 * Money for one person's banded hours.
 *
 * The multipliers are BCEA s10 (1.5× overtime) and s16 (2× Sunday). Applied
 * HERE rather than surfaced, unlike the timesheet: a cost figure has to be a
 * number, and the statutory rate is the only defensible default. A store whose
 * agreement differs will see a figure it can correct, which is better than a
 * blank.
 *
 * A salaried person's hours cost their derived hourly rate — see
 * `hourlyCostOf`. That is the honest answer to "what did this month cost",
 * even though their pay does not vary with it.
 */
function computeCosts(
  hours: { ordinary: number; overtime: number; sunday: number; holiday: number },
  leaveDays: number,
  rate: number,
  terms: Employment,
  rates: PayMultipliers,
) {
  // A leave day costs a normal working day, which is the ordinary week divided
  // by five — not by however many days they happened to work that week.
  const hoursPerDay = (terms.ordinaryHoursPw || BCEA_ORDINARY_HOURS_PW) / 5

  // Sundays and holidays are one band on the timesheet but not one rate. A
  // holiday is 18(2)(a); a Sunday is 16(1) unless this person ordinarily works
  // them, which makes it 16(2). See premiumMultiplier.
  const sundayCost =
    hours.sunday * rate * premiumMultiplier('sunday', terms.worksSundays, rates)
  const holidayCost = hours.holiday * rate * premiumMultiplier('holiday', terms.worksSundays, rates)

  return {
    ordinary: round(hours.ordinary * rate, 2),
    overtime: round(hours.overtime * rate * rates.overtime, 2),
    premium: round(sundayCost + holidayCost, 2),
    leave: round(leaveDays * hoursPerDay * rate, 2),
  }
}

/**
 * Commission earned in a range, by `document_date`.
 *
 * Read from `commission_entries` rather than from a run, because a pay period
 * and a commission run need not align — and the index on
 * (user_id, document_date) exists for exactly this.
 *
 * A clawback for a locked commission period lands in the current open run, so
 * summing by date and summing by run give different answers. This uses date,
 * which is what "what did this month cost" means.
 */
async function commissionByUser(
  siteId: number,
  from: string,
  to: string,
): Promise<Map<number, number>> {
  const rows = await siteQuery<RowDataPacket & { user_id: number; total: string }>(
    siteId,
    `SELECT user_id, SUM(amount) AS total
       FROM commission_entries
      WHERE document_date BETWEEN ? AND ?
      GROUP BY user_id`,
    [from, to],
  )
  return new Map(rows.map((r) => [r.user_id, toNum(r.total)]))
}

/** Paid leave taken in a range, per person. Unpaid types cost nothing. */
async function leaveTakenByUser(
  siteId: number,
  from: string,
  to: string,
): Promise<Map<number, { userName: string; days: number }>> {
  const rows = await siteQuery<
    RowDataPacket & { user_id: number; user_name: string; days: string }
  >(
    siteId,
    `SELECT r.user_id, MAX(r.user_name) AS user_name, SUM(r.days) AS days
       FROM leave_requests r
       INNER JOIN leave_types t ON t.id = r.leave_type_id
      WHERE r.status = 'approved'
        AND t.is_paid = 1
        AND r.period_from <= ? AND r.period_to >= ?
      GROUP BY r.user_id`,
    [to, from],
  )
  return new Map(
    rows.map((r) => [r.user_id, { userName: r.user_name, days: toNum(r.days) }]),
  )
}

/**
 * Revenue and profit on lines ATTRIBUTED to a person.
 *
 * The other half of the revenue question. `salesByCashier` answers "who rang
 * it up"; this answers "who sold it", which is what commission pays on and
 * what a contribution figure should really compare cost against.
 */
async function revenueSoldByUser(
  siteId: number,
  from: string,
  to: string,
): Promise<Map<number, { revenue: number; profit: number }>> {
  const rows = await siteQuery<
    RowDataPacket & { user_id: number; revenue: string; profit: string }
  >(
    siteId,
    `SELECT l.sales_rep_user_id AS user_id,
            SUM(l.line_total_excl) AS revenue,
            SUM(l.line_total_excl - l.unit_cost_excl * l.qty) AS profit
       FROM sales_document_lines l
       INNER JOIN sales_documents d ON d.id = l.document_id
      WHERE d.status = 'finalised'
        AND d.doc_type IN ('invoice','credit_sale')
        AND d.document_date BETWEEN ? AND ?
        AND l.sales_rep_user_id IS NOT NULL
      GROUP BY l.sales_rep_user_id`,
    [from, to],
  )
  return new Map(
    rows.map((r) => [r.user_id, { revenue: toNum(r.revenue), profit: toNum(r.profit) }]),
  )
}

/* ── Pay periods ───────────────────────────────────────────────────────── */

export type PayPeriod = {
  id: number
  periodStart: string
  periodEnd: string
  status: 'open' | 'locked'
  calculatedAt: string | null
  lockedAt: string | null
  lockedByName: string | null
  totalCost: number
  note: string | null
}

type PeriodRow = RowDataPacket & {
  id: number
  period_start: string
  period_end: string
  status: 'open' | 'locked'
  calculated_at: string | null
  locked_at: string | null
  locked_by_name: string | null
  total_cost: string
  note: string | null
}

function mapPeriod(r: PeriodRow): PayPeriod {
  return {
    id: r.id,
    periodStart: String(r.period_start).slice(0, 10),
    periodEnd: String(r.period_end).slice(0, 10),
    status: r.status,
    calculatedAt: r.calculated_at ? new Date(r.calculated_at).toISOString() : null,
    lockedAt: r.locked_at ? new Date(r.locked_at).toISOString() : null,
    lockedByName: r.locked_by_name,
    totalCost: toNum(r.total_cost),
    note: r.note,
  }
}

export async function listPayPeriods(siteId: number): Promise<PayPeriod[]> {
  const rows = await siteQuery<PeriodRow>(
    siteId,
    'SELECT * FROM staff_pay_periods ORDER BY period_start DESC',
  )
  return rows.map(mapPeriod)
}

export async function getPayPeriod(siteId: number, id: number): Promise<PayPeriod | null> {
  const row = await siteQueryOne<PeriodRow>(
    siteId,
    'SELECT * FROM staff_pay_periods WHERE id = ? LIMIT 1',
    [id],
  )
  return row ? mapPeriod(row) : null
}

export type PeriodResult = { ok: true; id: number } | { ok: false; error: string }

/**
 * Opens a period.
 *
 * Overlap is refused rather than merged: two periods covering the same day
 * would pay the same hours twice, and the UNIQUE key on the exact pair of
 * dates does not catch a range that merely overlaps.
 */
export async function createPayPeriod(
  siteId: number,
  periodStart: string,
  periodEnd: string,
  note: string | null,
): Promise<PeriodResult> {
  if (!periodStart || !periodEnd) return { ok: false, error: 'Choose a period.' }
  if (periodEnd < periodStart) return { ok: false, error: 'The period ends before it starts.' }

  const clash = await siteQueryOne<PeriodRow>(
    siteId,
    'SELECT * FROM staff_pay_periods WHERE period_start <= ? AND period_end >= ? LIMIT 1',
    [periodEnd, periodStart],
  )
  if (clash) {
    return {
      ok: false,
      error: `That overlaps the period ${String(clash.period_start).slice(0, 10)} to ${String(clash.period_end).slice(0, 10)}. Every day belongs to exactly one.`,
    }
  }

  const res = await siteExecute(
    siteId,
    'INSERT INTO staff_pay_periods (period_start, period_end, note) VALUES (?,?,?)',
    [periodStart, periodEnd, note?.trim() || null],
  )
  return { ok: true, id: res.insertId }
}

export type CalculateResult =
  | { ok: true; people: number; total: number }
  | { ok: false; error: string }

/**
 * Works out and freezes what everybody cost.
 *
 * Destructive on an OPEN period: the lines are deleted and rebuilt, so
 * recalculating after a corrected clock-out gives the current truth rather
 * than layering a second set of rows on top. A LOCKED period is refused.
 */
export async function calculatePayPeriod(
  siteId: number,
  periodId: number,
): Promise<CalculateResult> {
  const period = await getPayPeriod(siteId, periodId)
  if (!period) return { ok: false, error: 'That period no longer exists.' }
  if (period.status === 'locked') {
    return { ok: false, error: 'This period is locked. Reopen it first if the figures really must change.' }
  }

  // Always with cost: this is what gets frozen, and a report that omitted the
  // money would freeze nothing worth freezing. The CAPABILITY is checked by
  // the caller, which is why this is not reachable without staff.run.
  const report = await costReport(siteId, period.periodStart, period.periodEnd, true)

  await siteTransaction(siteId, async (tx) => {
    await tx.execute('DELETE FROM staff_pay_lines WHERE period_id = ?', [periodId])

    for (const line of report.lines) {
      // Somebody with no terms on file cannot be costed. Skipped rather than
      // frozen at zero, which would read as free labour a year from now.
      if (line.noRateOnFile) continue

      await tx.execute(
        `INSERT INTO staff_pay_lines
           (period_id, user_id, user_name, employee_number, pay_basis, hourly_rate,
            monthly_salary, ordinary_hours, overtime_hours, premium_hours, leave_days,
            ordinary_cost, overtime_cost, premium_cost, leave_cost, commission,
            total_cost, revenue_rung_up, revenue_sold, gross_profit)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          periodId,
          line.userId,
          line.userName,
          line.employeeNumber,
          line.payBasis,
          (line.hourlyRate ?? 0).toFixed(4),
          line.ordinaryHours.toFixed(2),
          line.overtimeHours.toFixed(2),
          line.premiumHours.toFixed(2),
          line.leaveDays.toFixed(2),
          (line.ordinaryCost ?? 0).toFixed(4),
          (line.overtimeCost ?? 0).toFixed(4),
          (line.premiumCost ?? 0).toFixed(4),
          (line.leaveCost ?? 0).toFixed(4),
          (line.commission ?? 0).toFixed(4),
          (line.totalCost ?? 0).toFixed(4),
          line.revenueRungUp.toFixed(4),
          line.revenueSold.toFixed(4),
          line.grossProfit.toFixed(4),
        ],
      )
    }

    await tx.execute(
      'UPDATE staff_pay_periods SET calculated_at = NOW(), total_cost = ? WHERE id = ?',
      [(report.totalCost ?? 0).toFixed(4), periodId],
    )
  })

  return {
    ok: true,
    people: report.lines.filter((l) => !l.noRateOnFile).length,
    total: report.totalCost ?? 0,
  }
}

export async function lockPayPeriod(
  siteId: number,
  periodId: number,
  actor: { userId: number; userName: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const period = await getPayPeriod(siteId, periodId)
  if (!period) return { ok: false, error: 'That period no longer exists.' }
  if (period.status === 'locked') return { ok: false, error: 'This period is already locked.' }
  if (!period.calculatedAt) {
    return { ok: false, error: 'Calculate the period before locking it — there is nothing to freeze yet.' }
  }

  await siteExecute(
    siteId,
    `UPDATE staff_pay_periods
        SET status = 'locked', locked_at = NOW(), locked_by_user_id = ?, locked_by_name = ?
      WHERE id = ? AND status = 'open'`,
    [actor.userId, actor.userName, periodId],
  )
  return { ok: true }
}

/**
 * Reopens a locked period.
 *
 * Deliberately possible and deliberately deliberate. Correcting a genuine
 * mistake has to be available; it must never be a side effect of pressing
 * Calculate.
 */
export async function unlockPayPeriod(
  siteId: number,
  periodId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const period = await getPayPeriod(siteId, periodId)
  if (!period) return { ok: false, error: 'That period no longer exists.' }
  if (period.status === 'open') return { ok: false, error: 'This period is already open.' }

  await siteExecute(
    siteId,
    `UPDATE staff_pay_periods
        SET status = 'open', locked_at = NULL, locked_by_user_id = NULL, locked_by_name = NULL
      WHERE id = ?`,
    [periodId],
  )
  return { ok: true }
}

/** The frozen lines of a locked period — what was actually paid. */
export async function payLinesFor(
  siteId: number,
  periodId: number,
  withCost: boolean,
): Promise<CostLine[]> {
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    'SELECT * FROM staff_pay_lines WHERE period_id = ? ORDER BY user_name ASC',
    [periodId],
  )

  return rows.map((r) => {
    const total = toNum(r.total_cost)
    const profit = toNum(r.gross_profit)
    return {
      userId: Number(r.user_id),
      userName: String(r.user_name),
      employeeNumber: (r.employee_number as string | null) ?? null,
      payBasis: r.pay_basis as 'hourly' | 'salaried',
      hourlyRate: withCost ? toNum(r.hourly_rate) : null,
      ordinaryHours: toNum(r.ordinary_hours),
      overtimeHours: toNum(r.overtime_hours),
      premiumHours: toNum(r.premium_hours),
      leaveDays: toNum(r.leave_days),
      ordinaryCost: withCost ? toNum(r.ordinary_cost) : null,
      overtimeCost: withCost ? toNum(r.overtime_cost) : null,
      premiumCost: withCost ? toNum(r.premium_cost) : null,
      leaveCost: withCost ? toNum(r.leave_cost) : null,
      commission: withCost ? toNum(r.commission) : null,
      totalCost: withCost ? total : null,
      revenueRungUp: toNum(r.revenue_rung_up),
      revenueSold: toNum(r.revenue_sold),
      grossProfit: profit,
      contribution: withCost ? round(profit - total, 2) : null,
      noRateOnFile: false,
    }
  })
}

/** Decimal hours, re-exported so a caller need not reach into timeModel. */
export { toHours }
