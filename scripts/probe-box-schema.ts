import { siteQuery } from '../src/lib/siteDb'
import { HYBRID } from '../src/lib/site/tabRouting'
const SITE = Number(process.env.PROBE_SITE ?? 1)
async function main() {
  const t = await siteQuery<any>(SITE, `SELECT TABLE_NAME AS n, TABLE_ROWS AS r FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME`, [], HYBRID)
  console.log(`BOX tables: ${t.length}`)
  for (const x of t) console.log(`   ${x.n}  (~${x.r} rows)`)
  const id = await siteQuery<any>(SITE, `SELECT * FROM box_identity`, [], HYBRID).catch((e: any) => [{ err: e.message }])
  console.log(`\nbox_identity: ${JSON.stringify(id)}`)
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
