/**
 * audit-report-sources.ts — which TABLES the report builder cannot see at all.
 *
 * The column audit answers "can I report on this fact of a sale". This answers
 * the prior question: is there any source over this table at all? A table with
 * rows and no source is a dataset the builder cannot reach however the report
 * is composed.
 *
 * Row counts come from a real COUNT(*), not TABLE_ROWS: InnoDB's estimate is
 * routinely 0 for a small table, which would hide exactly the tables worth
 * asking about on a young site.
 */
import { siteQuery } from '../src/lib/siteDb'
import { SOURCES } from '../src/lib/reportBuilder/catalog'

const SITE = Number(process.env.PROBE_SITE ?? 1)

/* Tables no report would ever be built over: plumbing, config the screens own,
   and the lookup tables the catalog already surfaces BY NAME through a join. */
const PLUMBING =
  /^(_|schema_migrations|migrations|sessions?|.*_sync$|sync_.*|.*_queue$|.*_outbox$|.*_cache$|.*_locks?$|.*_tokens?$|.*_settings$|.*_config$|.*_prefs$)/

async function main() {
  const tables = await siteQuery<{ n: string }>(
    SITE,
    `SELECT TABLE_NAME n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [],
  )
  /* A table is "reached" when a source reads it as its primary table OR when
     any join unit names it — a joined lookup is reportable, just not as its
     own dataset. */
  const primary = new Set(SOURCES.map((s) => s.table.toLowerCase()))
  const joined = new Set<string>()
  for (const s of SOURCES) {
    for (const j of s.joins ?? []) {
      for (const m of j.sql.matchAll(/\bJOIN\s+(?:\{[CB]\})?`?([a-z_][a-z0-9_]*)`?/gi)) {
        joined.add(m[1].toLowerCase())
      }
    }
  }

  const orphans: { n: string; rows: number }[] = []
  for (const t of tables) {
    const n = t.n.toLowerCase()
    if (primary.has(n) || joined.has(n) || PLUMBING.test(n)) continue
    const [{ c }] = await siteQuery<{ c: number }>(SITE, `SELECT COUNT(*) c FROM \`${t.n}\``, [])
    orphans.push({ n: t.n, rows: Number(c) })
  }
  orphans.sort((a, b) => b.rows - a.rows)

  console.log(`SOURCE COVERAGE — site ${SITE}`)
  console.log(`${tables.length} tables | ${primary.size} are a source | ${joined.size} reachable via a join`)
  console.log(`\n${orphans.length} tables with NO source and NO join:\n`)
  const withRows = orphans.filter((o) => o.rows > 0)
  console.log(`-- carrying data (${withRows.length}) --`)
  for (const o of withRows) console.log(`  ${String(o.rows).padStart(7)}  ${o.n}`)
  console.log(`\n-- empty on this site (${orphans.length - withRows.length}) --`)
  console.log(orphans.filter((o) => !o.rows).map((o) => o.n).join(', '))
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
