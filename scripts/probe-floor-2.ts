import { siteQuery } from '../src/lib/siteDb'
const SITE = Number(process.env.PROBE_SITE ?? 1)
async function main() {
  const all = await siteQuery<any>(
    SITE,
    `SELECT id, code, name, section, is_active, document_id, room_id FROM pos_tables ORDER BY code`,
    [],
  )
  console.log(`pos_tables rows TOTAL (any is_active): ${all.length}`)
  for (const r of all) {
    console.log(`   id=${r.id} code=${r.code} name=${r.name ?? ''} section=${r.section ?? ''} is_active=${r.is_active} document_id=${r.document_id} room=${r.room_id}`)
  }
  const rooms = await siteQuery<any>(SITE, `SELECT id, name FROM pos_rooms`, []).catch(() => [])
  console.log(`\npos_rooms: ${rooms.length}`)
  for (const r of rooms) console.log(`   id=${r.id} ${r.name}`)
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
