/**
 * Every field a template names must exist on the source it names.
 *
 * WHAT THIS EXISTS TO CATCH is the silent one. A spec column whose field is not
 * on its source is not an error anywhere: specColumns() skips what it cannot
 * resolve, so the report runs, looks fine, and is simply missing a column
 * nobody notices until a shop asks where their cost price went.
 *
 * The same is true of group fields, filters and sorts. A filter on a field the
 * source does not have is dropped, which silently WIDENS the report — the
 * status filter that made a sales report mean "finalised only" quietly stops
 * applying and drafts appear in the totals.
 *
 * Fast, offline, no database. Worth running on every template change.
 *
 *   npm run test:template-fields
 */
import { TEMPLATES } from '../src/lib/reportBuilder/templates'
import { SOURCES, getField } from '../src/lib/reportBuilder/catalog'
import { ROW_COUNT_FIELD, specColumns } from '../src/lib/reportBuilder/spec'

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

function main() {
  console.log(`\n── ${TEMPLATES.length} templates ──\n`)

  for (const t of TEMPLATES) {
    const source = SOURCES.find((s) => s.key === t.spec.source)
    if (!source) {
      ok(`${t.id}: source '${t.spec.source}' exists`, false)
      continue
    }

    const problems: string[] = []

    for (const col of t.spec.columns) {
      // A calculated column carries a synthetic key; its operands are what must
      // resolve.
      if (col.calc) {
        if (!getField(source, col.calc.left)) problems.push(`calc left '${col.calc.left}'`)
        if (typeof col.calc.right === 'string' && !getField(source, col.calc.right)) {
          problems.push(`calc right '${col.calc.right}'`)
        }
        continue
      }
      if (col.field === ROW_COUNT_FIELD) continue
      if (!getField(source, col.field)) problems.push(`column '${col.field}'`)
    }

    for (const key of t.spec.groupFields) {
      if (!getField(source, key)) problems.push(`groupField '${key}'`)
    }

    for (const f of t.spec.filters) {
      if (!getField(source, f.field)) problems.push(`filter '${f.field}'`)
    }

    // The sort names an OUTPUT key, not a catalog key — 'totalIncl_sum' is a
    // legitimate sort on a summarised report.
    if (t.spec.sort) {
      const keys = new Set(specColumns({ ...t.spec, name: t.name }, source).map((c) => c.key))
      if (!keys.has(t.spec.sort.key)) problems.push(`sort '${t.spec.sort.key}'`)
    }

    for (const f of t.spec.totalFilters) {
      const keys = new Set(specColumns({ ...t.spec, name: t.name }, source).map((c) => c.key))
      if (!keys.has(f.key)) problems.push(`totalFilter '${f.key}'`)
    }

    ok(
      `${t.id} (${t.spec.source})`,
      problems.length === 0,
      problems.length ? problems.join(', ') : '',
    )
  }

  /*
   * ── A text column on a summarised report ─────────────────────────────
   *
   * On a grouped report every column is aggregated, and defaultAgg() for a
   * non-numeric field is `count`. So a text column left unaggregated does not
   * fail — it renders as "Count department" showing a row count, which reads
   * like a real figure and is not one.
   *
   * The fix is always the same: group by it instead. Caught here because the
   * output is plausible, which is exactly the kind of wrong nobody reports.
   */
  console.log('\n── Text columns on summarised reports ──\n')
  for (const t of TEMPLATES) {
    const source = SOURCES.find((s) => s.key === t.spec.source)
    if (!source || t.spec.groupFields.length === 0) continue

    const accidental = t.spec.columns
      .filter((c) => !c.calc && c.field !== ROW_COUNT_FIELD && !c.agg)
      .map((c) => getField(source, c.field))
      .filter((f) => f && !f.numeric)
      .map((f) => f!.key)

    ok(
      `${t.id}: no unaggregated text columns`,
      accidental.length === 0,
      accidental.length ? `${accidental.join(', ')} — group by these instead` : '',
    )
  }

  /* A template that resolves to no columns at all runs and renders an empty
     table — the most confusing possible outcome, because the report "works". */
  console.log('\n── Every template produces columns ──\n')
  for (const t of TEMPLATES) {
    const source = SOURCES.find((s) => s.key === t.spec.source)
    if (!source) continue
    const cols = specColumns({ ...t.spec, name: t.name }, source)
    ok(`${t.id} renders ${cols.length} column${cols.length === 1 ? '' : 's'}`, cols.length > 0)
  }

  console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main()
