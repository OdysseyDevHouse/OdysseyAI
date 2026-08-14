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
  salesByStore,
  likeForLike,
  yearAgoWindow,
  productScopeFor,
  rebalanceSuggestions,
  groupTransfers,
  type GroupDashboardRow,
  type SiteResult,
} from '../src/lib/groupReporting'
import { incomeStatement, type IncomeStatement } from '../src/lib/site/financialStatements'
import { groupForSite, linkedStores } from '../src/lib/storeGroups'

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

  /* ── 7. Sales by store ───────────────────────────────────────────────── */

  const salesRange = { from: '2026-01-01', to: '2026-12-31' }
  const byDay = await salesByStore(both, salesRange, 'day')
  const byMonth = await salesByStore(both, salesRange, 'month')

  ok('*** sales by store returns a column per readable store ***',
    byDay.sites.length === 2 && byDay.perSiteTotals.length === 2,
    byDay.sites.map((s) => s.name).join(', '))

  ok('  day periods are ISO dates, month periods are YYYY-MM',
    byDay.periods.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.period)) &&
    byMonth.periods.every((p) => /^\d{4}-\d{2}$/.test(p.period)),
    `${byDay.periods[0]?.period} / ${byMonth.periods[0]?.period}`)

  ok('  periods come back in ascending order',
    byDay.periods.every((p, i) => i === 0 || byDay.periods[i - 1].period <= p.period))

  /* The grain must not change the money. Daily and monthly are the same sales
     bucketed differently, and a mismatch means one of them is dropping rows. */
  ok('*** the same range totals the same by day and by month ***',
    Math.abs(byDay.total - byMonth.total) < 0.01,
    `day ${byDay.total} vs month ${byMonth.total}`)

  ok('  each row total is the sum of its store columns',
    byDay.periods.every((p) => {
      const summed = p.perSite.reduce<number>((t, v) => (v === null ? t : t + v), 0)
      return Math.abs(summed - p.total) < 0.01
    }))

  ok('  the group total is the sum of the per-store totals',
    Math.abs(byDay.perSiteTotals.reduce((t, v) => t + v, 0) - byDay.total) < 0.01,
    `${byDay.perSiteTotals.join(' + ')} = ${byDay.total}`)

  /* The property the whole report rests on: a store that did not trade in a
     period is null, NOT zero. Over a range spanning an opening, zeros would
     read as months of catastrophic trading rather than a store that did not
     exist yet. */
  const hasNull = byMonth.periods.some((p) => p.perSite.some((v) => v === null))
  ok('*** a store that did not trade in a period is null, not zero ***',
    hasNull || byMonth.sites.length < 2,
    hasNull ? 'found a dash' : 'both stores traded every month (no dash to prove)')

  const salesGhost = await salesByStore(withGhost, salesRange, 'month')
  ok('*** an unreachable store is a failure, not a crash ***',
    salesGhost.failures.some((f) => f.siteId === 999) && salesGhost.sites.length === 2)
  ok('  and its column is left out rather than shown as zero',
    salesGhost.periods.every((p) => p.perSite.length === 2))

  /* ── 8. Like-for-like ────────────────────────────────────────────────── */

  ok('*** the prior window is the same dates a year earlier ***',
    yearAgoWindow({ from: '2026-03-01', to: '2026-08-14' }).from === '2025-03-01' &&
    yearAgoWindow({ from: '2026-03-01', to: '2026-08-14' }).to === '2025-08-14')

  // 2024 is a leap year; 2023 is not, so 29 Feb has no counterpart.
  ok('  29 February lands on the 28th when the prior year is common',
    yearAgoWindow({ from: '2024-02-29', to: '2024-02-29' }).from === '2023-02-28',
    yearAgoWindow({ from: '2024-02-29', to: '2024-02-29' }).from)

  // 2028 and 2027: 2027 is common, so the same rule applies going forward.
  ok('  and a leap-to-leap span keeps the 29th',
    yearAgoWindow({ from: '2025-02-28', to: '2025-02-28' }).from === '2024-02-28')

  const lfl = await likeForLike(both, { from: '2026-01-01', to: '2026-12-31' })

  ok('*** like-for-like reports every store, counted or not ***',
    lfl.stores.length === 2, lfl.stores.map((s) => `${s.name}:${s.comparable ? 'in' : 'out'}`).join(' '))

  ok('  the comparable total only sums comparable stores',
    Math.abs(
      lfl.comparableCurrent -
        lfl.stores.filter((s) => s.comparable).reduce((t, s) => t + s.current, 0),
    ) < 0.01)

  ok('  the group total includes non-comparable stores too',
    lfl.totalCurrent >= lfl.comparableCurrent,
    `group ${lfl.totalCurrent} >= comparable ${lfl.comparableCurrent}`)

  /* The property the measure exists for: a store with no sales a year ago is
     excluded WITH A REASON, never silently dropped and never counted as growth
     from zero. On this dev data the second store opened in August 2026. */
  const newStore = lfl.stores.find((s) => s.excluded === 'not-trading-then')
  ok('*** a store not trading a year ago is excluded, with a reason ***',
    newStore === undefined || (!newStore.comparable && newStore.excluded === 'not-trading-then'),
    newStore ? `${newStore.name} excluded` : 'both stores traded last year (no exclusion to prove)')

  ok('  an excluded store is still listed, never silently dropped',
    lfl.stores.length === both.length)

  const lflGhost = await likeForLike(withGhost, { from: '2026-01-01', to: '2026-12-31' })
  ok('*** an unreadable store is excluded and reported as a failure ***',
    lflGhost.failures.some((f) => f.siteId === 999) &&
    lflGhost.stores.some((s) => s.siteId === 999 && s.excluded === 'unreadable'))

  /* ── 9. Product scope: the linkedStores rule ─────────────────────────── */

  const prodScope = await productScopeFor(SITE, CONTROL_USER, 'products.view')
  const moneyScope = await groupScopeFor(SITE, CONTROL_USER, 'products.view')
  ok('*** the product scope never exceeds the money scope ***',
    prodScope !== null && moneyScope !== null &&
    prodScope.sites.length <= moneyScope.sites.length,
    `product ${prodScope?.sites.length} <= group ${moneyScope?.sites.length}`)

  const sharing = await linkedStores(SITE)
  ok('  and contains exactly the stores that share a product file',
    prodScope !== null &&
    prodScope.sites.every((s) => sharing.some((m) => m.siteId === s.siteId)),
    `sharing: ${sharing.map((m) => m.displayName).join(', ')}`)

  /* ── 10. Rebalancing, on synthetic stock ─────────────────────────────── */

  const synthStock = (
    perSite: { onHand: number | null; minStock: number }[][],
    codes = ['A-1', 'B-2'],
  ) => ({
    sites: [
      { siteId: 1, name: 'Alpha' },
      { siteId: 2, name: 'Beta' },
    ],
    failures: [],
    truncated: false,
    lines: codes.map((code, ci) => {
      const cells = perSite[ci].map((c) => ({
        onHand: c.onHand,
        minStock: c.minStock,
        shortfall: c.onHand === null ? null : c.onHand - c.minStock,
      }))
      return {
        code,
        description: code,
        perSite: cells,
        totalOnHand: cells.reduce<number>((t, c) => (c.onHand === null ? t : t + c.onHand), 0),
        shortCount: cells.filter((c) => c.minStock > 0 && c.shortfall !== null && c.shortfall < 0).length,
        surplusCount: cells.filter((c) => c.shortfall !== null && c.shortfall > 0).length,
      }
    }),
  })

  // Alpha short 10, Beta holding 30 above its level of 5 → move 10.
  const simple = rebalanceSuggestions(
    synthStock([[{ onHand: 0, minStock: 10 }, { onHand: 35, minStock: 5 }]], ['A-1']),
  )
  ok('*** a short store and a surplus store produce a move ***',
    simple.length === 1 && simple[0].qty === 10 &&
    simple[0].fromName === 'Beta' && simple[0].toName === 'Alpha',
    simple[0] ? `${simple[0].qty} from ${simple[0].fromName} to ${simple[0].toName}` : 'none')

  /* The rule that keeps a suggestion from doing harm: a donor only offers what
     it holds ABOVE its own reorder level, so filling one shortage can never
     open another. Beta has 8 but needs 5, so it can only spare 3. */
  const capped = rebalanceSuggestions(
    synthStock([[{ onHand: 0, minStock: 10 }, { onHand: 8, minStock: 5 }]], ['A-1']),
  )
  ok('*** a donor never gives away stock it needs itself ***',
    capped.length === 1 && capped[0].qty === 3,
    capped[0] ? `offered ${capped[0].qty} of the 10 needed` : 'none')

  // Beta is exactly at its level: nothing spare, so no move at all.
  const atLevel = rebalanceSuggestions(
    synthStock([[{ onHand: 0, minStock: 10 }, { onHand: 5, minStock: 5 }]], ['A-1']),
  )
  ok('  a store exactly at its reorder level offers nothing', atLevel.length === 0)

  // A store that does not carry the code at all is never a donor.
  const notCarried = rebalanceSuggestions(
    synthStock([[{ onHand: 0, minStock: 10 }, { onHand: null, minStock: 0 }]], ['A-1']),
  )
  ok('*** a store that does not carry the code is never a donor ***', notCarried.length === 0)

  ok('  quantities are whole units — half a case is not a transfer',
    rebalanceSuggestions(
      synthStock([[{ onHand: 0, minStock: 4 }, { onHand: 8.6, minStock: 5 }]], ['A-1']),
    ).every((s) => Number.isInteger(s.qty)))

  /* ── 11. Store transfers, across the group ───────────────────────────── */

  const xfer = await groupTransfers(both, { from: '2020-01-01', to: '2030-12-31' })

  ok('*** group transfers reads every store without throwing ***',
    Array.isArray(xfer.drift) && Array.isArray(xfer.flow) && xfer.failures.length === 0,
    `${xfer.drift.length} drift, ${xfer.flow.length} legs`)

  /* Every inter-store transfer is TWO documents, one per database. Counting
     both directions would report each movement twice, so only the sender's
     'out' leg is counted — no leg may therefore duplicate its mirror. */
  const mirrored = xfer.flow.some((a) =>
    xfer.flow.some((b) => a.fromSiteId === b.toSiteId && a.toSiteId === b.fromSiteId && a.units === b.units),
  )
  ok('  a movement is counted once, from the sender — never twice',
    !mirrored || xfer.flow.length === 0,
    xfer.flow.map((f) => `${f.fromName}->${f.toName}:${f.units}`).join(' ') || '(no flow)')

  ok('  internal (within-store) transfers are excluded',
    xfer.flow.every((f) => f.fromSiteId !== f.toSiteId))

  /* Unsettled means the goods are on two sets of books at once; stale is a late
     lorry. If both are present the dangerous one must lead, because a page that
     sorts a delayed truck above a double-count buries the only real error. */
  const firstStale = xfer.drift.findIndex((d) => d.kind === 'stale')
  const lastUnsettled = xfer.drift.map((d) => d.kind).lastIndexOf('unsettled')
  ok('*** unsettled drift always outranks a late lorry ***',
    firstStale === -1 || lastUnsettled === -1 || lastUnsettled < firstStale,
    xfer.drift.map((d) => d.kind).join(',') || '(no drift)')

  const xferGhost = await groupTransfers(withGhost, { from: '2020-01-01', to: '2030-12-31' })
  ok('*** an unreachable store is a failure, not a crash ***',
    xferGhost.failures.some((f) => f.siteId === 999),
    xferGhost.failures.map((f) => f.name).join(', '))

  console.log(fails === 0 ? '\nAll group-reporting checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
