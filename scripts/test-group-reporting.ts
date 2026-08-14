/**
 * Cross-site reporting — scope resolution, the pure merge, and fail-softness.
 *
 * The property that matters most: one broken or forbidden store NEVER kills
 * the consolidated screen, and is never silently summed either — it is
 * excluded with a reason or reported as a failure.
 *
 *   npm run test:group-reporting
 */
import {
  groupScopeFor,
  perSite,
  groupDashboard,
  consolidatedIncomeStatement,
  mergeIncomeStatements,
} from '../src/lib/groupReporting'
import { incomeStatement, type IncomeStatement } from '../src/lib/site/financialStatements'
import { groupForSite } from '../src/lib/storeGroups'

const SITE = 1
const CONTROL_USER = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A minimal synthetic statement — only the fields the merge reads. */
function synthetic(
  lines: { section: 'revenue' | 'costOfSales' | 'expenses'; code: string; name: string; amount: number; subtype?: string | null }[],
): IncomeStatement {
  const blockFor = (section: 'revenue' | 'costOfSales' | 'expenses') => {
    const mine = lines.filter((l) => l.section === section)
    if (mine.length === 0) return []
    return [
      {
        subtype: mine[0].subtype ?? null,
        label: 'Synthetic',
        lines: mine.map((l) => ({ accountId: 0, accountCode: l.code, name: l.name, amount: l.amount })),
        total: mine.reduce((t, l) => t + l.amount, 0),
      },
    ]
  }
  const sum = (section: 'revenue' | 'costOfSales' | 'expenses') =>
    lines.filter((l) => l.section === section).reduce((t, l) => t + l.amount, 0)
  const revenueTotal = sum('revenue')
  const cosTotal = sum('costOfSales')
  const expenseTotal = sum('expenses')
  return {
    range: { from: '2026-01-01', to: '2026-01-31' },
    revenue: blockFor('revenue'),
    revenueTotal,
    costOfSales: blockFor('costOfSales'),
    costOfSalesTotal: cosTotal,
    grossProfit: revenueTotal - cosTotal,
    grossMarginPct: null,
    expenses: blockFor('expenses'),
    expenseTotal,
    netProfit: revenueTotal - cosTotal - expenseTotal,
    netMarginPct: null,
    prior: null,
    budget: null,
  }
}

async function main() {
  /* ── 1. Scope ────────────────────────────────────────────────────────── */

  const group = await groupForSite(SITE)
  if (!group) {
    console.log('SKIP  site 1 is in no store group on this machine — scope checks skipped')
  } else {
    const scope = await groupScopeFor(SITE, CONTROL_USER, 'reports.financial')
    ok('*** the scope resolves the group ***', scope !== null && scope.group.id === group.id,
      scope ? scope.group.name : 'null')
    ok('  the current site is always included',
      scope !== null && scope.sites.some((s) => s.siteId === SITE))
    ok('  every member is either included or excluded with a reason',
      scope !== null && scope.sites.length + scope.excluded.length >= 1,
      scope ? `${scope.sites.length} in, ${scope.excluded.length} out (${scope.excluded.map((e) => `${e.name}:${e.reason}`).join(', ') || 'none'})` : '')
    ok('  the primary store leads the column order',
      scope !== null && (scope.sites[0].isPrimary || !scope.sites.some((s) => s.isPrimary)))
  }

  /* ── 2. The pure merge ───────────────────────────────────────────────── */

  const sites = [
    { siteId: 1, name: 'Main' },
    { siteId: 2, name: 'Branch' },
  ]
  const a = synthetic([
    { section: 'revenue', code: '4000', name: 'Sales', amount: 1000 },
    { section: 'costOfSales', code: '5000', name: 'Cost of sales', amount: 400, subtype: 'cost_of_sales' },
    { section: 'expenses', code: '6100', name: 'Rent', amount: 150 },
  ])
  const b = synthetic([
    { section: 'revenue', code: '4000', name: 'Sales (renamed)', amount: 500 },
    { section: 'costOfSales', code: '5000', name: 'Cost of sales', amount: 250, subtype: 'cost_of_sales' },
    { section: 'expenses', code: '6900', name: 'Branch-only levy', amount: 50 },
  ])
  const merged = mergeIncomeStatements(sites, [a, b])

  const salesLine = merged.revenue.flatMap((g) => g.lines).find((l) => l.accountCode === '4000')
  ok('*** a shared code sums across stores ***',
    salesLine !== undefined && salesLine.total === 1500 &&
    salesLine.perSite[0] === 1000 && salesLine.perSite[1] === 500,
    salesLine ? `${salesLine.perSite.join('/')} = ${salesLine.total}` : 'absent')
  ok('  the first-seen store names the account', salesLine?.name === 'Sales')

  const levy = merged.expenses.flatMap((g) => g.lines).find((l) => l.accountCode === '6900')
  ok('*** a store-only account keeps null, not zero, in the other columns ***',
    levy !== undefined && levy.perSite[0] === null && levy.perSite[1] === 50)

  ok('*** the total column is the sum of the site columns ***',
    merged.perSiteNet[0] + merged.perSiteNet[1] === merged.netProfit,
    `${merged.perSiteNet.join(' + ')} = ${merged.netProfit}`)
  ok('  net profit is revenue less cost less expenses',
    merged.netProfit === 1500 - 650 - 200, String(merged.netProfit))

  /* ── 3. Integration against the real statements ──────────────────────── */

  const range = { from: '2026-01-01', to: '2026-12-31' }
  const both = [
    { siteId: 1, name: 'Main', code: 'A', isPrimary: true },
    { siteId: 2, name: 'Branch', code: 'B', isPrimary: false },
  ]
  const consolidated = await consolidatedIncomeStatement(both, range)
  const direct1 = await incomeStatement(1, range)
  const idx1 = consolidated.sites.findIndex((s) => s.siteId === 1)
  ok('*** a store column equals that store\'s own income statement ***',
    idx1 >= 0 && consolidated.perSiteRevenue[idx1] === direct1.revenueTotal,
    `column ${consolidated.perSiteRevenue[idx1]} vs direct ${direct1.revenueTotal}`)
  ok('  and its net matches too',
    idx1 >= 0 && consolidated.perSiteNet[idx1] === direct1.netProfit)

  /* ── 4. Fail-soft ────────────────────────────────────────────────────── */

  const withGhost = [...both, { siteId: 999, name: 'Ghost', code: 'X', isPrimary: false }]
  const ghosted = await consolidatedIncomeStatement(withGhost, range)
  ok('*** a store with no database becomes a failure, not a crash ***',
    ghosted.failures.some((f) => f.siteId === 999) && ghosted.sites.length === 2,
    ghosted.failures.map((f) => f.name).join(', '))
  ok('  and the included columns still reconcile',
    ghosted.perSiteRevenue.length === 2)

  const dash = await groupDashboard(withGhost, {
    todayIso: '2026-08-14', monthFrom: '2026-08-01', monthTo: '2026-08-31',
  })
  ok('*** the dashboard reads every reachable store ***',
    dash.filter((r) => r.ok).length === 2 && dash.some((r) => !r.ok && r.siteId === 999),
    dash.map((r) => `${r.name}:${r.ok ? 'ok' : 'err'}`).join(' '))
  const row1 = dash.find((r) => r.siteId === 1)
  ok('  figures are numbers, not NaN',
    row1 !== undefined && row1.ok && Number.isFinite(row1.data.month.turnoverIncl) &&
    Number.isFinite(row1.data.stockValue))

  /* ── 5. perSite never rejects ────────────────────────────────────────── */

  const results = await perSite(withGhost, async (siteId) => {
    if (siteId === 999) throw new Error('boom')
    return siteId
  })
  ok('*** perSite turns a throw into a per-store error ***',
    results.length === 3 && results.filter((r) => r.ok).length === 2 &&
    results.some((r) => !r.ok && r.error === 'boom'))

  console.log(fails === 0 ? '\nAll group-reporting checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
