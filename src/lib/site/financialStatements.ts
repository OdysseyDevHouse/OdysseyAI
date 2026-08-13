import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne } from '../siteDb'
import { round, toNum } from '../decimals'
import { today as localToday } from './ledger'
import {
  displayBalance,
  subtypeLabel,
  subtypeRank,
  type AccountType,
} from '../glModel'
import { budgetsForRange } from './budgets'

/**
 * The three statements every accountant asks for first.
 *
 *   TRIAL BALANCE  — every account, debits equal credits. The proof the ledger
 *                    is internally consistent, and the thing you check before
 *                    trusting either statement below.
 *   INCOME STATEMENT — revenue less costs over a PERIOD. Did we make money?
 *   BALANCE SHEET  — what is owned and owed at a MOMENT. What are we worth?
 *
 * ── PERIOD VERSUS POSITION ───────────────────────────────────────────────
 *
 * The distinction runs through everything here. Income and expense accounts
 * measure a period, so the P&L sums only entries INSIDE its range. Assets,
 * liabilities and equity describe a position, so the balance sheet sums
 * everything up TO its date, from the beginning.
 *
 * Getting that backwards is the classic error: a balance sheet built from one
 * period's movements shows a business that owns nothing.
 *
 * ── WHY THE BALANCE SHEET BALANCES ───────────────────────────────────────
 *
 * Assets = Liabilities + Equity, where equity includes the profit earned so far
 * and not yet closed off. That is not a rule imposed on the numbers — it falls
 * out of every journal summing to zero. If a balance sheet here does not
 * balance, an unbalanced batch got in, and `outOfBalance` says so rather than
 * hiding it.
 */

export type DateRange = { from: string; to: string }

export type TrialBalanceRow = {
  accountId: number
  accountCode: string
  name: string
  accountType: AccountType
  subtype: string | null
  debit: number
  credit: number
}

export type TrialBalance = {
  asAt: string
  rows: TrialBalanceRow[]
  totalDebit: number
  totalCredit: number
  /** Zero when the ledger is consistent. Anything else is a posting bug. */
  difference: number
  balanced: boolean
}

/**
 * Every account with a balance, as at a date.
 *
 * Accounts at exactly zero are omitted: a chart of fifty accounts where six are
 * used produces forty-four rows of nothing, and the reader has to find the six.
 * A zero balance carries no information on a trial balance.
 */
export async function trialBalance(siteId: number, asAt: string): Promise<TrialBalance> {
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT a.id, a.account_code, a.name, a.account_type, a.subtype,
            COALESCE(SUM(l.amount), 0) AS balance
       FROM gl_accounts a
       LEFT JOIN journal_lines l   ON l.account_id = a.id
       LEFT JOIN journal_batches b ON b.id = l.batch_id AND b.status = 'posted'
                                  AND b.journal_date <= ?
      WHERE b.id IS NOT NULL
      GROUP BY a.id, a.account_code, a.name, a.account_type, a.subtype
     HAVING ABS(balance) > 0.004
      ORDER BY a.account_code`,
    [asAt],
  )

  let totalDebit = 0
  let totalCredit = 0

  const mapped = rows.map((r) => {
    const balance = toNum(r.balance)
    const debit = balance > 0 ? balance : 0
    const credit = balance < 0 ? -balance : 0
    totalDebit = round(totalDebit + debit, 2)
    totalCredit = round(totalCredit + credit, 2)

    return {
      accountId: Number(r.id),
      accountCode: String(r.account_code),
      name: String(r.name),
      accountType: String(r.account_type) as AccountType,
      subtype: (r.subtype as string | null) ?? null,
      debit,
      credit,
    }
  })

  const difference = round(totalDebit - totalCredit, 2)

  return {
    asAt,
    rows: mapped,
    totalDebit,
    totalCredit,
    difference,
    balanced: difference === 0,
  }
}

/* ── Income statement ────────────────────────────────────────────────────── */

export type StatementLine = {
  accountId: number
  accountCode: string
  name: string
  amount: number
  /** The same account over the comparison period, when one was asked for. */
  priorAmount?: number
  /** What was budgeted for the months the range spans, when asked for. */
  budgetAmount?: number
}

export type StatementGroup = {
  subtype: string | null
  label: string
  lines: StatementLine[]
  total: number
  priorTotal?: number
  budgetTotal?: number
}

export type IncomeStatement = {
  range: DateRange
  revenue: StatementGroup[]
  revenueTotal: number
  costOfSales: StatementGroup[]
  costOfSalesTotal: number
  grossProfit: number
  /** Gross profit as a percentage of revenue. Null when there is no revenue. */
  grossMarginPct: number | null
  expenses: StatementGroup[]
  expenseTotal: number
  netProfit: number
  netMarginPct: number | null
  /** The same figures for the preceding period of equal length. */
  prior: {
    revenueTotal: number
    costOfSalesTotal: number
    grossProfit: number
    expenseTotal: number
    netProfit: number
  } | null
  /**
   * What was budgeted for the calendar months the range spans, when asked
   * for. Whole months always — a mid-month range compares against the full
   * months it touches, stated rather than prorated.
   */
  budget: {
    revenueTotal: number
    costOfSalesTotal: number
    grossProfit: number
    expenseTotal: number
    netProfit: number
  } | null
}

/** The preceding window of the same length, for comparison. */
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

async function periodMovements(
  siteId: number,
  range: DateRange,
  departmentId?: number | null,
): Promise<Map<number, { row: RowDataPacket & Record<string, unknown>; amount: number }>> {
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT a.id, a.account_code, a.name, a.account_type, a.subtype,
            COALESCE(SUM(l.amount), 0) AS amount
       FROM journal_lines l
       JOIN journal_batches b ON b.id = l.batch_id
       JOIN gl_accounts a     ON a.id = l.account_id
      WHERE b.status = 'posted'
        AND b.journal_date BETWEEN ? AND ?
        AND a.account_type IN ('income','expense')
        ${departmentId ? 'AND l.department_id = ?' : ''}
      GROUP BY a.id, a.account_code, a.name, a.account_type, a.subtype
     HAVING ABS(amount) > 0.004`,
    departmentId ? [range.from, range.to, departmentId] : [range.from, range.to],
  )

  return new Map(rows.map((r) => [Number(r.id), { row: r, amount: toNum(r.amount) }]))
}

/**
 * Revenue less costs, over a period.
 *
 * Income accounts hold CREDIT balances, so a month's sales sit as a negative
 * number under the debit convention. `displayBalance` flips them, which is why
 * every figure on the returned statement is positive and reads the way an
 * owner expects: revenue 480 000, cost of sales 310 000, gross profit 170 000.
 */
export async function incomeStatement(
  siteId: number,
  range: DateRange,
  opts: { compare?: boolean; departmentId?: number | null; budget?: boolean } = {},
): Promise<IncomeStatement> {
  const [current, previous, budgets] = await Promise.all([
    periodMovements(siteId, range, opts.departmentId),
    opts.compare
      ? periodMovements(siteId, priorRange(range), opts.departmentId)
      : Promise.resolve(new Map()),
    opts.budget ? budgetsForRange(siteId, range) : Promise.resolve(new Map<number, number>()),
  ])

  /*
   * Budgeted accounts with NO movement still belong on a budget comparison —
   * a line that was budgeted 12 000 and spent nothing is exactly the row a
   * manager wants to see. Fetch the account details the movement query never
   * saw, so those rows can be synthesised at zero actual.
   */
  const unbudgetedIds = opts.budget
    ? [...budgets.keys()].filter((id) => !current.has(id))
    : []
  if (unbudgetedIds.length > 0) {
    const extra = await siteQuery<RowDataPacket & Record<string, unknown>>(
      siteId,
      `SELECT id, account_code, name, account_type, subtype
         FROM gl_accounts
        WHERE account_type IN ('income','expense')
          AND id IN (${unbudgetedIds.map(() => '?').join(',')})`,
      unbudgetedIds,
    )
    for (const r of extra) current.set(Number(r.id), { row: r, amount: 0 })
  }

  const revenue: StatementLine[] = []
  const costOfSales: StatementLine[] = []
  const expenses: StatementLine[] = []

  const subtypeOf = new Map<number, string | null>()
  const typeOf = new Map<number, AccountType>()

  for (const [accountId, { row, amount }] of current) {
    const accountType = String(row.account_type) as AccountType
    const subtype = (row.subtype as string | null) ?? null
    subtypeOf.set(accountId, subtype)
    typeOf.set(accountId, accountType)

    const line: StatementLine = {
      accountId,
      accountCode: String(row.account_code),
      name: String(row.name),
      amount: displayBalance(accountType, amount),
      priorAmount: opts.compare
        ? displayBalance(accountType, previous.get(accountId)?.amount ?? 0)
        : undefined,
      // Budgets are stored as display figures already — see 131.
      budgetAmount: opts.budget ? round(budgets.get(accountId) ?? 0, 2) : undefined,
    }

    if (accountType === 'income') revenue.push(line)
    else if (subtype === 'cost_of_sales') costOfSales.push(line)
    else expenses.push(line)
  }

  const group = (lines: StatementLine[]): StatementGroup[] => {
    const groups = new Map<string, StatementGroup>()
    for (const line of lines) {
      const subtype = subtypeOf.get(line.accountId) ?? null
      const type = typeOf.get(line.accountId) ?? 'expense'
      const key = subtype ?? type
      const existing = groups.get(key) ?? {
        subtype,
        label: subtypeLabel(subtype, type),
        lines: [],
        total: 0,
        priorTotal: opts.compare ? 0 : undefined,
        budgetTotal: opts.budget ? 0 : undefined,
      }
      existing.lines.push(line)
      existing.total = round(existing.total + line.amount, 2)
      if (opts.compare) {
        existing.priorTotal = round((existing.priorTotal ?? 0) + (line.priorAmount ?? 0), 2)
      }
      if (opts.budget) {
        existing.budgetTotal = round((existing.budgetTotal ?? 0) + (line.budgetAmount ?? 0), 2)
      }
      groups.set(key, existing)
    }
    return [...groups.values()]
      .map((g) => ({ ...g, lines: g.lines.sort((a, b) => a.accountCode.localeCompare(b.accountCode)) }))
      .sort((a, b) => subtypeRank(a.subtype) - subtypeRank(b.subtype))
  }

  const sum = (lines: StatementLine[], prior = false): number =>
    lines.reduce((t, l) => round(t + (prior ? (l.priorAmount ?? 0) : l.amount), 2), 0)

  const revenueTotal = sum(revenue)
  const costOfSalesTotal = sum(costOfSales)
  const expenseTotal = sum(expenses)
  const grossProfit = round(revenueTotal - costOfSalesTotal, 2)
  const netProfit = round(grossProfit - expenseTotal, 2)

  const priorRevenue = sum(revenue, true)
  const priorCos = sum(costOfSales, true)
  const priorExpense = sum(expenses, true)

  const budgetSum = (lines: StatementLine[]): number =>
    lines.reduce((t, l) => round(t + (l.budgetAmount ?? 0), 2), 0)
  const budgetRevenue = budgetSum(revenue)
  const budgetCos = budgetSum(costOfSales)
  const budgetExpense = budgetSum(expenses)

  return {
    range,
    revenue: group(revenue),
    revenueTotal,
    costOfSales: group(costOfSales),
    costOfSalesTotal,
    grossProfit,
    grossMarginPct: revenueTotal > 0 ? round((grossProfit / revenueTotal) * 100, 1) : null,
    expenses: group(expenses),
    expenseTotal,
    netProfit,
    netMarginPct: revenueTotal > 0 ? round((netProfit / revenueTotal) * 100, 1) : null,
    prior: opts.compare
      ? {
          revenueTotal: priorRevenue,
          costOfSalesTotal: priorCos,
          grossProfit: round(priorRevenue - priorCos, 2),
          expenseTotal: priorExpense,
          netProfit: round(priorRevenue - priorCos - priorExpense, 2),
        }
      : null,
    budget: opts.budget
      ? {
          revenueTotal: budgetRevenue,
          costOfSalesTotal: budgetCos,
          grossProfit: round(budgetRevenue - budgetCos, 2),
          expenseTotal: budgetExpense,
          netProfit: round(budgetRevenue - budgetCos - budgetExpense, 2),
        }
      : null,
  }
}

/* ── Balance sheet ───────────────────────────────────────────────────────── */

export type BalanceSheet = {
  asAt: string
  assets: StatementGroup[]
  assetsTotal: number
  liabilities: StatementGroup[]
  liabilitiesTotal: number
  equity: StatementGroup[]
  /** Equity per the accounts, BEFORE this year's unclosed result. */
  equityTotal: number
  /** Profit earned this year and not yet closed to retained earnings. */
  currentYearResult: number
  /** equityTotal + currentYearResult — the figure that must balance. */
  totalEquityAndReserves: number
  /** assets − (liabilities + equity). Zero when the ledger is sound. */
  outOfBalance: number
  balanced: boolean
}

/**
 * What is owned and owed, at a moment.
 *
 * ── THE CURRENT-YEAR RESULT ──────────────────────────────────────────────
 *
 * Income and expense accounts still hold this year's movements until year end
 * closes them to retained earnings. A balance sheet drawn before that would be
 * out by exactly the profit earned so far — assets have grown, equity has not.
 *
 * So the result is computed and shown as its own line under equity. That is
 * both correct and what every accounting package does: "profit for the year"
 * appears in equity precisely because it belongs to the owners and has not yet
 * been folded into retained earnings.
 */
export async function balanceSheet(
  siteId: number,
  asAt: string,
  opts: { yearStart?: string } = {},
): Promise<BalanceSheet> {
  // The financial year this date falls in, so the unclosed result covers the
  // right span. Falls back to the calendar year.
  const yearStart = opts.yearStart ?? `${asAt.slice(0, 4)}-01-01`

  const [positions, result] = await Promise.all([
    siteQuery<RowDataPacket & Record<string, unknown>>(
      siteId,
      `SELECT a.id, a.account_code, a.name, a.account_type, a.subtype,
              COALESCE(SUM(l.amount), 0) AS balance
         FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
         JOIN gl_accounts a     ON a.id = l.account_id
        WHERE b.status = 'posted'
          AND b.journal_date <= ?
          AND a.account_type IN ('asset','liability','equity')
        GROUP BY a.id, a.account_code, a.name, a.account_type, a.subtype
       HAVING ABS(balance) > 0.004
        ORDER BY a.account_code`,
      [asAt],
    ),
    siteQueryOne<RowDataPacket & Record<string, unknown>>(
      siteId,
      `SELECT COALESCE(SUM(l.amount), 0) AS total
         FROM journal_lines l
         JOIN journal_batches b ON b.id = l.batch_id
         JOIN gl_accounts a     ON a.id = l.account_id
        WHERE b.status = 'posted'
          AND b.journal_date BETWEEN ? AND ?
          AND a.account_type IN ('income','expense')`,
      [yearStart, asAt],
    ),
  ])

  const assets: StatementLine[] = []
  const liabilities: StatementLine[] = []
  const equity: StatementLine[] = []
  const subtypeOf = new Map<number, string | null>()
  const typeOf = new Map<number, AccountType>()

  for (const r of positions) {
    const accountType = String(r.account_type) as AccountType
    const subtype = (r.subtype as string | null) ?? null
    const accountId = Number(r.id)
    subtypeOf.set(accountId, subtype)
    typeOf.set(accountId, accountType)

    const line: StatementLine = {
      accountId,
      accountCode: String(r.account_code),
      name: String(r.name),
      amount: displayBalance(accountType, toNum(r.balance)),
    }

    if (accountType === 'asset') assets.push(line)
    else if (accountType === 'liability') liabilities.push(line)
    else equity.push(line)
  }

  const group = (lines: StatementLine[]): StatementGroup[] => {
    const groups = new Map<string, StatementGroup>()
    for (const line of lines) {
      const subtype = subtypeOf.get(line.accountId) ?? null
      const type = typeOf.get(line.accountId) ?? 'asset'
      const key = subtype ?? type
      const existing = groups.get(key) ?? {
        subtype,
        label: subtypeLabel(subtype, type),
        lines: [],
        total: 0,
      }
      existing.lines.push(line)
      existing.total = round(existing.total + line.amount, 2)
      groups.set(key, existing)
    }
    return [...groups.values()].sort((a, b) => subtypeRank(a.subtype) - subtypeRank(b.subtype))
  }

  const assetsTotal = assets.reduce((t, l) => round(t + l.amount, 2), 0)
  const liabilitiesTotal = liabilities.reduce((t, l) => round(t + l.amount, 2), 0)
  const equityTotal = equity.reduce((t, l) => round(t + l.amount, 2), 0)

  // Income and expense sum to a net CREDIT when profitable (income credits
  // exceed expense debits), so the stored total is negative. Flipping it gives
  // profit as a positive number.
  const currentYearResult = round(-toNum(result?.total), 2)
  const totalEquityAndReserves = round(equityTotal + currentYearResult, 2)
  const outOfBalance = round(assetsTotal - liabilitiesTotal - totalEquityAndReserves, 2)

  return {
    asAt,
    assets: group(assets),
    assetsTotal,
    liabilities: group(liabilities),
    liabilitiesTotal,
    equity: group(equity),
    equityTotal,
    currentYearResult,
    totalEquityAndReserves,
    outOfBalance,
    balanced: outOfBalance === 0,
  }
}

/* ── Health ──────────────────────────────────────────────────────────────── */

export type LedgerHealth = {
  /** Batches whose own lines do not sum to zero. Always a bug. */
  unbalancedBatches: { id: number; journalNumber: string | null; difference: number }[]
  /** Subledger events that never produced a journal. */
  missingJournals: { source: string; count: number }[]
  trialBalanceDifference: number
}

/**
 * Whether the ledger can be trusted.
 *
 * Three separate failures, each with its own cause:
 *
 *   An unbalanced batch means a writer bypassed postTx. Nothing built on the
 *   ledger is safe until it is found.
 *
 *   A missing journal means a subledger posted without its mirror — the GL is
 *   understating something, and the control accounts will show it.
 *
 *   A trial balance difference is the sum of the first, restated.
 */
export async function ledgerHealth(siteId: number): Promise<LedgerHealth> {
  const [unbalanced, tb] = await Promise.all([
    siteQuery<RowDataPacket & Record<string, unknown>>(
      siteId,
      `SELECT b.id, b.journal_number, COALESCE(SUM(l.amount), 0) AS difference
         FROM journal_batches b
         LEFT JOIN journal_lines l ON l.batch_id = b.id
        WHERE b.status = 'posted'
        GROUP BY b.id, b.journal_number
       HAVING ABS(difference) > 0.004
        LIMIT 50`,
    ),
    // Local date — toISOString() is UTC and reads "yesterday" after local midnight.
    trialBalance(siteId, localToday()),
  ])

  // Documents that posted to a subledger but produced no journal. Counted per
  // source so the answer names which posting path is at fault.
  const missing = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT 'expense' AS source, COUNT(*) AS n
       FROM expenses e
      WHERE e.status = 'finalised'
        AND NOT EXISTS (
          SELECT 1 FROM journal_batches b
           WHERE b.source = 'expense' AND b.source_doc_id = e.id AND b.status = 'posted')
     HAVING n > 0`,
  ).catch(() => [])

  return {
    unbalancedBatches: unbalanced.map((r) => ({
      id: Number(r.id),
      journalNumber: (r.journal_number as string | null) ?? null,
      difference: toNum(r.difference),
    })),
    missingJournals: missing.map((r) => ({ source: String(r.source), count: Number(r.n) })),
    trialBalanceDifference: tb.difference,
  }
}
