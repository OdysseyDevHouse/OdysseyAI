/**
 * test-report-catalog-fields.ts — every catalog field must actually run.
 *
 * A field in the catalog is a promise that a column exists, spelled that way,
 * on the table the source names, reachable through the joins the field declares.
 * A typo in an `expr` or a missing `needs` is invisible to tsc and to every
 * existing suite: it surfaces as "Unknown column" the first time a person ticks
 * that box in the builder, which is the worst place to find it.
 *
 * So this asks the database. For each source, each field is SELECTed on its own
 * with its declared joins and LIMIT 0 — the server plans and validates the query
 * without reading a row, so the whole catalog checks in seconds and a failure
 * names the exact field.
 *
 * Fields are checked ONE AT A TIME rather than all together on purpose: a single
 * combined SELECT would fail on the first bad column and say nothing about the
 * rest, and the point of this test is the complete list.
 */
import { siteQuery } from '../src/lib/siteDb'
import { SOURCES, type CatalogSource, type CatalogField } from '../src/lib/reportBuilder/catalog'

const SITE = Number(process.env.PROBE_SITE ?? 1)

/** Resolve a field's `needs` transitively — a join may need another join. */
function joinSqlFor(source: CatalogSource, field: CatalogField): string {
  const units = new Map((source.joins ?? []).map((j) => [j.name, j]))
  const chosen: string[] = []
  const seen = new Set<string>()
  const want = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    const u = units.get(name)
    if (!u) throw new Error(`declares needs:['${name}'] but the source has no such join`)
    for (const dep of u.needs ?? []) want(dep)
    chosen.push(u.sql)
  }
  /* `always`, plus the two names run.ts still hardcodes beside it. That
     hardcoding predates the `always` flag and is mirrored rather than assumed
     away: this test has to check the SQL the engine really builds, not the one
     it ought to. */
  for (const j of source.joins ?? []) {
    if (j.always || j.name === 'doc' || j.name === 'exp') want(j.name)
  }
  /* A line-level source dates from its parent, and the time-bucket fields are
     written against that parent's alias without declaring `needs` — the engine
     pulls the join in from `dateJoin` instead. Without this the buckets on
     every such source fail here while working perfectly in the builder. */
  if (source.dateJoin) want(source.dateJoin)
  for (const n of field.needs ?? []) want(n)
  /* Emit in catalog order, so a join reading another's alias lands after it. */
  const order = (source.joins ?? []).map((j) => j.sql)
  return chosen.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(' ')
}

/* The shared-file tokens are replaced at runtime by run.ts with a database
   prefix. A site that owns its own files gets the empty string, which is what
   this checks against — the same SQL the majority of sites run. */
const detokenise = (sql: string) => sql.replace(/\{[CBSLG]\}/g, '')

async function main() {
  let checked = 0
  const failures: string[] = []

  for (const source of SOURCES) {
    for (const field of source.fields) {
      checked++
      let sql = ''
      try {
        const joins = joinSqlFor(source, field)
        const idExpr = field.link ? `, ${field.link.idExpr} AS _lnk` : ''
        sql = detokenise(
          `SELECT ${field.expr} AS v${idExpr} FROM \`${source.table}\` t ${joins} LIMIT 0`,
        )
        await siteQuery(SITE, sql, [])
      } catch (e: any) {
        failures.push(`  ${source.key}.${field.key}  — ${e.message}\n      ${sql}`)
      }
    }
  }

  console.log(`Checked ${checked} fields across ${SOURCES.length} sources.`)
  if (failures.length) {
    console.log(`\nFAIL — ${failures.length} field(s) do not run:\n`)
    console.log(failures.join('\n'))
    process.exit(1)
  }
  console.log('PASS — every catalog field resolves against the live schema.')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
