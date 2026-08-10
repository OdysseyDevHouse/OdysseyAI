/**
 * Every built-in report, run against a live site database.
 *
 * A report template is data, not code, so the compiler cannot tell you that a
 * field key was renamed or that a filter names a column the source does not
 * have. validateSpec DROPS anything it does not recognise — which is right for
 * a saved report surviving a rename, but means a typo in a template degrades
 * silently into a report missing a column nobody notices is gone.
 *
 * So this checks two different things:
 *
 *   NOTHING WAS DROPPED. Every column, grouping, filter and sort a template
 *   asks for still resolves against the catalog. This is the check that catches
 *   a typo the day it is written rather than the day someone runs the report.
 *
 *   THE SQL EXECUTES. Each template is actually run. A spec can be perfectly
 *   valid and still produce SQL the database rejects — a grouping on a field
 *   whose expression is not groupable, a join that was never declared.
 *
 * Row counts are NOT asserted: a site with no purchases legitimately returns
 * nothing, and a test that demands data would fail on a clean install.
 *
 *   npm run test:report-templates
 */
import { TEMPLATES, templateSpec } from '../src/lib/reportBuilder/templates'
import { getSource } from '../src/lib/reportBuilder/catalog'
import { validateSpec, ROW_COUNT_FIELD } from '../src/lib/reportBuilder/spec'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'

const SITE = 1
let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

/** The templates assume a full-access reader; per-capability hiding is run.ts's own test. */
const canAll = () => true

async function main() {
  console.log(`\n${TEMPLATES.length} built-in reports\n`)

  const ids = TEMPLATES.map((t) => t.id)
  ok('every template id is unique', new Set(ids).size === ids.length)

  for (const t of TEMPLATES) {
    const source = getSource(t.spec.source)
    if (!source) {
      ok(`${t.id}: source exists`, false, `no such source: ${t.spec.source}`)
      continue
    }

    // ── nothing silently dropped ────────────────────────────────────────────
    const checked = validateSpec(templateSpec(t))
    if (!checked.ok) {
      ok(`${t.id}: spec is valid`, false, checked.error)
      continue
    }
    const got = checked.spec

    const wantCols = t.spec.columns.map((c) => c.field).filter((f) => f !== ROW_COUNT_FIELD)
    const gotCols = new Set(got.columns.map((c) => c.field))
    const lostCols = wantCols.filter((f) => !gotCols.has(f))

    const lostGroups = (t.spec.groupFields ?? []).filter((f) => !got.groupFields.includes(f))
    const lostFilters = (t.spec.filters ?? [])
      .filter((f) => !got.filters.some((x) => x.field === f.field && x.op === f.op))
      .map((f) => `${f.field} ${f.op}`)
    // Total filters only survive on a summarised spec — that is validateSpec's
    // rule, not a fault, so only check them where they can apply.
    const lostTotals =
      got.groupFields.length > 0
        ? (t.spec.totalFilters ?? [])
            .filter((f) => !got.totalFilters.some((x) => x.key === f.key))
            .map((f) => f.key)
        : []
    const lostSort = t.spec.sort && !got.sort ? t.spec.sort.key : null

    const dropped = [
      ...lostCols.map((f) => `column ${f}`),
      ...lostGroups.map((f) => `group ${f}`),
      ...lostFilters.map((f) => `filter ${f}`),
      ...lostTotals.map((f) => `total filter ${f}`),
      ...(lostSort ? [`sort ${lostSort}`] : []),
    ]
    ok(`${t.id}: nothing dropped by the catalog`, dropped.length === 0, dropped.join(', '))

    // ── the SQL actually runs ───────────────────────────────────────────────
    try {
      const result = await runBuilderSpec(SITE, templateSpec(t), canAll, { limit: 5 })
      ok(
        `${t.id}: runs (${result.rows.length} row${result.rows.length === 1 ? '' : 's'}, ${result.columns.length} cols)`,
        result.columns.length > 0,
        result.columns.length === 0 ? 'report produced no columns' : '',
      )
    } catch (err) {
      ok(`${t.id}: runs`, false, err instanceof Error ? err.message : String(err))
    }
  }

  console.log(fails ? `\n${fails} FAILED\n` : '\nAll report templates run.\n')
  process.exit(fails ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
