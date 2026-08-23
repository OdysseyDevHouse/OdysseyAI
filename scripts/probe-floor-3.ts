import { siteQuery } from '../src/lib/siteDb'
import { tabPurpose } from '../src/lib/site/tabRouting'
const SITE = Number(process.env.PROBE_SITE ?? 1)
async function main() {
  const purpose = await tabPurpose(SITE)
  console.log(`tabPurpose(site ${SITE}) = ${JSON.stringify(purpose)}`)

  for (const [label, p] of [['MASTER (default)', undefined], ['tab purpose', purpose]] as const) {
    console.log(`\n--- ${label} ---`)
    try {
      const tables = await siteQuery<any>(
        SITE,
        `SELECT id, code, is_active, document_id FROM pos_tables ORDER BY code`,
        [],
        p as any,
      )
      const active = tables.filter((t: any) => Number(t.is_active) === 1)
      const held = tables.filter((t: any) => t.document_id !== null)
      console.log(`  pos_tables: ${tables.length} rows, ${active.length} active, ${held.length} holding a doc`)
      for (const t of held) console.log(`     ${t.code} doc=${t.document_id} active=${t.is_active}`)

      const docs = await siteQuery<any>(
        SITE,
        `SELECT id, customer_name, status FROM sales_documents WHERE status='saved' ORDER BY id DESC LIMIT 12`,
        [],
        p as any,
      )
      console.log(`  saved documents: ${docs.length}`)
      for (const d of docs) console.log(`     doc=${d.id} ${d.customer_name ?? ''}`)
    } catch (e: any) {
      console.log(`  ERROR: ${e.message}`)
    }
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
