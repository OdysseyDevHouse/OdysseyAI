import { requireCapability } from '@/lib/auth'
import { listTransfers } from '@/lib/site/stockTransfers'
import { listLocations } from '@/lib/site/stockLocations'
import { eligibleStores, pendingInbound } from '@/lib/site/storeTransfers'
import { formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  StatStrip,
  StatTile,
  EmptyState,
  Icons,
} from '@/components/ui'
import TransfersTable from './TransfersTable'

export const dynamic = 'force-dynamic'

export default async function TransfersPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('stock.transfer')

  const [transfers, locations, stores] = await Promise.all([
    listTransfers(siteId, { status: 'all', direction: 'all', limit: 200 }),
    listLocations(siteId, true, true),
    eligibleStores(siteId),
  ])

  /*
   * Nowhere for stock to go: one room AND no linked store.
   *
   * The store half of this condition is what changed when store transfers
   * arrived — a shop with a single location and a sibling branch has a
   * perfectly good transfer to make, and the old guard would have shown it a
   * dead end. Saying so, with the way to fix it, still beats an empty list and
   * a button leading to a form that cannot be submitted.
   */
  if (locations.length < 2 && stores.length === 0) {
    return (
      <>
        <PageHeader title="Transfers" subtitle="Moving stock between locations." />
        <PageBody>
          <Card>
            <EmptyState
              title="There is only one stock location"
              hint="A transfer moves stock from one location to another, so there needs to be somewhere to move it to. Add a second location in Setup, then come back."
              icon={<Icons.ArrowLeftRight size={22} />}
              action={
                <PrimaryLink href="/setup/locations">
                  <Icons.Plus size={15} />
                  Add a location
                </PrimaryLink>
              }
            />
          </Card>
        </PageBody>
      </>
    )
  }

  // Only asked when there is somewhere it could come from: this reads every
  // linked store's database, and a standalone shop should not pay for that.
  const inbound = stores.length > 0 ? await pendingInbound(siteId) : []

  const settled = transfers.filter((t) => t.status === 'posted' || t.status === 'received')
  const inTransit = transfers.filter((t) => t.status === 'in_transit')
  const unitsMoved = settled.reduce((sum, t) => sum + t.totalQty, 0)

  return (
    <>
      <PageHeader
        title="Transfers"
        subtitle={
          stores.length > 0
            ? 'Moving stock between locations here, and between this store and the others.'
            : 'Moving stock between locations. The site total never changes — only where it sits.'
        }
        action={
          <>
            {stores.length > 0 && (
              <ButtonLink
                href="/transfers/inbound"
                variant={inbound.length > 0 ? 'secondary' : 'ghost'}
              >
                <Icons.Truck size={15} />
                On its way here{inbound.length > 0 ? ` (${inbound.length})` : ''}
              </ButtonLink>
            )}
            <PrimaryLink href="/transfers/new">
              <Icons.Plus size={15} />
              New transfer
            </PrimaryLink>
          </>
        }
      />
      <PageBody>
        <StatStrip columns={stores.length > 0 ? 4 : 3}>
          <StatTile label="Completed" value={String(settled.length)} />
          <StatTile label="Units moved" value={formatQty(unitsMoved)} />
          {/* Goods on a truck are still this store's until somebody confirms
              them, so these two are the tiles that mean "waiting on a person" —
              and they are the only ones that take a tone. */}
          {stores.length > 0 && (
            <>
              <StatTile
                label="Out in transit"
                value={String(inTransit.length)}
                tone={inTransit.length > 0 ? 'warning' : 'default'}
              />
              <StatTile
                label="Coming here"
                value={String(inbound.length)}
                tone={inbound.length > 0 ? 'warning' : 'default'}
              />
            </>
          )}
          {stores.length === 0 && (
            <StatTile
              label="Cancelled"
              value={String(transfers.filter((t) => t.status === 'cancelled').length)}
            />
          )}
        </StatStrip>

        <Card>
          <TransfersTable transfers={transfers} />
        </Card>
      </PageBody>
    </>
  )
}
