/**
 * Registers the Android test tablet against TILL05 on site 53.
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/one-off/claim-tablet-site53.ts
 *
 * The same call the back office makes (claimTerminalAction → claimTerminal), so
 * the row this leaves is indistinguishable from one a manager created — the
 * unique device_id, the released prior holder and the claimed_at stamp all come
 * from the real function rather than from an INSERT written here.
 */
import { claimTerminal, getTerminal } from '../../src/lib/site/terminals'
import { siteQuery } from '../../src/lib/siteDb'

const SITE = 53
const DEVICE = process.env.TABLET_DEVICE_ID || 'c4b66d1f-ab3e-4e88-bae4-b95e1a1731fe'
const LABEL = 'Android Tablet'

async function main() {
  const [till] = await siteQuery<any>(SITE, `SELECT id, code, name, device_id FROM terminals WHERE code = 'TILL05'`)
  if (!till) {
    console.error('TILL05 does not exist on site 53 — run add-till05-site53.ts first.')
    process.exit(1)
  }
  if (till.device_id && till.device_id !== DEVICE) {
    console.error(`TILL05 is already claimed by ${till.device_id}. Release it in the back office first.`)
    process.exit(1)
  }

  const result = await claimTerminal(SITE, till.id, DEVICE, LABEL)
  if (!result.ok) {
    console.error('claim refused: ' + result.error)
    process.exit(1)
  }

  const after = await getTerminal(SITE, till.id)
  console.log(`claimed #${after?.id} ${after?.code} "${after?.name}"`)
  console.log(`   device: ${after?.deviceId}`)
  console.log(`   label:  ${after?.deviceLabel}`)

  /* The claim is only half of it — the unlock screen resolves the site from the
     DEVICE, so the thing worth printing is what that lookup now returns. */
  const { sitesForDevice } = await import('../../src/lib/site/terminals')
  const sites = await sitesForDevice(DEVICE)
  console.log(`\nsitesForDevice → ${sites.length} shop(s):`)
  for (const s of sites) console.log(`   site ${s.siteId} ${s.siteName} — ${s.terminalCode}`)
  if (sites.length === 0) console.log('   NONE — the tablet would still be refused.')
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
