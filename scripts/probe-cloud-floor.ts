import { siteQuery } from '../src/lib/siteDb'
const SITE = Number(process.env.PROBE_SITE ?? 1)
async function main() {
  const tables = await siteQuery<any>(SITE,
    `SELECT t.code, t.is_active, t.document_id, d.status, d.customer_name, d.total_incl
       FROM pos_tables t LEFT JOIN sales_documents d ON d.id = t.document_id
      WHERE t.is_active = 1 ORDER BY t.code`, [])
  console.log(`CLOUD active tables: ${tables.length}`)
  for (const t of tables) console.log(`   ${t.code}  doc=${t.document_id ?? '-'}  status=${t.status ?? '-'}  ${t.customer_name ?? ''}`)
  const saved = await siteQuery<any>(SITE, `SELECT COUNT(*) AS n FROM sales_documents WHERE status='saved'`, [])
  console.log(`CLOUD saved documents: ${saved[0].n}`)
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
