import { requireCapability } from '@/lib/auth'
import { PageHeader, PageBody } from '@/components/ui'
import { listServiceTiers } from '@/lib/site/tips'
import { getSetting } from '@/lib/site/settings'
import { overlappingTiers } from '@/lib/tipMath'
import TipsClient from './TipsClient'

export const dynamic = 'force-dynamic'

/**
 * Tips and service charges.
 *
 * The per-tender behaviour — whether an over-payment becomes a tip, and whether a tip lands
 * in the drawer — lives on Setup → Tender types, beside the other flags for the same
 * method. Only the SERVICE CHARGE is configured here, because it is a property of the bill
 * rather than of how it was paid.
 */
export default async function TipsSetupPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('setup.edit')

  const [tiers, stored] = await Promise.all([
    listServiceTiers(siteId),
    getSetting(siteId, 'tips_tables_only'),
  ])

  return (
    <>
      <PageHeader
        title="Tips"
        subtitle="What a bill is charged on top of the goods, and where it applies"
      />
      <PageBody>
        <TipsClient
          tiers={tiers}
          /* Absent means ON — the careful default. A percentage appearing on takeaways the
             moment a shop configures its first band is a charge nobody agreed to. */
          tablesOnly={stored === null || stored === undefined ? true : String(stored) !== '0'}
          overlaps={overlappingTiers(tiers).length}
        />
      </PageBody>
    </>
  )
}
