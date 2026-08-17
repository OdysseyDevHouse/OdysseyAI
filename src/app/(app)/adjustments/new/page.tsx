import { requireModuleCapability } from '@/lib/auth'
import { listLocations } from '@/lib/site/stockLocations'
import { listReasons } from '@/lib/site/stockAdjustments'
import { PageHeader, PageBody, Card, EmptyState, Icons, PrimaryLink } from '@/components/ui'
import NewAdjustmentScreen from './NewAdjustmentScreen'

export const dynamic = 'force-dynamic'

export default async function NewAdjustmentPage() {
  const { siteId } = await requireModuleCapability('inventory_advanced', 'stock.adjust')

  const [locations, reasons] = await Promise.all([
    listLocations(siteId, false, true),
    listReasons(siteId, false),
  ])

  /*
   * A site with every reason retired cannot post anything — the document
   * refuses a blank reason, so the form would be unsubmittable. Saying so, with
   * the way to fix it, beats a select with nothing in it.
   *
   * There is no matching guard for locations: 025 seeds MAIN and refuses to
   * delete a location holding stock, so there is always at least one.
   */
  if (reasons.length === 0) {
    return (
      <>
        <PageHeader
          title="New adjustment"
          subtitle="Writing stock on or off."
          backHref="/adjustments"
          backLabel="Back to adjustments"
        />
        <PageBody>
          <Card>
            <EmptyState
              title="There are no active reasons"
              hint="An adjustment records why stock moved, so there has to be a reason to choose. Add one in Setup, then come back."
              icon={<Icons.SlidersHorizontal size={22} />}
              action={
                <PrimaryLink href="/setup/adjustment-reasons">
                  <Icons.Plus size={15} />
                  Add a reason
                </PrimaryLink>
              }
            />
          </Card>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="New adjustment"
        subtitle="Writing stock on or off in one location, with a reason."
        backHref="/adjustments"
        backLabel="Back to adjustments"
      />
      <NewAdjustmentScreen locations={locations} reasons={reasons} />
    </>
  )
}
