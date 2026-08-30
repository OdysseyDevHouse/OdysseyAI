/**
 * Did the setup wizard's steps actually reach the database?
 *
 *   npx tsx --conditions=react-server --env-file=.env scripts/probe-onboarding-writes.ts [siteId]
 *
 * A toast saying "Saved." is the screen's claim, not the database's. This reads
 * back what the wizard writes — the VAT rate it edited, the settings keys, and
 * its own progress row — so a step that silently wrote nothing is visible.
 */
import { siteQuery } from '../src/lib/siteDb'
import { getSettings } from '../src/lib/site/settings'
import { onboardingProgress } from '../src/lib/site/onboarding'
import { listVatRatesForSetup, listPriceStructuresForSetup } from '../src/lib/site/pricingSetup'

const SITE = Number(process.argv[2] ?? 33)

async function main() {
  const rates = await listVatRatesForSetup(SITE)
  console.log('--- sales VAT rates ---')
  for (const r of rates.filter((x) => x.vatType === 'sales')) {
    console.log(
      `  ${r.code.padEnd(8)} ${r.name.padEnd(16)} ${String(r.rate).padStart(7)}%  ` +
        `${r.isDefault ? 'DEFAULT' : '       '}  ${r.productCount} products`,
    )
  }

  const structures = await listPriceStructuresForSetup(SITE)
  console.log('--- price types ---')
  for (const s of structures) {
    console.log(
      `  #${s.position} ${s.name.padEnd(16)} ${s.isDefault ? 'DEFAULT' : '       '}  ${s.priceCount} priced`,
    )
  }

  const settings = await getSettings(SITE, [
    'cost_basis',
    'tax_label',
    'currency_code',
    'currency_symbol',
    'qty_decimals',
    'cost_decimals',
    'onboarding_state',
    'onboarding_done_steps',
  ])
  console.log('--- settings ---')
  for (const [k, v] of Object.entries(settings)) console.log(`  ${k.padEnd(24)} ${JSON.stringify(v)}`)

  /* Read the raw row too. getSettings falls back to SETTING_DEFAULTS when no
     row exists, so a key that was never written looks identical to one written
     with its default value — and "did the wizard write this" is exactly the
     difference this script exists to show. */
  const rows = await siteQuery<{ setting_key: string; setting_value: string | null }>(
    SITE,
    "SELECT setting_key, setting_value FROM settings WHERE setting_key LIKE 'onboarding%'",
  )
  console.log('--- onboarding rows actually present ---')
  console.log(rows.length ? rows : '  (none — nothing has been saved yet)')

  const progress = await onboardingProgress(SITE)
  console.log('--- progress ---')
  console.log(
    `  pending=${progress.pending} done=${progress.doneCount}/${progress.totalCount} ` +
      `next=${progress.next ?? '(none)'} [${progress.done.join(',')}]`,
  )
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
