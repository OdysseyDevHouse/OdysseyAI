import { tabsAreLocal, boxIsReachable, tabPurpose } from '../src/lib/site/tabRouting'
import { queryOne } from '../src/lib/db'
const SITE = Number(process.env.PROBE_SITE ?? 1)
async function main() {
  const row = await queryOne<any>('SELECT id, connection_type FROM cp2_sites WHERE id = ? LIMIT 1', [SITE])
  console.log(`cp2_sites: ${JSON.stringify(row)}`)
  console.log(`tabsAreLocal = ${await tabsAreLocal(SITE)}`)
  console.log(`boxIsReachable = ${await boxIsReachable(SITE)}`)
  console.log(`tabPurpose = ${await tabPurpose(SITE)}`)
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
