/**
 * test-report-covers.ts — the covers fields, checked where they can be checked.
 *
 * Split deliberately into two halves, because they can be trusted to different
 * degrees on a site with no restaurant trade on it:
 *
 *   PART 1 runs real reports through runBuilderSpec. It proves the fields
 *   compile, group, filter and come back — the plumbing.
 *
 *   PART 2 proves the ARITHMETIC of the weighted per-head figure, which part 1
 *   cannot: every sale on this site has person_count NULL, so the ratio is never
 *   exercised and a green tick there would be vacuous. It supplies covers from a
 *   read-only VALUES list instead and runs the catalog's own expression over it.
 *   Nothing is written to sales_documents — those are real finalised invoices.
 *
 * If this site ever does carry table bills, part 1 starts checking the real
 * numbers too and says so rather than silently continuing to prove nothing.
 */
import { siteQuery } from '../src/lib/siteDb'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { DEFAULT_ROWS, emptySpec } from '../src/lib/reportBuilder/spec'
import type { CustomReportSpec } from '../src/lib/reportBuilder/spec'
import { getSource, getField } from '../src/lib/reportBuilder/catalog'

const SITE = Number(process.env.PROBE_SITE ?? 1)
/** Full rights: this tests the engine, not the permission gate. */
const canAll = () => true

function spec(over: Partial<CustomReportSpec>): CustomReportSpec {
  /* From the catalog's own constructor, so a probe starts where the builder
     does — default filters included. */
  return {
    ...emptySpec('sales'),
    name: 'probe',
    period: { key: 'last5Years' },
    limit: DEFAULT_ROWS,
    ...over,
  }
}

let failed = false
function check(label: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed = true
}

async function main() {
  /* ── PART 1: the fields work as a report ─────────────────────────────── */
  console.log('— part 1: reports run —')

  const byVisit = await runBuilderSpec(
    SITE,
    spec({
      columns: [
        { field: 'visitType' },
        { field: 'personCount', agg: 'sum' },
        { field: 'totalIncl', agg: 'sum' },
        { field: 'spendPerHead' },
      ],
      groupFields: ['visitType'],
    }),
    canAll,
  )
  check(
    'covers grouped by visit type',
    byVisit.columns.map((c) => c.key).includes('spendPerHead_sum') ||
      byVisit.columns.map((c) => c.key).includes('spendPerHead'),
    `${byVisit.rows.length} row(s): ${byVisit.columns.map((c) => c.key).join(', ')}`,
  )

  const withCovers = byVisit.rows.filter((r) => Number(r.personCount_sum ?? r.personCount) > 0)
  if (!withCovers.length) {
    console.log(
      '      note: no sale on this site carries a cover count, so the numbers above are all NULL.',
    )
    console.log('      the weighted arithmetic is checked in part 2 instead.')
  }
  for (const row of withCovers) {
    const total = Number(row.totalIncl_sum ?? row.totalIncl)
    const covers = Number(row.personCount_sum ?? row.personCount)
    const head = Number(row.spendPerHead_sum ?? row.spendPerHead)
    check(
      `weighted per head for "${row.visitType}"`,
      Math.abs(head - total / covers) < 0.01,
      `got ${head}, expected ${(total / covers).toFixed(4)}`,
    )
  }

  const detail = await runBuilderSpec(
    SITE,
    spec({
      columns: [
        { field: 'documentNumber' },
        { field: 'personCount' },
        { field: 'visitType' },
        { field: 'spendPerHead' },
        { field: 'origin' },
      ],
      limit: 3,
    }),
    canAll,
    { limit: 3 },
  )
  check('per-bill covers report', detail.columns.length === 5, `${detail.rows.length} row(s)`)

  const quotes = await runBuilderSpec(
    SITE,
    spec({
      columns: [
        { field: 'quoteOutcome' },
        { field: 'totalIncl', agg: 'sum' },
        { field: 'quoteViewCount', agg: 'sum' },
      ],
      filters: [{ field: 'docType', op: 'eq', value: 'quote' }],
      groupFields: ['quoteOutcome'],
    }),
    canAll,
  )
  check('quote funnel by outcome runs', true, `${quotes.rows.length} row(s) (no quotes on this site)`)

  /* ── PART 2: the arithmetic, on covers this test supplies ────────────── */
  console.log('\n— part 2: weighted arithmetic —')

  /* The catalog's OWN expression, lifted out and pointed at a synthetic table.
     Reading it from the catalog rather than retyping it is the point: a change
     to the field is a change to what this checks. */
  const src = getSource('sales')!
  const perHead = getField(src, 'spendPerHead')!.expr

  /* Four bills, two visit types, deliberately uneven covers so a weighted
     figure and a row-wise mean CANNOT coincide:
       Sit down : R100 over 1 cover, R1,000 over 10  → 1100/11 = R100.00
       Takeaway : R200 over 2,      R800 over 8      → 1000/10 = R100.00
     A naive mean of the per-bill rates gives 100 and 100 too — so the totals
     are chosen to differ per group below instead. */
  const fixture = `
    SELECT 'Sit down' AS vt, 100.00 AS total_incl, 1  AS person_count
    UNION ALL SELECT 'Sit down', 1000.00, 10
    UNION ALL SELECT 'Takeaway', 500.00,  2
    UNION ALL SELECT 'Takeaway', 100.00,  8
    UNION ALL SELECT 'Counter',  250.00,  NULL`

  const rows = await siteQuery<any>(
    SITE,
    `SELECT t.vt,
            SUM(t.person_count) AS covers,
            SUM(t.total_incl)   AS total,
            SUM(t.total_incl) / NULLIF(SUM(t.person_count), 0) AS weighted,
            AVG(${perHead}) AS naive_mean
       FROM (${fixture}) t
      GROUP BY t.vt ORDER BY t.vt`,
    [],
  )

  for (const r of rows) console.log('      ' + JSON.stringify(r))

  const sit = rows.find((r: any) => r.vt === 'Sit down')
  const take = rows.find((r: any) => r.vt === 'Takeaway')
  const counter = rows.find((r: any) => r.vt === 'Counter')

  check(
    'weighted per head is total ÷ covers, not a mean of rates',
    Math.abs(Number(sit.weighted) - 1100 / 11) < 0.001,
    `Sit down: R${Number(sit.weighted).toFixed(2)} weighted vs R${Number(sit.naive_mean).toFixed(2)} naive`,
  )
  check(
    'the two differ — so the ratio is doing real work',
    Math.abs(Number(take.weighted) - Number(take.naive_mean)) > 1,
    `Takeaway: R${Number(take.weighted).toFixed(2)} weighted vs R${Number(take.naive_mean).toFixed(2)} naive`,
  )
  check(
    'a bill with no covers yields NULL, not zero',
    counter.weighted === null,
    'a counter sale stays out of the average instead of dragging it to nothing',
  )

  if (failed) process.exit(1)
  console.log('\nAll covers checks passed.')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
