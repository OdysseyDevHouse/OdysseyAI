import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { displayBalance, subtypeLabel, subtypeRank, type AccountType } from '../glModel'
import { logActivity, type Actor } from './activityLog'

/**
 * Budgets: what each income and expense account is EXPECTED to do, month by
 * month. The comparison against actuals is incomeStatement's job — this
 * module owns the grid.
 *
 * Only income and expense accounts are budgeted. A balance-sheet "budget" is
 * a forecast, which is a different discipline with different maths; offering
 * it here would invite people to budget their bank account and then ask why
 * the variance makes no sense.
 *
 * AMOUNTS ARE DISPLAY FIGURES — positive quantities of the thing the account
 * names — matching what a person types and what the statement shows. See the
 * sign note in 131.
 */

type Row = RowDataPacket & Record<string, unknown>

export type BudgetGridRow = {
  accountId: number
  accountCode: string
  name: string
  accountType: AccountType
  subtype: string | null
  subtypeLabel: string
  /** Twelve figures, January first. Zero = no budget. */
  months: number[]
  total: number
}

export type BudgetGrid = {
  year: number
  rows: BudgetGridRow[]
  /** Column totals, January first, income counted positive and costs negative. */
  monthTotals: number[]
}

const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/

export function monthKeysFor(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
}

/** Every postable P&L account × twelve months, with what is budgeted so far. */
export async function budgetGrid(siteId: number, year: number): Promise<BudgetGrid> {
  const [accounts, stored] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT id, account_code, name, account_type, subtype
         FROM gl_accounts
        WHERE account_type IN ('income','expense')
          AND is_postable = 1 AND is_active = 1
        ORDER BY account_code`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT account_id, period_month, amount FROM gl_budgets
        WHERE period_month LIKE ?`,
      [`${year}-%`],
    ),
  ])

  const byAccount = new Map<number, Map<string, number>>()
  for (const r of stored) {
    const id = Number(r.account_id)
    const map = byAccount.get(id) ?? new Map<string, number>()
    map.set(String(r.period_month), toNum(r.amount))
    byAccount.set(id, map)
  }

  const keys = monthKeysFor(year)
  const monthTotals = Array.from({ length: 12 }, () => 0)

  const rows: BudgetGridRow[] = accounts.map((a) => {
    const id = Number(a.id)
    const type = String(a.account_type) as AccountType
    const subtype = (a.subtype as string | null) ?? null
    const stored = byAccount.get(id)
    const months = keys.map((k) => round(stored?.get(k) ?? 0, 2))
    const total = round(
      months.reduce((s, m) => s + m, 0),
      2,
    )
    months.forEach((m, i) => {
      // The column total is a budgeted net result, so costs subtract.
      monthTotals[i] = round(monthTotals[i] + (type === 'income' ? m : -m), 2)
    })
    return {
      accountId: id,
      accountCode: String(a.account_code),
      name: String(a.name),
      accountType: type,
      subtype,
      subtypeLabel: subtypeLabel(subtype, type),
      months,
      total,
    }
  })

  rows.sort(
    (a, b) =>
      subtypeRank(a.subtype) - subtypeRank(b.subtype) ||
      a.accountCode.localeCompare(b.accountCode),
  )

  return { year, rows, monthTotals }
}

export type BudgetEntry = { accountId: number; periodMonth: string; amount: number }

/**
 * Upserts a batch of figures in one transaction. Zeros DELETE their row —
 * see 131 — so clearing a cell truly clears it.
 */
export async function saveBudgets(
  siteId: number,
  actor: Actor,
  entries: BudgetEntry[],
): Promise<{ ok: true; saved: number } | { ok: false; error: string }> {
  for (const e of entries) {
    if (!Number.isFinite(e.amount)) return { ok: false, error: 'Every figure must be a number.' }
    if (Math.abs(e.amount) > 999_999_999) return { ok: false, error: 'That figure is too large.' }
    if (!MONTH_KEY.test(e.periodMonth)) return { ok: false, error: 'That month is not valid.' }
  }

  const ids = [...new Set(entries.map((e) => e.accountId))]
  if (ids.length > 0) {
    const known = await siteQuery<Row>(
      siteId,
      `SELECT id FROM gl_accounts
        WHERE account_type IN ('income','expense') AND id IN (${ids.map(() => '?').join(',')})`,
      ids,
    )
    if (known.length !== ids.length) {
      return { ok: false, error: 'One of those accounts is not a budgetable income or expense account.' }
    }
  }

  await siteTransaction(siteId, async (tx) => {
    for (const e of entries) {
      const amount = round(e.amount, 2)
      if (amount === 0) {
        await tx.execute(
          'DELETE FROM gl_budgets WHERE account_id = ? AND period_month = ?',
          [e.accountId, e.periodMonth] as never,
        )
      } else {
        await tx.execute(
          `INSERT INTO gl_budgets (account_id, period_month, amount, user_id, user_name)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE amount = VALUES(amount),
                                   user_id = VALUES(user_id), user_name = VALUES(user_name)`,
          [e.accountId, e.periodMonth, amount.toFixed(4), actor.userId, actor.userName.slice(0, 120)] as never,
        )
      }
    }
  })

  await logActivity(siteId, actor, {
    entity: 'gl',
    entityId: null,
    action: 'budget_saved',
    detail: `${entries.length} budget figure(s) saved`,
  }).catch(() => undefined)

  return { ok: true, saved: entries.length }
}

/** Last year's budget, carried forward as this year's starting point. */
export async function copyFromPriorYear(
  siteId: number,
  actor: Actor,
  year: number,
): Promise<{ ok: true; copied: number } | { ok: false; error: string }> {
  const prior = await siteQuery<Row>(
    siteId,
    'SELECT account_id, period_month, amount FROM gl_budgets WHERE period_month LIKE ?',
    [`${year - 1}-%`],
  )
  if (prior.length === 0) return { ok: false, error: `Nothing was budgeted for ${year - 1}.` }

  const entries: BudgetEntry[] = prior.map((r) => ({
    accountId: Number(r.account_id),
    periodMonth: `${year}-${String(r.period_month).slice(5)}`,
    amount: toNum(r.amount),
  }))
  const saved = await saveBudgets(siteId, actor, entries)
  if (!saved.ok) return saved
  return { ok: true, copied: entries.length }
}

/**
 * A year of ACTUALS, written in as the budget. The honest starting point for
 * a shop budgeting for the first time: what happened, month by month, ready
 * to be nudged.
 */
export async function copyFromActuals(
  siteId: number,
  actor: Actor,
  year: number,
  sourceYear: number,
): Promise<{ ok: true; copied: number } | { ok: false; error: string }> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT a.id, a.account_type, DATE_FORMAT(b.journal_date, '%m') AS mth,
            COALESCE(SUM(l.amount), 0) AS movement
       FROM journal_lines l
       JOIN journal_batches b ON b.id = l.batch_id
       JOIN gl_accounts a     ON a.id = l.account_id
      WHERE b.status = 'posted'
        AND b.source <> 'year_end'
        AND b.journal_date BETWEEN ? AND ?
        AND a.account_type IN ('income','expense')
      GROUP BY a.id, a.account_type, mth
     HAVING ABS(movement) > 0.004`,
    [`${sourceYear}-01-01`, `${sourceYear}-12-31`],
  )
  if (rows.length === 0) return { ok: false, error: `Nothing was posted in ${sourceYear}.` }

  const entries: BudgetEntry[] = rows.map((r) => ({
    accountId: Number(r.id),
    periodMonth: `${year}-${String(r.mth)}`,
    // displayBalance flips the sign so budgeted revenue reads positive.
    amount: displayBalance(String(r.account_type) as AccountType, toNum(r.movement)),
  }))
  const saved = await saveBudgets(siteId, actor, entries)
  if (!saved.ok) return saved
  return { ok: true, copied: entries.length }
}

/**
 * Budget per account across the calendar months a range spans — the figure
 * incomeStatement compares against. A mid-month range still compares whole
 * months; the statement says so rather than prorating, because a prorated
 * budget invents a daily phasing nobody actually planned.
 */
export async function budgetsForRange(
  siteId: number,
  range: { from: string; to: string },
): Promise<Map<number, number>> {
  const keys = monthKeysSpanned(range)
  if (keys.length === 0) return new Map()

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT account_id, COALESCE(SUM(amount), 0) AS total
       FROM gl_budgets
      WHERE period_month IN (${keys.map(() => '?').join(',')})
      GROUP BY account_id`,
    keys,
  )
  return new Map(rows.map((r) => [Number(r.account_id), round(toNum(r.total), 2)]))
}

export function monthKeysSpanned(range: { from: string; to: string }): string[] {
  const from = range.from.slice(0, 7)
  const to = range.to.slice(0, 7)
  if (!MONTH_KEY.test(from) || !MONTH_KEY.test(to) || from > to) return []

  const keys: string[] = []
  let [y, m] = from.split('-').map(Number)
  // Bounded to a century of months — a runaway range is a bug, not a budget.
  while (keys.length < 1200) {
    const key = `${y}-${String(m).padStart(2, '0')}`
    keys.push(key)
    if (key === to) break
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return keys
}
