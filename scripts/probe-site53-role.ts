/** Can site 53's user #1 actually unlock a till? unlockAction demands sales.till. */
import { siteQuery } from '../src/lib/siteDb'
import { capabilitiesForRole, can } from '../src/lib/site/permissions'
async function main() {
  const [u] = await siteQuery<any>(53, `SELECT id, name, role_id FROM users WHERE id = 1`)
  const roles = await siteQuery<any>(53, `SELECT id, name FROM roles WHERE id = ?`, [u.role_id])
  const caps = await capabilitiesForRole(53, u.role_id)
  console.log(`user #${u.id} ${u.name}  role ${u.role_id} (${roles[0]?.name ?? '?'})`)
  console.log(`sales.till: ${can(caps, 'sales.till') ? 'YES — can unlock' : 'NO — would be refused'}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
