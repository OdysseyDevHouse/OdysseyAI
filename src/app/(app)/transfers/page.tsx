import { requireCapability } from '@/lib/auth'
import { listTransfers } from '@/lib/site/stockTransfers'
import { listLocations } from '@/lib/site/stockLocations'
import { formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  StatTile,
  EmptyState,
  Icons,
} from '@/components/ui'
import TransfersTable from './TransfersTable'

export const dynamic = 'force-dynamic'

export default async function TransfersPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('stock.transfer')

  const [transfers, locations] = await Promise.all([
    listTransfers(siteId, { status: 'all', limit: 200 }),
    listLocations(siteId, true),
  ])

  const posted = transfers.filter((t) => t.status === 'posted')
  const voided = transfers.filter((t) => t.status === 'cancelled')
  const unitsMoved = posted.reduce((sum, t) => sum + t.totalQty, 0)

  // A site with one location cannot transfer anything — there is nowhere for
  // stock to go. Saying so, with the way to fix it, beats an empty list and a
  // button that leads to a form that cannot be submitted.
  if (locations.length < 2) {
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

  return (
    <>
      <PageHeader
        title="Transfers"
        subtitle="Moving stock between locations. The site total never changes — only where it sits."
        action={
          <PrimaryLink href="/transfers/new">
            <Icons.Plus size={15} />
            New transfer
          </PrimaryLink>
        }
      />
      <PageBody>
        <div className="grid gap-4 sm:grid-cols-3">
          <StatTile label="Posted" value={String(posted.length)} />
          <StatTile label="Units moved" value={formatQty(unitsMoved)} />
          {/* A cancellation is the exception worth seeing, so it is the only tile that
              takes a tone — and only when there is actually one. */}
          <StatTile
            label="Cancelled"
            value={String(voided.length)}
            tone={voided.length > 0 ? 'warning' : 'default'}
          />
        </div>

        <Card>
          <TransfersTable transfers={transfers} />
        </Card>
      </PageBody>
    </>
  )
}
