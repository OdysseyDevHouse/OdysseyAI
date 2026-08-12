/**
 * Per-store report columns — visibility AND order.
 *
 * WHAT THIS EXISTS TO PROVE is that the stored choice is applied the same way
 * to every consumer. The grid, the spreadsheet, the CSV and the scheduled email
 * all read one ordered ReportColumn[], so applyStoreColumns is the one place
 * that can get it wrong for all four at once.
 *
 * Also proved: unknown keys are dropped rather than leaving holes, an empty set
 * is refused, and a stored set that matches nothing falls back to the report's
 * own columns instead of rendering a table with no columns.
 *
 *   npm run test:report-columns
 */
import { siteExecute, siteQueryOne } from '../src/lib/siteDb'
import {
  reportColumnsFor,
  setReportColumns,
  clearReportColumns,
  applyStoreColumns,
} from '../src/lib/site/reportColumns'
import type { ReportColumn } from '../src/lib/reportBuilder/spec'

const SITE = 1
const REPORT = 'zz-test-report'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

const col = (key: string, total = false): ReportColumn => ({
  key,
  label: key,
  type: 'text',
  numeric: false,
  total,
})

const COLUMNS = [col('code'), col('description'), col('qty', true), col('total', true)]
const KEYS = COLUMNS.map((c) => c.key)

async function sweep() {
  await siteExecute(SITE, 'DELETE FROM report_columns WHERE report_id LIKE ?', ['zz-%'])
}

async function main() {
  await sweep()

  console.log('\n── Nothing stored ──')
  ok('*** a report with no stored choice reads null ***',
    (await reportColumnsFor(SITE, REPORT, KEYS)) === null)
  ok('  and renders its own columns, in its own order',
    applyStoreColumns(COLUMNS, null).map((c) => c.key).join(',') === 'code,description,qty,total')

  console.log('\n── Hiding ──')
  const hid = await setReportColumns(SITE, REPORT, ['code', 'total'], KEYS, 1)
  ok('*** a subset can be stored ***', hid.ok, hid.ok ? '' : hid.error)
  const afterHide = await reportColumnsFor(SITE, REPORT, KEYS)
  ok('  and reads back as exactly that subset',
    afterHide?.join(',') === 'code,total', String(afterHide))
  ok('*** the hidden columns are gone from what renders ***',
    applyStoreColumns(COLUMNS, afterHide).map((c) => c.key).join(',') === 'code,total')

  console.log('\n── Ordering ──')
  await setReportColumns(SITE, REPORT, ['total', 'code', 'description'], KEYS, 1)
  const reordered = await reportColumnsFor(SITE, REPORT, KEYS)
  ok('*** ORDER is stored, not just membership ***',
    reordered?.join(',') === 'total,code,description', String(reordered))
  ok('*** and the rendered columns come back in THAT order ***',
    applyStoreColumns(COLUMNS, reordered).map((c) => c.key).join(',') === 'total,code,description')
  ok('  which is not the report\'s own order',
    applyStoreColumns(COLUMNS, reordered)[0].key !== COLUMNS[0].key)

  console.log('\n── A column the report no longer has ──')
  await siteExecute(
    SITE,
    `INSERT INTO report_columns (report_id, columns) VALUES (?,?)
     ON DUPLICATE KEY UPDATE columns = VALUES(columns)`,
    [REPORT, JSON.stringify(['code', 'renamedAwayLastYear', 'total'])],
  )
  const survivor = await reportColumnsFor(SITE, REPORT, KEYS)
  ok('*** an unknown key is DROPPED on read ***',
    survivor?.join(',') === 'code,total', String(survivor))
  ok('  leaving no hole in the rendered columns',
    applyStoreColumns(COLUMNS, survivor).length === 2)

  console.log('\n── Refusals and fallbacks ──')
  const empty = await setReportColumns(SITE, REPORT, [], KEYS, 1)
  ok('*** an empty set is refused ***', !empty.ok, !empty.ok ? empty.error : '')

  const junkOnly = await setReportColumns(SITE, REPORT, ['nope', 'alsoNope'], KEYS, 1)
  ok('  and so is a set of keys the report does not have', !junkOnly.ok)

  ok('*** a stored set matching NOTHING falls back to the report\'s columns ***',
    applyStoreColumns(COLUMNS, ['gone', 'alsoGone']).length === COLUMNS.length,
    'else the report would render with no columns at all')

  console.log('\n── Clearing ──')
  await clearReportColumns(SITE, REPORT)
  ok('*** clearing returns the report to its own columns ***',
    (await reportColumnsFor(SITE, REPORT, KEYS)) === null)

  console.log('\n── The id space ──')
  await setReportColumns(SITE, 'zz-saved:99', ['code'], KEYS, 1)
  const saved = await reportColumnsFor(SITE, 'zz-saved:99', KEYS)
  ok('*** a saved report id (with its colon) stores and reads back ***',
    saved?.join(',') === 'code', String(saved))
  const builtin = await reportColumnsFor(SITE, REPORT, KEYS)
  ok('  without colliding with a built-in id', builtin === null)

  await sweep()
  const left = await siteQueryOne<any>(
    SITE,
    "SELECT COUNT(*) c FROM report_columns WHERE report_id LIKE 'zz-%'",
  )
  ok('no test rows left behind', Number(left?.c) === 0)

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch(async (error) => {
  console.error(error)
  await sweep()
  console.log('\nCRASHED — strays swept')
  process.exit(1)
})
