/** Terminals and device claims on the tablet's site, so the tablet can be claimed. */
import { siteQuery } from '../src/lib/siteDb'
async function main() {
  const SITE = Number(process.env.SITE || 53)
  const t = await siteQuery<any>(SITE, `SELECT id, code, name, till_number, device_id, device_label FROM terminals ORDER BY id`)
  console.log(`site ${SITE} terminals:`)
  for (const r of t) console.log(`  #${r.id} ${String(r.code).padEnd(10)} ${String(r.name ?? '').padEnd(18)} till:${String(r.till_number ?? '-').padEnd(4)} device:${r.device_id ? String(r.device_id).slice(0,12)+'…' : 'UNCLAIMED'} ${r.device_label ?? ''}`)
  if (t.length === 0) console.log('  (none)')
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1) })
