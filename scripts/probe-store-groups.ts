/*
 * Are these two shops one business or two?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-store-groups.ts
 *
 * Matters for the cross-site till claim: refusing one machine two tills in two
 * UNRELATED companies is a safety rule. Refusing it across two branches of one
 * group is the same rule, but the reasoning has to be checked rather than
 * assumed — so this prints what the grouping actually says.
 */
import { query } from '../src/lib/db'
import type { RowDataPacket } from 'mysql2'

async function main() {
  const groups = await query<RowDataPacket & { id: number; name: string; primary_site_id: number }>(
    'SELECT id, name, primary_site_id FROM cp2_store_groups ORDER BY id',
  ).catch((e) => {
    console.log('no store groups table:', e.message)
    return []
  })

  if (!groups.length) {
    console.log('No store groups at all — every site stands alone.')
  }
  for (const g of groups) {
    console.log(`\ngroup ${g.id} "${g.name}" (primary site ${g.primary_site_id})`)
    const members = await query<RowDataPacket & { site_id: number }>(
      'SELECT site_id FROM cp2_store_group_members WHERE group_id = ? ORDER BY site_id',
      [g.id],
    ).catch(() => [])
    for (const m of members) console.log(`  member site ${m.site_id}`)
  }

  console.log('\n── Every site, and the tills each machine holds ──────────────')
  const sites = await query<RowDataPacket & { id: number; name: string }>(
    'SELECT id, name FROM cp2_sites WHERE status = "active" ORDER BY id',
  ).catch(() => [])
  for (const s of sites) console.log(`  site ${s.id}: ${s.name}`)
}

main().then(() => process.exit(0))
