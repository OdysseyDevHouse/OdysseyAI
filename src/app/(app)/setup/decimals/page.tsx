import { requireCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import DecimalSettingsClient from './DecimalSettingsClient'

export const dynamic = 'force-dynamic'

/**
 * How precise the numbers on this shop's screens are.
 *
 * Guarded on `setup.edit` like every other setup screen. Nothing here can
 * change a stored figure — both settings are display rules — so the risk is
 * legibility rather than data, and the capability is the ordinary one.
 */
export default async function DecimalsSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const settings = await getSettings(siteId, ['qty_decimals', 'cost_decimals'])

  return (
    <>
      <PageHeader
        title="Decimal places"
        subtitle="How many decimals your quantities and costs are shown with. Nothing stored changes — only what you read."
      />
      <PageBody>
        <DecimalSettingsClient
          initial={{ qty: settings.qty_decimals, cost: settings.cost_decimals }}
        />
      </PageBody>
    </>
  )
}
