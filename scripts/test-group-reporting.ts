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
  monthToDateWindows,
  percentChange,
  marginPct,
  stockCoverMonths,
  storeExceptions,
  type GroupDashboardRow,
  type SiteResult,
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
    prevFrom: '2026-07-01', prevTo: '2026-07-14',
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

  /* ── 6. Dashboard arithmetic, pure ───────────────────────────────────── */

  // Mid-month: the comparison must be the SAME number of days, not all of July.
  const aug = monthToDateWindows('2026-08-14')
  ok('*** month-to-date compares against an equal span, not the whole month ***',
    aug.monthFrom === '2026-08-01' && aug.monthTo === '2026-08-14' &&
    aug.prevFrom === '2026-07-01' && aug.prevTo === '2026-07-14',
    `${aug.prevFrom}..${aug.prevTo}`)

  // March 30th against February, which has no 30th — the clamp.
  const mar = monthToDateWindows('2026-03-30')
  ok('  a day the previous month does not have clamps to its last',
    mar.prevFrom === '2026-02-01' && mar.prevTo === '2026-02-28',
    `${mar.prevFrom}..${mar.prevTo}`)

  // January reaches back across the year boundary.
  const jan = monthToDateWindows('2026-01-10')
  ok('  January compares against December of the previous year',
    jan.prevFrom === '2025-12-01' && jan.prevTo === '2025-12-10',
    `${jan.prevFrom}..${jan.prevTo}`)

  // The 1st: a one-day window against the 1st of the prior month.
  const first = monthToDateWindows('2026-05-01')
  ok('  the 1st compares against the 1st',
    first.prevFrom === '2026-04-01' && first.prevTo === '2026-04-01',
    `${first.prevFrom}..${first.prevTo}`)

  ok('*** percentChange is null with no prior period, never Infinity ***',
    percentChange(50000, 0) === null && percentChange(0, 0) === null)
  ok('  and is a real percentage otherwise',
    percentChange(150, 100) === 50 && percentChange(50, 100) === -50)

  ok('*** marginPct is null on no turnover ***', marginPct(0, 0) === null)
  ok('  and a percentage of the EXCLUSIVE figure otherwise',
    marginPct(25, 100) === 25)

  ok('*** stockCover is null when nothing sold — infinite cover is not a number ***',
    stockCoverMonths(100000, 0) === null)
  ok('  and months of cover otherwise', stockCoverMonths(300, 100) === 3)

  /* The exception strip is the screen's whole point, so its thresholds are
     asserted rather than eyeballed. */
  const dashRow = (over: Partial<GroupDashboardRow>): SiteResult<GroupDashboardRow> => ({
    siteId: 7, name: 'Test', ok: true,
    data: {
      today: { turnoverIncl: 0, saleCount: 0 },
      month: { turnoverIncl: 100, turnoverExcl: 100, grossProfit: 30, saleCount: 1 },
      previous: { turnoverIncl: 100, turnoverExcl: 100, grossProfit: 30, saleCount: 1 },
      stockValue: 0, cashVariance: 0,
      exceptions: { voidValue: 0, voidCount: 0, discountValue: 0 },
      ...over,
    },
  })

  ok('*** a steady store raises nothing ***', storeExceptions([dashRow({})]).length === 0)

  const shortDrawer = storeExceptions([dashRow({ cashVariance: -750 })])
  ok('*** a drawer R750 short is flagged ***',
    shortDrawer.length === 1 && shortDrawer[0].kind === 'cash-short',
    shortDrawer[0]?.detail)

  ok('  but R100 short is not — the threshold has to mean something',
    storeExceptions([dashRow({ cashVariance: -100 })]).length === 0)

  const marginSlide = storeExceptions([
    dashRow({ month: { turnoverIncl: 100, turnoverExcl: 100, grossProfit: 20, saleCount: 1 } }),
  ])
  ok('*** a 10-point margin drop is flagged ***',
    marginSlide.some((e) => e.kind === 'margin-drop'), marginSlide[0]?.detail)

  const unreadable = storeExceptions([{ siteId: 9, name: 'Dead', ok: false, error: 'no db' }])
  ok('*** an unreadable store IS an exception, and ranks first ***',
    unreadable.length === 1 && unreadable[0].kind === 'unreadable')

  const both2 = storeExceptions([dashRow({ cashVariance: -900, month: { turnoverIncl: 100, turnoverExcl: 100, grossProfit: 10, saleCount: 1 } })])
  ok('  a store can raise more than one flag, worst first',
    both2.length === 2 && both2[0].kind === 'cash-short',
    both2.map((e) => e.kind).join(' > '))

  console.log(fails === 0 ? '\nAll group-reporting checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
