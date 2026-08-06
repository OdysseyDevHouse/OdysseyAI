import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { round, toNum } from '../decimals'
import { CATEGORY_TYPE_LABELS, type ExpenseCategoryType } from '../expenseModel'

/**
 * What the business actually spends.
 *
 * The reports the expense module exists to make possible. Until now the system
 * could say what was bought to resell and nothing about rent, salaries or
 * electricity — so it could describe gross margin but never profit.
 *
 * ── WHAT COUNTS ──────────────────────────────────────────────────────────
 *
 * Only FINALISED expenses. A draft is a bill somebody has typed, not one the
 * business has incurred, and counting drafts would mean the figures change as
 * someone works through a pile of paperwork.
 *
 * Amounts are EXCLUDING VAT throughout. VAT that can be claimed is not a cost —
 * treating it as one overstates every expense by 15% and makes the P&L
 * disagree with the VAT return. Where VAT is NOT claimable (entertainment,
 * salaries) it stays in the cost, which is what `line_excl` already reflects
 * because the category's rate is zero or the claim is denied.
 */

export type DateRange = { from: string; to: string }

export type CategorySpend = {
  categoryId: number
  accountCode: string
  name: string
  categoryType: ExpenseCategoryType
  categoryTypeLabel: string
  total: number
  count: number
  /** Share of the period's total spend, 0-100. */
  sharePct: number
  /** The same figure for the preceding period of equal length. */
  priorTotal: number
  /** Percentage change against the prior period. Null when there is no prior. */
  changePct: number | null
}

type Row = RowDataPacket & Record<string, unknown>

/** The preceding window of the same length, for period-on-period comparison. */
function priorRange(range: DateRange): DateRange {
  const from = new Date(`${range.from}T00:00:00`)
  const to = new Date(`${range.to}T00:00:00`)
  const days = Math.max(Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1, 1)

  const priorTo = new Date(from)
  priorTo.setDate(priorTo.getDate() - 1)
  const priorFrom = new Date(priorTo)
  priorFrom.setDate(priorFrom.getDate() - days + 1)

  return { from: iso(priorFrom), to: iso(priorTo) }
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Spend by category, with the prior period beside it.
 *
 * The comparison is the point. "R12 400 on repairs" means nothing on its own;
 * "R12 400, up from R3 100" is the line somebody investigates. A report without
 * it is a report nobody reads twice.
 */
export async function spendByCategory(
  siteId: number,
  range: DateRange,
): Promise<{ rows: CategorySpend[]; total: number; priorTotal: number }> {
  const prior = priorRange(range)

  const [current, previous] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT l.category_id, c.account_code, c.name, c.category_type,
              COALESCE(SUM(l.line_excl), 0) AS total,
              COUNT(DISTINCT l.expense_id) AS n
         FROM expense_lines l
         JOIN expenses e           ON e.id = l.expense_id
         JOIN expense_categories c ON c.id = l.category_id
        WHERE e.status = 'finalised' AND e.expense_date BETWEEN ? AND ?
        GROUP BY l.category_id, c.account_code, c.name, c.category_type
        ORDER BY total DESC`,
      [range.from, range.to],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT l.category_id, COALESCE(SUM(l.line_excl), 0) AS total
         FROM expense_lines l
         JOIN expenses e ON e.id = l.expense_id
        WHERE e.status = 'finalised' AND e.expense_date BETWEEN ? AND ?
        GROUP BY l.category_id`,
      [prior.from, prior.to],
    ),
  ])

  const priorById = new Map(previous.map((r) => [Number(r.category_id), toNum(r.total)]))
  const total = current.reduce((sum, r) => round(sum + toNum(r.total), 2), 0)
  const priorTotal = previous.reduce((sum, r) => round(sum + toNum(r.total), 2), 0)

  const rows = current.map((r) => {
    const categoryType = String(r.category_type) as ExpenseCategoryType
    const amount = toNum(r.total)
    const before = priorById.get(Number(r.category_id)) ?? 0

    return {
      categoryId: Number(r.category_id),
      accountCode: String(r.account_code),
      name: String(r.name),
      categoryType,
      categoryTypeLabel: CATEGORY_TYPE_LABELS[categoryType] ?? categoryType,
      total: amount,
      count: Number(r.n),
      sharePct: total > 0 ? round((amount / total) * 100, 1) : 0,
      priorTotal: before,
      // Null rather than Infinity when there was no prior spend: "new" is a
      // different statement from "up 100%", and a chart that plots Infinity
      // breaks.
      changePct: before > 0 ? round(((amount - before) / before) * 100, 1) : null,
    }
  })

  return { rows, total, priorTotal }
}

export type MonthlySpend = { month: string; total: number; count: number }

/** Spend per month, for a trend line. Excludes capital, which is not a cost. */
export async function spendByMonth(
  siteId: number,
  range: DateRange,
): Promise<MonthlySpend[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT DATE_FORMAT(e.expense_date, '%Y-%m') AS month,
            COALESCE(SUM(l.line_excl), 0) AS total,
            COUNT(DISTINCT e.id) AS n
       FROM expense_lines l
       JOIN expenses e           ON e.id = l.expense_id
       JOIN expense_categories c ON c.id = l.category_id
      WHERE e.status = 'finalised'
        AND c.category_type <> 'capital'
        AND e.expense_date BETWEEN ? AND ?
      GROUP BY month
      ORDER BY month`,
    [range.from, range.to],
  )

  return rows.map((r) => ({
    month: String(r.month),
    total: toNum(r.total),
    count: Number(r.n),
  }))
}

export type SupplierSpend = {
  supplierId: number | null
  supplierName: string
  total: number
  count: number
}

/** Who the money went to. Free-text payees group under their own name. */
export async function spendBySupplier(
  siteId: number,
  range: DateRange,
  limit = 20,
): Promise<SupplierSpend[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT e.supplier_id,
            COALESCE(s.name, e.supplier_name, 'Not stated') AS supplier_name,
            COALESCE(SUM(e.subtotal_excl), 0) AS total,
            COUNT(*) AS n
       FROM expenses e
       LEFT JOIN suppliers s ON s.id = e.supplier_id
      WHERE e.status = 'finalised' AND e.expense_date BETWEEN ? AND ?
      GROUP BY e.supplier_id, supplier_name
      ORDER BY total DESC
      LIMIT ${capped}`,
    [range.from, range.to],
  )

  return rows.map((r) => ({
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id),
    supplierName: String(r.supplier_name),
    total: toNum(r.total),
    count: Number(r.n),
  }))
}

export type ExpenseSummary = {
  /** Operating expenses — what the P&L calls overheads. */
  operating: number
  costOfSales: number
  /** Kept out of the P&L: an asset, not a cost. */
  capital: number
  other: number
  /** operating + costOfSales + other. Capital is deliberately excluded. */
  totalCost: number
  /** Input VAT on these expenses that may actually be claimed. */
  vatClaimable: number
  count: number
  /** Bills posted but not yet paid, within the range. */
  unpaidTotal: number
  unpaidCount: number
  /** Captured but never finalised — they are in nobody's figures yet. */
  draftTotal: number
  draftCount: number
}

/**
 * The headline figures.
 *
 * `capital` is reported separately and excluded from `totalCost` because a
 * laptop is not an expense — booking it as one is the commonest bookkeeping
 * error there is, and the hardest to unpick a year later. Showing it beside the
 * costs rather than inside them is what makes the mistake visible.
 */
export async function expenseSummary(siteId: number, range: DateRange): Promise<ExpenseSummary> {
  const [byType, states] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT c.category_type,
              COALESCE(SUM(l.line_excl), 0) AS total,
              COALESCE(SUM(CASE WHEN l.vat_claimable THEN l.line_vat ELSE 0 END), 0) AS vat
         FROM expense_lines l
         JOIN expenses e           ON e.id = l.expense_id
         JOIN expense_categories c ON c.id = l.category_id
        WHERE e.status = 'finalised' AND e.expense_date BETWEEN ? AND ?
        GROUP BY c.category_type`,
      [range.from, range.to],
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT
         COUNT(CASE WHEN e.status = 'finalised' THEN 1 END) AS finalised_n,
         COUNT(CASE WHEN e.status = 'draft' THEN 1 END) AS draft_n,
         COALESCE(SUM(CASE WHEN e.status = 'draft' THEN e.total_incl END), 0) AS draft_total,
         COUNT(CASE WHEN e.status = 'finalised' AND e.payment_type = 'on_account'
                     AND t.amount_outstanding > 0 THEN 1 END) AS unpaid_n,
         COALESCE(SUM(CASE WHEN e.status = 'finalised' AND e.payment_type = 'on_account'
                     THEN t.amount_outstanding END), 0) AS unpaid_total
       FROM expenses e
       LEFT JOIN supplier_transactions t ON t.id = e.supplier_txn_id
      WHERE e.expense_date BETWEEN ? AND ?`,
      [range.from, range.to],
    ),
  ])

  const totals: Record<string, number> = {}
  let vatClaimable = 0
  for (const r of byType) {
    totals[String(r.category_type)] = toNum(r.total)
    vatClaimable = round(vatClaimable + toNum(r.vat), 2)
  }

  const operating = totals.operating ?? 0
  const costOfSales = totals.cost_of_sales ?? 0
  const capital = totals.capital ?? 0
  const other = totals.other ?? 0

  return {
    operating,
    costOfSales,
    capital,
    other,
    totalCost: round(operating + costOfSales + other, 2),
    vatClaimable,
    count: Number(states?.finalised_n ?? 0),
    unpaidTotal: toNum(states?.unpaid_total),
    unpaidCount: Number(states?.unpaid_n ?? 0),
    draftTotal: toNum(states?.draft_total),
    draftCount: Number(states?.draft_n ?? 0),
  }
}

export type DepartmentSpend = {
  departmentId: number | null
  departmentName: string
  total: number
}

/**
 * Spend by department, where lines were tagged with one.
 *
 * This is what turns "we spent R40 000 on electricity" into "the workshop used
 * R31 000 of it", which is the only version anybody can act on.
 */
export async function spendByDepartment(
  siteId: number,
  range: DateRange,
): Promise<DepartmentSpend[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.department_id, COALESCE(d.name, 'Not allocated') AS department_name,
            COALESCE(SUM(l.line_excl), 0) AS total
       FROM expense_lines l
       JOIN expenses e ON e.id = l.expense_id
       LEFT JOIN departments d ON d.id = l.department_id
      WHERE e.status = 'finalised' AND e.expense_date BETWEEN ? AND ?
      GROUP BY l.department_id, department_name
      ORDER BY total DESC`,
    [range.from, range.to],
  )

  return rows.map((r) => ({
    departmentId: r.department_id === null ? null : Number(r.department_id),
    departmentName: String(r.department_name),
    total: toNum(r.total),
  }))
}
