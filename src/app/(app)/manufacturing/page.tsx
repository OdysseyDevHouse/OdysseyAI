import { requireModuleCapability } from '@/lib/auth'
import { listBuilds, listManufacturableProducts } from '@/lib/site/manufacturing'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  StatStrip,
  StatTile,
  EmptyState,
  Icons,
} from '@/components/ui'
import ManufacturingTable, { type BuildRow } from './ManufacturingTable'

export const dynamic = 'force-dynamic'

export default async function ManufacturingPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'products.edit')

  const [{ items }, buildable] = await Promise.all([
    listBuilds(siteId, { limit: 200 }),
    listManufacturableProducts(siteId),
  ])

  const posted = items.filter((b) => b.status === 'posted')
  const unbuilt = items.filter((b) => b.status === 'cancelled')
  const unitsMade = posted.reduce((sum, b) => sum + b.qty, 0)
  const valueMade = posted.reduce((sum, b) => sum + b.totalCost, 0)

  // Nothing is marked as made in batches, so there is nothing to build. Saying
  // so — with the way to fix it — beats an empty list behind a button that
  // leads to a form with an empty picker.
  if (buildable.length === 0 && items.length === 0) {
    return (
      <>
        <PageHeader title="Manufacturing" subtitle="Building recipe products into stock you can count." />
        <PageBody>
          <Card>
            <EmptyState
              title="No products are made in batches yet"
              hint={
                'Manufacturing builds a recipe product ahead of time: the ingredients come off the shelf now, and the finished item goes on it. ' +
                'To use it, open a recipe product and turn on "Made in batches". A recipe left off keeps working the way it does today — its ingredients come off when it sells.'
              }
              icon={<Icons.Factory size={22} />}
              action={
                <PrimaryLink href="/products">
                  <Icons.Boxes size={15} />
                  Go to products
                </PrimaryLink>
              }
            />
          </Card>
        </PageBody>
      </>
    )
  }

  const rows: BuildRow[] = items.map((b) => ({
    id: b.id,
    documentNumber: b.documentNumber,
    documentDate: b.documentDate,
    productCode: b.productCode,
    description: b.description,
    qty: b.qty,
    status: b.status,
    unitCostExcl: b.unitCostExcl,
    totalCost: b.totalCost,
    toLocationCode: b.toLocationCode,
  }))

  return (
    <>
      <PageHeader
        title="Manufacturing"
        subtitle="Building recipe products into stock. The ingredients come off the shelf and the finished item goes on it."
        action={
          <PrimaryLink href="/manufacturing/new">
            <Icons.Plus size={15} />
            New build
          </PrimaryLink>
        }
      />
      <PageBody>
        <StatStrip columns={4}>
          <StatTile label="Builds" value={String(posted.length)} />
          <StatTile label="Units made" value={formatQty(unitsMade)} />
          <StatTile label="Value produced" value={formatMoney(valueMade)} />
          {/* An unbuild is the exception worth seeing, so it is the only tile
              that takes a tone — and only when there has actually been one. */}
          <StatTile
            label="Unbuilt"
            value={String(unbuilt.length)}
            tone={unbuilt.length > 0 ? 'warning' : 'default'}
          />
        </StatStrip>

        <Card>
          <ManufacturingTable rows={rows} />
        </Card>
      </PageBody>
    </>
  )
}
