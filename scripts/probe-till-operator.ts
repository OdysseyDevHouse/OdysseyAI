/** A till operator on the café site, so a browser probe can get past the PIN gate. */
import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const SITE = Number(process.env.SITE || 33)
  const rows = await siteQuery<any>(SITE, `SELECT id, name, role, pos_pin IS NOT NULL AS has_pin FROM users LIMIT 10`)
  for (const r of rows) console.log(`#${r.id} ${String(r.name).padEnd(22)} ${String(r.role).padEnd(14)} pin:${r.has_pin ? 'yes' : 'no'}`)
  const t = await siteQuery<any>(SITE, `SELECT id, code, till_number FROM terminals LIMIT 5`)
  console.log('\nterminals:')
  for (const r of t) console.log(`  #${r.id} ${r.code} till ${r.till_number}`)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
