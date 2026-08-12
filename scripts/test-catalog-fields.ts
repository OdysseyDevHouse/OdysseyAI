/**
 * Every field in the catalog must produce SQL the database accepts.
 *
 * WHAT THIS EXISTS TO CATCH is a field nobody has picked yet. A CatalogField's
 * `expr` is hand-authored SQL against aliases the source declares, and nothing
 * checks it until somebody adds that column to a report — at which point the
 * report does not run at all. With ~340 fields across 14 sources, most are
 * exercised by no template, so "the templates pass" says very little.
 *
 * It also catches the subtler one: a field whose `expr` references an alias its
 * `needs` does not pull in. That fails only when the field is used WITHOUT
 * another field that happens to bring the same join, which is a bug that hides
 * behind whatever else is on the report.
 *
 * Each field is run alone, on its own source, over a tiny window, so a failure
 * names exactly one field.
 *
 *   npm run test:catalog-fields
 */
import { SOURCES } from '../src/lib/reportBuilder/catalog'
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import type { CustomReportSpec } from '../src/lib/reportBuilder/spec'

const SITE = 1
const allow = () => true

let fails = 0
const ok = (label: string, cond: boolean, extra = '') => {
  if (!cond) fails++
  console.log(`${cond ? 'PASS' : '**FAIL**'}  ${label}${extra ? '  -- ' + extra : ''}`)
}

async function main() {
  let checked = 0

  for (const source of SOURCES) {
    const problems: string[] = []

    for (const field of source.fields) {
      const spec: CustomReportSpec = {
        version: 1,
        name: `probe ${field.key}`,
        source: source.key,
        // A snapshot source ignores the period; a timeline one is narrowed hard
        // so this stays fast over a hundred thousand sales.
        period: { key: 'today' },
        columns: [{ field: field.key }],
        filters: [],
        groupFields: [],
        totalFilters: [],
        limit: 1,
      }

      try {
        const result = await runBuilderSpec(SITE, spec, allow)
        // A field that resolves to no column at all is as broken as one that
        // throws — the report would run and silently show nothing.
        if (result.columns.length === 0) problems.push(`${field.key} (produced no column)`)
      } catch (e) {
        problems.push(`${field.key}: ${e instanceof Error ? e.message.slice(0, 120) : 'failed'}`)
      }
      checked++
    }

    ok(
      `${source.key} — ${source.fields.length} fields`,
      problems.length === 0,
      problems.length ? problems.join(' | ') : '',
    )
  }

  console.log(`\n${checked} fields exercised.`)
  console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILURE(S)`)
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
