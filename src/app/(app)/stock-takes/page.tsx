import { requireCapability } from '@/lib/auth'
import { listStockTakes } from '@/lib/site/stockTakes'
import { formatQty } from '@/lib/decimals'
import { PageHeader, PageBody, PrimaryLink, Card, StatStrip, StatTile, Icons } from '@/components/ui'
import StockTakesTable from './StockTakesTable'

export const dynamic = 'force-dynamic'

export default async function StockTakesPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('stock.adjust')

  const takes = await listStockTakes(siteId, { status: 'all', limit: 200 })

  const open = takes.filter((t) => t.status === 'draft' || t.status === 'counting')
  const posted = takes.filter((t) => t.status === 'posted')
  const toCount = open.reduce((sum, t) => sum + (t.lineCount - t.countedCount), 0)
  const written = posted.reduce((sum, t) => sum + t.varianceValue, 0)

  return (
    <>
      <PageHeader
        title="Stock takes"
        subtitle="Counting what is on the shelf, and writing the difference. The till keeps selling while you count."
        action={
          <PrimaryLink href="/stock-takes/new">
            <Icons.Plus size={15} />
            New stock take
          </PrimaryLink>
        }
      />
      <PageBody>
        <StatStrip columns={3}>
          {/* Lines still to count is the one figure that means ACT ON ME, so it
              is the only tile that takes a tone — and only when there are any. */}
          <StatTile
            label="Still to count"
            value={formatQty(toCount)}
            tone={toCount > 0 ? 'warning' : 'default'}
            hint={open.length > 0 ? `${open.length} sheet${open.length === 1 ? '' : 's'} open` : undefined}
          />
          <StatTile label="Posted" value={String(posted.length)} />
          <StatTile
            label="Written off"
            value={formatMoney(written)}
            hint="Net value across every posted count"
          />
        </StatStrip>

        <Card>
          <StockTakesTable takes={takes} />
        </Card>
      </PageBody>
    </>
  )
}

/**
 * The net variance, signed.
 *
 * Written off is the normal direction, so a negative figure is shown WITHOUT a
 * minus: "R 240" under a label reading "Written off" already says which way it
 * went, and a minus there reads as a double negative. A surplus is the odd case
 * and keeps its plus.
 */
function formatMoney(value: number): string {
  const abs = Math.abs(value)
  const body = abs.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${value > 0.005 ? '+R ' : 'R '}${body}`
}
