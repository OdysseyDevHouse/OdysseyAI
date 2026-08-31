/** Who can unlock the tablet: till users on site 53 with a PIN and sales.till. */
import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const cols = await siteQuery<any>(53, `SHOW COLUMNS FROM users`)
  const names = cols.map((c: any) => c.Field)
  const pinCol = names.find((n: string) => /pin/i.test(n))
  const roleCol = names.find((n: string) => /role/i.test(n))
  const rows = await siteQuery<any>(
    53,
    `SELECT id, name, ${roleCol ?? "'-'"} AS role, ${pinCol ? `${pinCol} IS NOT NULL AND ${pinCol} <> ''` : '0'} AS has_pin FROM users ORDER BY id LIMIT 15`,
  )
  console.log(`site 53 users (pin column: ${pinCol ?? 'none'}, role column: ${roleCol ?? 'none'}):`)
  for (const r of rows) console.log(`  #${String(r.id).padStart(3)} ${String(r.name).padEnd(24)} ${String(r.role).padEnd(16)} pin:${Number(r.has_pin) ? 'YES' : 'no'}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
