/**
 * Do the product Reporting-tab specs actually RUN?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/test-product-reports.ts
 *
 * These are builder specs, so tsc proves only that the object literals have the
 * right shape — it cannot know whether a field key exists on its source, and a
 * wrong one is either a throw or, worse, a silently empty report that reads as
 * "this product has no history".
 *
 * So every report is run against a real product on a real site, and the run is
 * required to return COLUMNS. Rows may legitimately be zero (a product that has
 * never been counted has no stock takes), but a spec naming a field its source
 * does not have cannot produce a column list at all.
 */
import { siteQueryOne } from '../src/lib/siteDb'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { PRODUCT_REPORTS } from '../src/lib/reportBuilder/productReports'

const SITE = 2
/* Every capability granted: this asks whether the SPECS are valid, not whether
   permissions work — the engine's own permission check is exercised elsewhere. */
const canAll = () => true

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  // A product with actual history, so at least some reports return rows and a
  // universal zero stands out as suspicious rather than looking normal.
  const product = await siteQueryOne<any>(
    SITE,
    `SELECT p.id, p.code, p.description
       FROM products p
       JOIN stock_movements m ON m.product_id = p.id
      GROUP BY p.id
      ORDER BY COUNT(m.id) DESC
      LIMIT 1`,
  )
  if (!product) {
    console.log('No product with movements on this site — cannot test.')
    process.exit(1)
  }
  console.log(`Product: #${product.id} ${product.code} — ${product.description}\n`)

  let withRows = 0
  for (const report of PRODUCT_REPORTS) {
    const spec = report.spec({ id: Number(product.id), code: String(product.code) })
    try {
      const result = await runBuilderSpec(SITE, spec, canAll)
      const cols = result.columns.length
      if (result.rows.length > 0) withRows++
      ok(
        `${report.id} runs`,
        cols > 0,
        `${cols} columns, ${result.rows.length} rows${result.truncated ? ' (truncated)' : ''}`,
      )
    } catch (e: any) {
      ok(`${report.id} runs`, false, e?.message ?? String(e))
    }
  }

  console.log('')
  ok(
    'at least one report returned rows',
    withRows > 0,
    `${withRows} of ${PRODUCT_REPORTS.length} had data`,
  )

  /*
   * A report that returns nothing proves nothing about its FILTER — a renamed
   * field or a wrong code produces exactly the same empty table. So each report
   * whose source holds data somewhere is re-run against a product that actually
   * has that kind of history, and is then required to find it.
   *
   * This is the check that would have caught a pin on the wrong column.
   */
  console.log('\n── Filters, against products that DO have the history ──')

  const targets: [string, string][] = [
    ['product-adjustments', `SELECT product_code AS c FROM stock_adjustment_lines GROUP BY product_code ORDER BY COUNT(*) DESC LIMIT 1`],
    ['product-grv', `SELECT product_code AS c FROM purchase_document_lines GROUP BY product_code ORDER BY COUNT(*) DESC LIMIT 1`],
    ['product-stock-takes', `SELECT product_code AS c FROM stock_take_lines GROUP BY product_code ORDER BY COUNT(*) DESC LIMIT 1`],
    ['product-voids', `SELECT product_code AS c FROM pos_void_events GROUP BY product_code ORDER BY COUNT(*) DESC LIMIT 1`],
  ]

  for (const [reportId, findSql] of targets) {
    const found = await siteQueryOne<any>(SITE, findSql).catch(() => null)
    const report = PRODUCT_REPORTS.find((r) => r.id === reportId)!
    if (!found?.c) {
      console.log(`SKIP  ${reportId} — this site has no such history to test against`)
      continue
    }
    const row = await siteQueryOne<any>(SITE, `SELECT id, code FROM products WHERE code = ?`, [
      found.c,
    ])
    if (!row) {
      console.log(`SKIP  ${reportId} — ${found.c} is not a live product`)
      continue
    }
    const result = await runBuilderSpec(
      SITE,
      report.spec({ id: Number(row.id), code: String(row.code) }),
      canAll,
    )
    ok(
      `${reportId} FINDS the history for ${row.code}`,
      result.rows.length > 0,
      `${result.rows.length} rows`,
    )
  }

  // The activity log pins on (entity, entity_id), not a product code — a
  // different filter, so it needs its own check.
  const active = await siteQueryOne<any>(
    SITE,
    `SELECT entity_id AS id FROM activity_log WHERE entity = 'product'
      GROUP BY entity_id ORDER BY COUNT(*) DESC LIMIT 1`,
  ).catch(() => null)
  if (active?.id) {
    const row = await siteQueryOne<any>(SITE, `SELECT id, code FROM products WHERE id = ?`, [
      active.id,
    ])
    const report = PRODUCT_REPORTS.find((r) => r.id === 'product-activity')!
    const result = await runBuilderSpec(
      SITE,
      report.spec({ id: Number(active.id), code: String(row?.code ?? '') }),
      canAll,
    )
    ok(
      `product-activity FINDS the log for product #${active.id}`,
      result.rows.length > 0,
      `${result.rows.length} rows`,
    )
  } else {
    console.log('SKIP  product-activity — no product activity on this site')
  }

  console.log(fails === 0 ? '\nAll checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
