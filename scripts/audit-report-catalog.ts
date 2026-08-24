/**
 * audit-report-catalog.ts — what the database holds that the report builder
 * cannot reach.
 *
 * For each catalog source, reads the real column list of its primary table and
 * subtracts every column any field's `expr` mentions as `t.<col>`. What is left
 * is a column a user has no way to put in a report.
 *
 * Three kinds of leftover, reported separately because they mean different
 * things:
 *
 *   MISSING — a plain business column with no field and no excuse. The real gap.
 *   fk?     — a foreign key whose label no join resolves either, so the fact it
 *             points at is unreachable too.
 *   (silent) — a foreign key some join already answers by name, and routine
 *             surrogate/audit columns. Neither is a gap: the catalog's style is
 *             to offer the NAME a join resolves, never the integer id.
 */
import { siteQuery } from '../src/lib/siteDb'
import { SOURCES } from '../src/lib/reportBuilder/catalog'

const SITE = Number(process.env.PROBE_SITE ?? 1)

const BORING = /^(id|created_at|updated_at|created_by|updated_by|deleted_at|site_id|sync_.*|.*_uuid|version)$/
const FK = /_id$/

async function main() {
  const rows = await siteQuery<{ t: string; c: string; ty: string; nul: string }>(
    SITE,
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, IS_NULLABLE nul
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [],
  )
  const byTable = new Map<string, { c: string; ty: string; nul: string }[]>()
  for (const r of rows) {
    if (!byTable.has(r.t)) byTable.set(r.t, [])
    byTable.get(r.t)!.push({ c: r.c, ty: r.ty, nul: r.nul })
  }

  let totalMissing = 0
  let totalFk = 0
  const report: string[] = []

  for (const s of SOURCES) {
    const cols = byTable.get(s.table)
    if (!cols) {
      report.push(`\n### ${s.key}  (${s.label})\n  !! TABLE MISSING ON THIS SITE: ${s.table}`)
      continue
    }
    /* Every `t.<col>` any field expression mentions — one field may mention
       several (a CASE, a COALESCE), and all of them count as covered. */
    const covered = new Set<string>()
    for (const f of s.fields) {
      for (const m of f.expr.matchAll(/\bt\.([a-z_][a-z0-9_]*)/gi)) covered.add(m[1].toLowerCase())
      if (f.link) for (const m of f.link.idExpr.matchAll(/\bt\.([a-z_][a-z0-9_]*)/gi)) covered.add(m[1].toLowerCase())
    }
    if (s.dateColumn) covered.add(s.dateColumn.toLowerCase())
    /* A join's ON clause naming `t.department_id` means the label IS offered. */
    const joined = new Set<string>()
    for (const j of s.joins ?? []) {
      for (const m of j.sql.matchAll(/\bt\.([a-z_][a-z0-9_]*)/gi)) joined.add(m[1].toLowerCase())
    }

    const missing = cols.filter((c) => !covered.has(c.c.toLowerCase()))
    const rest = missing.filter((c) => !BORING.test(c.c))
    const boring = missing.length - rest.length
    const plain = rest.filter((c) => !FK.test(c.c))
    const rawFk = rest.filter((c) => FK.test(c.c) && !joined.has(c.c.toLowerCase()))
    const joinedFk = rest.length - plain.length - rawFk.length

    totalMissing += plain.length
    totalFk += rawFk.length
    report.push(
      `\n### ${s.key}  (${s.label})  [${s.table}]` +
        `\n  ${cols.length} cols | ${plain.length} MISSING | ${rawFk.length} unjoined FK` +
        ` | ${joinedFk} FK already joined | ${boring} routine`,
    )
    for (const c of plain) report.push(`    MISSING  ${c.c}  ${c.ty}${c.nul === 'YES' ? ' NULL' : ''}`)
    for (const c of rawFk) report.push(`    fk?      ${c.c}  ${c.ty}${c.nul === 'YES' ? ' NULL' : ''}`)
  }

  console.log(`REPORT BUILDER CATALOG AUDIT — site ${SITE}`)
  console.log(`${SOURCES.length} sources | ${totalMissing} business columns unreachable | ${totalFk} unjoined FKs`)
  console.log(report.join('\n'))
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
