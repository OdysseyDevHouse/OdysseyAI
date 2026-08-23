import { listTables } from '../src/lib/site/posTables'
import { listOpenTabs } from '../src/lib/site/salesDocuments'
import { tabPurpose } from '../src/lib/site/tabRouting'
const SITE = Number(process.env.PROBE_SITE ?? 1)
async function main() {
  const purpose = await tabPurpose(SITE)
  const tables = await listTables(SITE)
  const tabs = await listOpenTabs(SITE, purpose)   // as the action now calls it
  const tableByDoc = new Map<number, string>()
  for (const t of tables) if (t.documentId !== null) tableByDoc.set(t.documentId, t.code)
  const armable = tabs.filter((t) => tableByDoc.has(t.id))
  console.log(`purpose=${purpose}  tables=${tables.length}  tabs=${tabs.length}  armable=${armable.length}`)
  for (const t of armable) console.log(`   doc=${t.id} -> ${tableByDoc.get(t.id)}`)
  const orphan = tabs.filter((t) => !tableByDoc.has(t.id))
  console.log(`orphan tabs (shown but not armable): ${orphan.length}`)
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
