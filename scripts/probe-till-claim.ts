/*
 * Why does "Open the till" say "Choose a till"?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-till-claim.ts
 *
 * Prints the three facts that decide it, because the screen shows none of them:
 * the site's cashup mode, the terminals on file, and which of those has claimed
 * a device. A till whose device_id matches nothing is "unclaimed", and in
 * terminal mode `openShift` refuses it — correctly, but with a message that
 * names no way to fix it.
 */
import { activeSiteIds } from '../src/lib/sites'
import { siteQuery } from '../src/lib/siteDb'
import { getSetting } from '../src/lib/site/settings'

type Row = {
  id: number
  code: string
  till_number: number | null
  device_id: string | null
  is_active: number
}

async function main() {
 for (const siteId of await activeSiteIds()) {
  const raw = await getSetting(siteId, 'cashup_mode')
  const mode = raw === 'user' ? 'user' : 'terminal'
  console.log(`\n── site ${siteId} ─────────────────────────────────────────`)
  console.log(`cashup_mode setting: ${raw === null || raw === undefined ? '(unset)' : `"${raw}"`} -> ${mode}`)

  const rows = await siteQuery<Row>(
    siteId,
    'SELECT id, code, till_number, device_id, is_active FROM terminals ORDER BY id',
  ).catch((e) => {
    console.log(`  could not read terminals: ${e.message}`)
    return [] as Row[]
  })

  if (!rows.length) {
    console.log('  NO TERMINALS AT ALL.')
    if (mode === 'terminal') {
      console.log('  -> In terminal mode nobody can ever open a till here.')
    }
    continue
  }

  for (const t of rows) {
    const claimed = t.device_id ? `claimed by ${t.device_id}` : 'UNCLAIMED (no device)'
    console.log(
      `  #${t.id} ${t.code}${t.till_number ? ` (till ${t.till_number})` : ''}` +
        `${t.is_active ? '' : ' [INACTIVE]'} — ${claimed}`,
    )
  }

  const claimedCount = rows.filter((t) => t.device_id && t.is_active).length
  if (mode === 'terminal' && claimedCount === 0) {
    console.log('\n  Every till is unclaimed, so any machine opening one is refused')
    console.log('  with "Choose a till." — which is the reported symptom.')
  }
  }
}

main().then(() => process.exit(0))
