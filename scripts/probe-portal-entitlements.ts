/**
 * Does the portal actually serve GET /entitlements?
 *
 * ── WHY ASK ─────────────────────────────────────────────────────────────────
 *
 * src/lib/control/entitlementsPortal.ts calls an endpoint that is not among the
 * six /licence/* paths the rest of the portal client uses, and the portal is a
 * separate repository — so nothing in this tree proves the other end exists.
 *
 * The failure if it does not is SILENT and slow-acting: send() returns
 * `refused`, the client logs one line and returns null, every read falls back to
 * port 3306, and on a shop whose firewall blocks 3306 the lease is never renewed.
 * The machine then locks on the seventh day with a working internet connection.
 * That is precisely the failure entitlementsPortal.ts was written to prevent, so
 * it is worth one live call to know.
 *
 * Signs with THIS machine's own site key, through the same send() the app uses,
 * so a pass here is evidence about the real path rather than about a
 * reimplementation of it.
 *
 * Run with the machine's portal environment (see electron/machineConfig.js):
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-portal-entitlements.ts
 */
import { portalConfig, send } from '../src/lib/control/portalApi'
import { entitlementsForSite, portalAvailable } from '../src/lib/control/entitlementsPortal'

async function main() {
  const cfg = portalConfig()

  console.log('\nPortal /entitlements\n')

  if (!cfg) {
    console.error('  No portal config. Set POS_API_URL, POS_API_CLIENT_ID,')
    console.error('  POS_API_CLIENT_SECRET, ODYSSEY_SITE_ID, ODYSSEY_SITE_API_KEY,')
    console.error('  ODYSSEY_SITE_API_KEY_ID — see electron/machineConfig.js.')
    process.exit(1)
  }

  console.log(`  base    ${cfg.baseUrl}`)
  console.log(`  site    ${cfg.siteId}`)
  console.log(`  keyId   ${cfg.keyId}`)
  console.log(`  available: ${portalAvailable()}`)

  /* The raw call first, so the DISTINCTION survives: the typed client collapses
     a refusal and an outage into null, and here those mean very different
     things — "the endpoint is not deployed" versus "it is, and said no". */
  console.log('\n  raw GET /entitlements:')
  const raw = await send<unknown>('GET', '/entitlements')
  if (raw.ok) {
    console.log('    ok — the endpoint exists and answered')
    console.log(`    ${JSON.stringify(raw.data).slice(0, 400)}`)
  } else if (raw.reason === 'refused') {
    console.log(`    refused: HTTP ${raw.status} ${raw.code} — ${raw.error}`)
    console.log(
      raw.status === 404
        ? '    → 404 means the endpoint is NOT deployed. entitlementsPortal is dead code.'
        : '    → not a 404, so the route exists; this is an auth or validation answer.',
    )
  } else {
    console.log(`    unreachable: ${raw.error}`)
  }

  /* Then the real client, which is what the app actually runs. */
  console.log('\n  via entitlementsPortal.entitlementsForSite():')
  const typed = await entitlementsForSite(cfg.siteId)
  if (!typed) {
    console.log('    null — the app would fall back to a direct MySQL query')
  } else {
    console.log(`    held        ${[...typed.held].join(', ') || '(none)'}`)
    console.log(`    endingOn    ${JSON.stringify(Object.fromEntries(typed.endingOn))}`)
    console.log(`    deviceCount ${typed.deviceCount}`)
    console.log(`    account     ${typed.accountId} / ${typed.accountStatus}`)
  }

  process.exit(0)
}

void main()
