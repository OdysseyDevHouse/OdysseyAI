import { requireModuleCapability } from '@/lib/auth'
import { listAdjustments } from '@/lib/site/stockAdjustments'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  StatStrip,
  StatTile,
  Icons,
} from '@/components/ui'
import AdjustmentsTable from './AdjustmentsTable'

export const dynamic = 'force-dynamic'

export default async function AdjustmentsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'stock.adjust')

  const adjustments = await listAdjustments(siteId, { status: 'all', limit: 200 })

  const posted = adjustments.filter((a) => a.status === 'posted')
  const drafts = adjustments.filter((a) => a.status === 'draft')

  // Only the losses, and shown as a positive figure under a label that says
  // what it is. Netting write-ons against write-offs would let a big correction
  // hide a month of breakage, which is the one thing this tile is for.
  const writtenOff = posted.reduce((sum, a) => sum + Math.min(a.varianceValue, 0), 0)

  return (
    <>
      <PageHeader
        title="Stock adjustments"
        subtitle="Writing stock on or off with a reason, without counting the whole location."
        action={
          <PrimaryLink href="/adjustments/new">
            <Icons.Plus size={15} />
            New adjustment
          </PrimaryLink>
        }
      />
      <PageBody>
        <StatStrip columns={3}>
          <StatTile label="Posted" value={String(posted.length)} />
          <StatTile label="Written off" value={formatMoney(Math.abs(writtenOff))} />
          {/* A draft has moved nothing and is waiting on somebody, so it is the
              only tile that takes a tone — and only when there is one. */}
          <StatTile
            label="Drafts"
            value={String(drafts.length)}
            tone={drafts.length > 0 ? 'warning' : 'default'}
          />
        </StatStrip>

        <Card>
          <AdjustmentsTable adjustments={adjustments} />
        </Card>
      </PageBody>
    </>
  )
}
