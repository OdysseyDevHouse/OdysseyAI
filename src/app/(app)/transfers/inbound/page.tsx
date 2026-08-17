import Link from 'next/link'
import { requireModuleCapability } from '@/lib/auth'
import { pendingInbound } from '@/lib/site/storeTransfers'
import { formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  EmptyState,
  Badge,
  Icons,
  ButtonLink,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * What other stores have sent that has not been received here.
 *
 * The rows are read from the SENDING stores' databases, because until somebody
 * confirms a delivery nothing about it exists here — that is the whole point of
 * a two-step transfer. A store whose database is unreachable is simply absent;
 * pendingInbound swallows that so one dead branch cannot stop the others being
 * received.
 */
export default async function InboundTransfersPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'stock.transfer')
  const inbound = await pendingInbound(siteId)

  return (
    <>
      <PageHeader
        title="On its way here"
        subtitle="Stock other stores have dispatched and this one has not received yet."
        backHref="/transfers"
        backLabel="Transfers"
      />
      <PageBody>
        {inbound.length === 0 ? (
          <Card>
            <EmptyState
              title="Nothing is on its way"
              hint="When another store dispatches stock to this one it appears here, and stays until somebody confirms what actually arrived."
              icon={<Icons.Truck size={22} />}
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            {inbound.map((t) => {
              const units = t.lines.reduce((sum, l) => sum + l.qty, 0)
              return (
                <Card key={`${t.peerSiteId}-${t.id}`}>
                  <CardHeader
                    title={
                      <span className="flex items-center gap-2">
                        {t.documentNumber ?? `#${t.id}`}
                        <Badge tone="warning">In transit</Badge>
                      </span>
                    }
                    description={`From ${t.peerSiteName ?? 'another store'} · dispatched ${t.documentDate}${
                      t.reference ? ` · ref ${t.reference}` : ''
                    }`}
                    action={
                      <ButtonLink
                        href={`/transfers/inbound/${t.peerSiteId}/${t.id}`}
                        variant="primary"
                      >
                        <Icons.Check size={15} />
                        Receive
                      </ButtonLink>
                    }
                  />
                  <div className="px-5 py-4 text-sm text-muted">
                    {t.lines.length} line{t.lines.length === 1 ? '' : 's'},{' '}
                    <span className="numeric text-ink-2">{formatQty(units)}</span> unit
                    {units === 1 ? '' : 's'} — {t.lines.slice(0, 4).map((l) => l.productCode).join(', ')}
                    {t.lines.length > 4 ? ` and ${t.lines.length - 4} more` : ''}
                    {t.note ? (
                      <span className="mt-1 block text-xs text-faint">{t.note}</span>
                    ) : null}
                  </div>
                </Card>
              )
            })}
          </div>
        )}

        <Card className="p-3">
          <p className="text-xs text-muted">
            These goods are still owned by the store that sent them. They only join this store’s
            stock — and its valuation — when the delivery is confirmed below.{' '}
            <Link href="/transfers" className="text-brand hover:underline">
              Back to transfers
            </Link>
          </p>
        </Card>
      </PageBody>
    </>
  )
}
