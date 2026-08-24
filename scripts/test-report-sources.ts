/**
 * test-report-sources.ts — every source runs as a real report.
 *
 * test-report-catalog-fields.ts checks each field's SQL in isolation. That is
 * not the same as proving a SOURCE works: validateSpec, the starter columns, the
 * default filters, the permission strip, the shared-file prefixing and the
 * GROUP BY builder all sit between a catalog entry and a report on a screen.
 *
 * So this runs EVERY source twice — once as a detail report on its starter
 * columns, once summarised by its first groupable field — and fails on any that
 * cannot produce a report at all.
 *
 * The shared-file sources are the reason this exists. A source marked
 * `ownedBy: 'giftcard'` takes a code path in run.ts that no other test reaches,
 * and getting it wrong does not error — it reads the WRONG SHOP'S DATA, which
 * looks exactly like a working report.
 */
import { runBuilderSpec } from '../src/lib/reportBuilder/run'
import { SOURCES } from '../src/lib/reportBuilder/catalog'
import { DEFAULT_ROWS, emptySpec } from '../src/lib/reportBuilder/spec'
import type { CustomReportSpec } from '../src/lib/reportBuilder/spec'

const SITE = Number(process.env.PROBE_SITE ?? 1)
const canAll = () => true

let failed = 0
let ran = 0

async function main() {
  for (const source of SOURCES) {
    const starters = source.fields.filter((f) => f.starter)
    /* Not every source declares starters; fall back to its first few fields so
       the source is still exercised rather than silently skipped. */
    const columns = (starters.length ? starters : source.fields.slice(0, 4)).map((f) => ({
      field: f.key,
    }))

    /* Built by the catalog's OWN constructor, so this test starts from exactly
       what the builder hands a user on picking the source — including its
       default filters, which are part of what is being checked. */
    const base: CustomReportSpec = {
      ...emptySpec(source.key),
      name: `probe:${source.key}`,
      period: { key: 'last5Years' },
      columns,
      limit: DEFAULT_ROWS,
    }

    /* 1. Detail. */
    try {
      const r = await runBuilderSpec(SITE, base, canAll, { limit: 3 })
      ran++
      console.log(
        `PASS  ${source.key.padEnd(22)} detail   ${String(r.rows.length).padStart(3)} row(s), ${r.columns.length} cols`,
      )
    } catch (e: any) {
      failed++
      console.log(`FAIL  ${source.key.padEnd(22)} detail   ${e.message}`)
      continue
    }

    /* 2. Summarised by the first text field that is not the one being counted.
          A source with nothing groupable is legitimate, so it is skipped rather
          than failed. */
    const groupable = (starters.length ? starters : source.fields).find(
      (f) => f.type === 'text' && !f.numeric,
    )
    const measure = source.fields.find((f) => f.numeric && !f.ratio)
    if (!groupable || !measure) continue

    try {
      const r = await runBuilderSpec(
        SITE,
        {
          ...base,
          columns: [{ field: groupable.key }, { field: measure.key, agg: 'sum' }],
          groupFields: [groupable.key],
        },
        canAll,
        { limit: 3 },
      )
      ran++
      console.log(
        `PASS  ${source.key.padEnd(22)} grouped  by ${groupable.key} → ${r.rows.length} row(s)`,
      )
    } catch (e: any) {
      failed++
      console.log(`FAIL  ${source.key.padEnd(22)} grouped  ${e.message}`)
    }
  }

  console.log(`\n${ran} report(s) ran across ${SOURCES.length} sources, ${failed} failure(s).`)
  if (failed) process.exit(1)
  console.log('PASS — every source produces a report.')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
