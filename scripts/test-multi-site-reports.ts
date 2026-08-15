/**
 * Running one report spec across every linked store.
 *
 * The property that matters: a merged figure equals the sum of what each store
 * reports on its own. If those two ever disagree, one of them is lying, and the
 * merged one is the one people will quote.
 *
 *   npm run test:multi-site-reports
 */
import { runAcrossSites, mergeRefusalFor, STORE_COLUMN_KEY } from '../src/lib/reportBuilder/runAcrossSites'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { groupScopeFor } from '../src/lib/groupReporting'
import { capabilitiesForRole, can, type Capability } from '../src/lib/site/permissions'
import { getUserByControlId } from '../src/lib/site/users'
import type { CustomReportSpec } from '../src/lib/reportBuilder/spec'

const SITE = 1
const CONTROL_USER = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** A spec with the defaults the builder applies, so tests name only what matters. */
function spec(partial: Partial<CustomReportSpec> & Pick<CustomReportSpec, 'source'>): CustomReportSpec {
  return {
    version: 1,
    name: 'Test',
    period: { key: 'thisYear' },
    columns: [],
    filters: [],
    groupFields: [],
    totalFilters: [],
    limit: 500,
    ...partial,
  }
}

async function main() {
  const scope = await groupScopeFor(SITE, CONTROL_USER, 'reports.view')
  if (!scope || scope.sites.length < 2) {
    console.log('Needs a group of at least two readable stores. Skipping.')
    process.exit(0)
  }
  console.log(`Group: ${scope.group.name} (${scope.sites.map((s) => s.name).join(', ')})\n`)

  /* Capabilities are resolved per store, exactly as the real caller must: a user
     holds a different role in each shop. */
  const capsBySite = new Map<number, (c: Capability) => boolean>()
  for (const site of scope.sites) {
    const local = await getUserByControlId(site.siteId, CONTROL_USER)
    const caps = local ? await capabilitiesForRole(site.siteId, local.roleId) : null
    capsBySite.set(site.siteId, (c: Capability) => (caps ? can(caps, c) : false))
  }
  const canFor = (siteId: number) => capsBySite.get(siteId) ?? (() => false)

  console.log('What can and cannot be merged')

  ok('*** a sum/count spec is accepted ***',
    mergeRefusalFor(spec({
      source: 'sales',
      groupFields: ['userName'],
      columns: [{ field: '__rows' }, { field: 'totalIncl', agg: 'sum' }],
    })) === null)

  const avgRefusal = mergeRefusalFor(spec({
    source: 'sales',
    groupFields: ['userName'],
    columns: [{ field: 'totalIncl', agg: 'avg' }],
  }))
  ok('*** a plain average is REFUSED, not silently averaged ***',
    avgRefusal?.reason === 'aggregate', avgRefusal?.message.slice(0, 60))

  for (const agg of ['min', 'max'] as const) {
    ok(`  ${agg} is refused too`,
      mergeRefusalFor(spec({
        source: 'sales',
        groupFields: ['userName'],
        columns: [{ field: 'totalIncl', agg }],
      }))?.reason === 'aggregate')
  }

  const topRefusal = mergeRefusalFor(spec({
    source: 'saleLines',
    groupFields: ['lineDepartment', 'productCode'],
    columns: [{ field: 'lineTotalIncl', agg: 'sum' }],
    topPerGroup: 5,
  }))
  ok('*** top-N per group is refused — a per-store top 5 is not the group\'s ***',
    topRefusal?.reason === 'top-n', topRefusal?.message.slice(0, 60))

  console.log('\nMerged figures equal the sum of the parts')

  /* The load-bearing assertion. Run the SAME spec per store directly, add the
     totals up by hand, and compare against what the merge produced. */
  const summarySpec = spec({
    source: 'sales',
    groupFields: ['userName'],
    columns: [{ field: '__rows' }, { field: 'totalIncl', agg: 'sum' }],
    filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
  })

  const merged = await runAcrossSites(scope.sites, summarySpec, canFor)
  ok('*** the merge ran and reported its stores ***',
    merged.refusal === undefined && merged.sites.length >= 1,
    `${merged.sites.length} stores, ${merged.rows.length} rows`)

  let handSummed = 0
  for (const site of merged.sites) {
    const own = await runBuilderSpec(site.siteId, summarySpec, canFor(site.siteId))
    handSummed += own.totals['totalIncl_sum'] ?? 0
  }
  const mergedTotal = merged.totals['totalIncl_sum'] ?? 0
  ok('*** the merged total equals the sum of each store\'s own total ***',
    Math.abs(mergedTotal - handSummed) < 0.01,
    `merged ${mergedTotal.toFixed(2)} vs summed ${handSummed.toFixed(2)}`)

  /* A row present at two stores must appear ONCE, with both figures added —
     not twice, which is the obvious way a naive concat would go wrong. */
  const groupKeys = merged.rows.map((r) => String(r['userName'] ?? ''))
  ok('  each group key appears exactly once in the merged set',
    groupKeys.length === new Set(groupKeys).size,
    `${groupKeys.length} rows, ${new Set(groupKeys).size} distinct`)

  /* The row-count column lands under `rowCount`, not `__rows` — outputKey()
     renames the synthetic field. Asserting on the spec key would pass vacuously
     against undefined, which is how a broken count would go unnoticed. */
  let handCounted = 0
  for (const site of merged.sites) {
    const own = await runBuilderSpec(site.siteId, summarySpec, canFor(site.siteId))
    handCounted += own.totals['rowCount'] ?? 0
  }
  ok('  the row count is summed across stores, not overwritten',
    (merged.totals['rowCount'] ?? 0) > 0 &&
    Math.abs((merged.totals['rowCount'] ?? 0) - handCounted) < 0.01,
    `merged ${merged.totals['rowCount']} vs summed ${handCounted}`)

  console.log('\nDetail reports carry their store')

  const detailSpec = spec({
    source: 'sales',
    columns: [{ field: 'documentNumber' }, { field: 'totalIncl' }],
    filters: [{ field: 'status', op: 'eq', value: 'finalised' }],
    limit: 20,
  })
  const detail = await runAcrossSites(scope.sites, detailSpec, canFor)

  ok('*** a detail report gains a Store column ***',
    detail.columns[0]?.key === STORE_COLUMN_KEY && detail.columns[0]?.label === 'Store',
    detail.columns.slice(0, 3).map((c) => c.key).join(', '))

  ok('  and every row names the store it came from',
    detail.rows.length === 0 ||
    detail.rows.every((r) => typeof r[STORE_COLUMN_KEY] === 'string' && r[STORE_COLUMN_KEY] !== ''),
    detail.rows[0] ? String(detail.rows[0][STORE_COLUMN_KEY]) : '(no rows)')

  ok('  a summarised report does NOT gain one — the row is every store',
    merged.columns.every((c) => c.key !== STORE_COLUMN_KEY))

  console.log('\nFail-soft, per store')

  const withGhost = [
    ...scope.sites,
    { siteId: 999, name: 'Ghost', code: 'X', isPrimary: false },
  ]
  const ghosted = await runAcrossSites(withGhost, summarySpec, canFor)
  ok('*** an unreachable store is a failure, not a crash ***',
    ghosted.failures.some((f) => f.siteId === 999),
    ghosted.failures.map((f) => f.name).join(', '))
  ok('  and the readable stores still report',
    ghosted.sites.length === merged.sites.length &&
    Math.abs((ghosted.totals['totalIncl_sum'] ?? 0) - mergedTotal) < 0.01)

  /* A user with no rights at a store must not silently contribute an empty
     column — the store drops out with a reason, like an unreachable one. */
  const noRights = await runAcrossSites(
    scope.sites,
    summarySpec,
    () => () => false,
  )
  ok('*** a store the user cannot read drops out with a reason ***',
    noRights.sites.length === 0 && noRights.failures.length === scope.sites.length,
    noRights.failures[0]?.error ?? '(none)')

  console.log(fails === 0 ? '\nAll multi-site report checks passed.' : `\n${fails} FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
