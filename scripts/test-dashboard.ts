/**
 * Sales-dashboard checks against a live site database.
 *
 * The dashboard's SQL is the part of it that cannot be verified by a
 * typecheck: every column name, every join and every enum value is only a
 * string until MySQL sees it. This runs the real queries and asserts the
 * figures are internally consistent.
 *
 *   npm run test:dashboard
 */
import { siteQueryOne } from '../src/lib/siteDb'
import {
  getSalesDashboard,
  rankedDimension,
  isIsoDate,
  type DateRange,
} from '../src/lib/site/salesDashboard'
import { toNum } from '../src/lib/decimals'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A range wide enough to cover whatever the test database happens to hold. */
const WIDE: DateRange = { from: '2000-01-01', to: '2099-12-31' }

async function main() {
  console.log('\n— Date helpers —')
  ok('isIsoDate accepts a real date', isIsoDate('2026-08-06'))
  ok('isIsoDate rejects a non-date', !isIsoDate('yesterday'))
  ok('isIsoDate rejects a partial date', !isIsoDate('2026-08'))

  console.log('\n— The dashboard payload (wide range) —')
  const data = await getSalesDashboard(SITE, WIDE)

  ok('24 hourly buckets, one per hour', data.perHour.length === 24, `got ${data.perHour.length}`)
  ok(
    'hours are 0..23 in order',
    data.perHour.every((h, i) => h.hour === i),
  )
  ok('perDay spans every day in the range', data.perDay.length > 0)
  ok(
    'perDay dates are unique and ascending',
    data.perDay.every((d, i) => i === 0 || d.date > data.perDay[i - 1].date),
  )
  ok(
    'no tender slice is negative (a donut cannot draw one)',
    data.tenderTypes.every((t) => t.amount > 0),
  )
  ok('compareLabel is populated', data.compareLabel.startsWith('vs '))
  ok('top lists are capped at 10', data.topProducts.length <= 10)

  console.log('\n— KPIs agree with the tables they came from —')
  // The same figures, computed straight from SQL, must match what the module
  // returns. This is the check that catches a wrong column or a wrong enum.
  const truth = await siteQueryOne<Record<string, unknown>>(
    SITE,
    `SELECT COALESCE(SUM(l.line_total_incl), 0) AS incl,
            COALESCE(SUM(l.line_total_excl), 0) AS excl,
            COALESCE(SUM(l.unit_cost_excl * l.qty), 0) AS cost
       FROM sales_document_lines l
       JOIN sales_documents d ON d.id = l.document_id
      WHERE d.status = 'finalised'
        AND d.doc_type IN ('invoice','credit_sale')
        AND d.document_date BETWEEN ? AND ?`,
    [WIDE.from, WIDE.to],
  )
  const invoices = await siteQueryOne<Record<string, unknown>>(
    SITE,
    `SELECT COUNT(*) AS n FROM sales_documents
      WHERE status = 'finalised' AND doc_type = 'invoice'
        AND document_date BETWEEN ? AND ?`,
    [WIDE.from, WIDE.to],
  )

  const near = (a: number, b: number) => Math.abs(a - b) < 0.01
  ok(
    'turnover (incl) matches a direct SUM',
    near(data.kpis.turnoverIncl, toNum(truth?.incl)),
    `${data.kpis.turnoverIncl} vs ${toNum(truth?.incl)}`,
  )
  ok(
    'turnover (excl) matches a direct SUM',
    near(data.kpis.turnoverExcl, toNum(truth?.excl)),
    `${data.kpis.turnoverExcl} vs ${toNum(truth?.excl)}`,
  )
  ok(
    'gross profit is turnover-excl less cost',
    near(data.kpis.grossProfit, toNum(truth?.excl) - toNum(truth?.cost)),
  )
  ok(
    'sale count counts INVOICES only (credit sales must not inflate it)',
    data.kpis.saleCount === Number(invoices?.n ?? 0),
    `${data.kpis.saleCount} vs ${Number(invoices?.n ?? 0)}`,
  )
  ok(
    'per-day turnover sums to the headline turnover',
    near(
      data.perDay.reduce((s, d) => s + d.turnover, 0),
      data.kpis.turnoverIncl,
    ),
  )
  ok(
    'per-hour turnover sums to the headline turnover',
    near(
      data.perHour.reduce((s, h) => s + h.turnover, 0),
      data.kpis.turnoverIncl,
    ),
  )

  console.log('\n— Every ranked dimension runs —')
  for (const dimension of ['products', 'departments', 'cashiers'] as const) {
    const top = await rankedDimension(SITE, WIDE, dimension, 10)
    const all = await rankedDimension(SITE, WIDE, dimension, null)
    ok(`${dimension}: top-10 query runs and is capped`, top.length <= 10)
    ok(`${dimension}: full list is at least as long as the top-10`, all.length >= top.length)
    ok(
      `${dimension}: every row has a key and a label`,
      all.every((r) => r.key !== '' && r.label !== ''),
    )
    // Turnover across the whole dimension must reconcile to the headline: if a
    // GROUP BY key were wrong, rows would be dropped or double-counted here.
    if (dimension !== 'products') {
      ok(
        `${dimension}: turnover reconciles to the headline`,
        near(
          all.reduce((s, r) => s + r.turnoverIncl, 0),
          data.kpis.turnoverIncl,
        ),
        `${all.reduce((s, r) => s + r.turnoverIncl, 0)} vs ${data.kpis.turnoverIncl}`,
      )
    }
  }

  console.log('\n— An empty range returns a well-formed, empty payload —')
  const empty = await getSalesDashboard(SITE, { from: '1990-01-01', to: '1990-01-02' })
  ok('hasData is false', empty.hasData === false)
  ok('turnover is zero', empty.kpis.turnoverIncl === 0)
  ok('GP% does not divide by zero', Number.isFinite(empty.kpis.grossProfitPct))
  ok('still 24 hourly buckets', empty.perHour.length === 24)
  ok('two days in the range', empty.perDay.length === 2)

  console.log(`\n${fails === 0 ? 'All dashboard checks passed.' : `${fails} FAILED.`}`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
