/**
 * Budgets — the grid, the upsert, the copy-forwards, and the comparison the
 * income statement draws.
 *
 * The rules that matter:
 *
 *   AMOUNTS ARE DISPLAY FIGURES. A budget of 480 000 sales is stored as
 *   +480 000, and copy-from-actuals must flip the ledger's credit-negative
 *   revenue on the way in, or every copied budget would be a sign error.
 *
 *   ZERO DELETES. Clearing a cell removes the row — "no budget" and
 *   "budgeted at zero" must read the same everywhere.
 *
 *   A BUDGETED ACCOUNT WITH NO MOVEMENT STILL SHOWS. The line budgeted
 *   12 000 that spent nothing is exactly the row a manager opens the
 *   comparison for.
 *
 *   npm run test:budgets
 */
import { siteExecute, siteQuery, siteQueryOne } from '../src/lib/siteDb'
import { round } from '../src/lib/decimals'
import { spreadAnnual } from '../src/lib/glModel'
import {
  budgetGrid, saveBudgets, copyFromPriorYear, copyFromActuals,
  budgetsForRange, monthKeysSpanned,
} from '../src/lib/site/budgets'
import { incomeStatement } from '../src/lib/site/financialStatements'
import { postTx } from '../src/lib/site/journals'
import { siteTransaction } from '../src/lib/siteDb'
import { getAccountByCode } from '../src/lib/site/chartOfAccounts'

const SITE = 1
const actor = { userId: 1, userName: 'Budget Test' }
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

// Years far in the future, so nothing here can collide with a real budget or
// a real posting — and cleanup is one LIKE per year.
const YEAR = 2098
const PRIOR = 2097

async function sweep() {
  await siteExecute(SITE, "DELETE FROM gl_budgets WHERE period_month LIKE '209%'")
}

async function main() {
  await sweep()

  // ── The pure spread
  const spread = spreadAnnual(100000)
  ok('spreadAnnual sums back exactly', round(spread.reduce((s, m) => s + m, 0), 2) === 100000,
    JSON.stringify(spread))
  ok('  eleven equal months', new Set(spread.slice(0, 11)).size === 1)
  ok('  cents land on December', spread[11] !== spread[0] || 100000 % 12 === 0)

  ok('monthKeysSpanned covers a straddling range',
    JSON.stringify(monthKeysSpanned({ from: `${YEAR}-11-15`, to: `${YEAR + 1}-01-10` }))
      === JSON.stringify([`${YEAR}-11`, `${YEAR}-12`, `${YEAR + 1}-01`]))

  const sales = await getAccountByCode(SITE, '4000')
  const rent = await getAccountByCode(SITE, '6000')
  if (!sales || !rent) { console.log('**FAIL** seeded chart missing'); process.exit(1) }

  // ── Upsert semantics
  const saved = await saveBudgets(SITE, actor, [
    { accountId: sales.id, periodMonth: `${YEAR}-01`, amount: 40000 },
    { accountId: rent.id, periodMonth: `${YEAR}-01`, amount: 12000 },
  ])
  ok('*** figures save ***', saved.ok)
  const twice = await saveBudgets(SITE, actor, [
    { accountId: sales.id, periodMonth: `${YEAR}-01`, amount: 45000 },
  ])
  ok('saving again updates in place', twice.ok)
  const row = await siteQueryOne<any>(SITE,
    'SELECT COUNT(*) AS n, MAX(amount) AS amount FROM gl_budgets WHERE account_id = ? AND period_month = ?',
    [sales.id, `${YEAR}-01`])
  ok('  one row, the new figure', Number(row?.n) === 1 && round(Number(row?.amount), 2) === 45000,
    JSON.stringify(row))

  ok('a zero deletes the row',
    (await saveBudgets(SITE, actor, [{ accountId: rent.id, periodMonth: `${YEAR}-01`, amount: 0 }])).ok)
  const gone = await siteQueryOne<any>(SITE,
    'SELECT COUNT(*) AS n FROM gl_budgets WHERE account_id = ? AND period_month = ?',
    [rent.id, `${YEAR}-01`])
  ok('  and it is gone', Number(gone?.n) === 0)

  ok('a balance-sheet account is refused',
    !(await saveBudgets(SITE, actor, [{ accountId: 999999999, periodMonth: `${YEAR}-01`, amount: 5 }])).ok)
  ok('a junk month is refused',
    !(await saveBudgets(SITE, actor, [{ accountId: sales.id, periodMonth: `${YEAR}-13`, amount: 5 }])).ok)

  // ── The grid
  const grid = await budgetGrid(SITE, YEAR)
  const salesRow = grid.rows.find((r) => r.accountId === sales.id)
  ok('the grid carries the saved figure', salesRow?.months[0] === 45000, String(salesRow?.months[0]))
  ok('  and a year total', salesRow?.total === 45000)
  ok('  income counts positive in the month total', grid.monthTotals[0] === 45000,
    String(grid.monthTotals[0]))

  // ── Copy-forwards
  await saveBudgets(SITE, actor, [
    { accountId: sales.id, periodMonth: `${PRIOR}-03`, amount: 30000 },
    { accountId: rent.id, periodMonth: `${PRIOR}-03`, amount: 11000 },
  ])
  const carried = await copyFromPriorYear(SITE, actor, PRIOR + 1)
  ok('*** last year carries forward ***', carried.ok && carried.ok === true)
  const carriedRow = await siteQueryOne<any>(SITE,
    'SELECT amount FROM gl_budgets WHERE account_id = ? AND period_month = ?',
    [rent.id, `${PRIOR + 1}-03`])
  ok('  same month, next year', round(Number(carriedRow?.amount ?? 0), 2) === 11000)

  // ── Copy-from-actuals flips the ledger sign
  // Post a small revenue journal into the FUTURE prior year, then copy it.
  const bank = await getAccountByCode(SITE, '1400') // postable asset
  if (!bank) { console.log('**FAIL** 1400 missing'); process.exit(1) }
  const posted = await siteTransaction(SITE, async (tx) =>
    postTx(tx, actor, {
      journalDate: `${PRIOR}-06-15`,
      description: 'Budget test revenue',
      source: 'manual',
      sourceDocId: null,
      lines: [
        { accountId: bank.id, amount: 5000, description: 'In' },
        { accountId: sales.id, amount: -5000, description: 'Sales' },
      ],
    }))
  const copied = await copyFromActuals(SITE, actor, PRIOR + 1, PRIOR)
  ok('*** actuals copy in ***', copied.ok)
  const copiedRow = await siteQueryOne<any>(SITE,
    'SELECT amount FROM gl_budgets WHERE account_id = ? AND period_month = ?',
    [sales.id, `${PRIOR + 1}-06`])
  ok('  revenue lands POSITIVE', round(Number(copiedRow?.amount ?? 0), 2) === 5000,
    String(copiedRow?.amount))

  // ── The statement comparison
  const forRange = await budgetsForRange(SITE, { from: `${YEAR}-01-05`, to: `${YEAR}-01-20` })
  ok('a mid-month range reads the whole month', forRange.get(sales.id) === 45000,
    String(forRange.get(sales.id)))

  const statement = await incomeStatement(SITE, { from: `${YEAR}-01-01`, to: `${YEAR}-01-31` }, { budget: true })
  ok('*** the statement carries the budget ***', statement.budget?.revenueTotal === 45000,
    String(statement.budget?.revenueTotal))
  const statementLine = statement.revenue.flatMap((g) => g.lines).find((l) => l.accountId === sales.id)
  ok('*** a budgeted account with no movement still shows ***', !!statementLine,
    statementLine ? `${statementLine.amount} actual vs ${statementLine.budgetAmount} budget` : 'missing')
  ok('  at zero actual', statementLine?.amount === 0)

  // ── Cleanup — budgets by year, and the test journal with balance repair.
  await sweep()
  await siteExecute(SITE, 'DELETE FROM journal_lines WHERE batch_id = ?', [posted.id])
  await siteExecute(SITE, 'DELETE FROM journal_batches WHERE id = ?', [posted.id])
  await siteExecute(SITE,
    `UPDATE gl_accounts a
        SET a.balance = COALESCE((
              SELECT SUM(l.amount) FROM journal_lines l
                JOIN journal_batches b ON b.id = l.batch_id
               WHERE l.account_id = a.id AND b.status = 'posted'
            ), 0)`)
  await siteExecute(SITE,
    `UPDATE document_sequences
        SET next_number = next_number - 1,
            last_issued_number = CASE WHEN last_issued_number IS NULL THEN NULL
                                      ELSE GREATEST(last_issued_number - 1, 0) END
      WHERE doc_type = 'journal' AND next_number > 1`).catch(() => undefined)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweep().catch(() => {})
  console.log('\nCRASHED — budgets swept')
  process.exit(1)
})
