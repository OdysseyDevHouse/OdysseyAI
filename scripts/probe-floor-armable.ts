/**
 * Read-only: why does "Move table" report nothing to move?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-floor-armable.ts
 *
 * Calls the REAL listTables / listOpenTabs and reproduces the gate's own join
 * rather than re-implementing either query.
 */
import { listTables } from '../src/lib/site/posTables'
import { listOpenTabs } from '../src/lib/site/salesDocuments'
import { siteQuery } from '../src/lib/siteDb'

const SITE = Number(process.env.PROBE_SITE ?? 1)

async function main() {
  const tables = await listTables(SITE)
  const tabs = await listOpenTabs(SITE)

  console.log(`site ${SITE}`)
  console.log(`pos_tables active rows: ${tables.length}`)
  console.log(`open tabs (status='saved'): ${tabs.length}`)

  const occupied = tables.filter((t) => t.documentId !== null)
  console.log(`tables reporting an OPEN bill: ${occupied.length}`)
  for (const t of occupied) {
    console.log(`   ${t.code}  doc=${t.documentId}  state=${t.state}  lines=${t.lineCount}`)
  }

  const tableByDoc = new Map<number, string>()
  for (const t of tables) if (t.documentId !== null) tableByDoc.set(t.documentId, t.code)

  const armable = tabs.filter((t) => tableByDoc.has(t.id))
  console.log(`\narmableCount (tabs whose doc a table carries): ${armable.length}`)
  for (const t of armable) console.log(`   doc=${t.id} -> ${tableByDoc.get(t.id)}`)

  const orphan = tabs.filter((t) => !tableByDoc.has(t.id))
  console.log(`\ntabs with NO table pointing at them: ${orphan.length}`)
  for (const t of orphan.slice(0, 15)) {
    console.log(`   doc=${t.id} ref=${t.reference ?? ''} cust=${t.customerName ?? ''} lines=${t.lineCount}`)
  }

  const raw = await siteQuery<{ code: string; document_id: number | null; status: string | null }>(
    SITE,
    `SELECT t.code, t.document_id, d.status
       FROM pos_tables t
       LEFT JOIN sales_documents d ON d.id = t.document_id
      WHERE t.is_active = 1 AND t.document_id IS NOT NULL
      ORDER BY t.code`,
    [],
  )
  console.log(`\nraw pointers on active tables: ${raw.length}`)
  for (const r of raw) {
    console.log(`   ${r.code}  document_id=${r.document_id}  doc.status=${r.status ?? 'MISSING ROW'}`)
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
