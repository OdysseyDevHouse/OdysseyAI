import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getTransfer } from '@/lib/site/stockTransfers'
import { getStoreTransfer } from '@/lib/site/storeTransfers'
import { formatQty } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader, Icons } from '@/components/ui'
import VoidTransferButton from './VoidTransferButton'
import StoreTransferActions from './StoreTransferActions'
import TransferLinesTable from './TransferLinesTable'

export const dynamic = 'force-dynamic'

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const transferId = Number(id)
  if (!Number.isFinite(transferId) || transferId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.

  const { siteId } = await requireCapability('stock.transfer')
  const transfer = await getTransfer(siteId, transferId)
  if (!transfer) notFound()

  const isStore = transfer.direction !== 'internal'
  const outbound = transfer.direction === 'out'
  // Only a store transfer carries a peer, and only it needs the extra read.
  const store = isStore ? await getStoreTransfer(siteId, transferId) : null

  const peerName = transfer.peerSiteName ?? 'another store'

  /* The route, in words, because the two ends are different KINDS of thing on a
     store transfer — a room at one end and a whole business at the other. */
  const route = isStore
    ? outbound
      ? `${transfer.fromLocationName || 'here'} → ${peerName}`
      : `${peerName} → ${transfer.toLocationName || 'here'}`
    : `${transfer.fromLocationName} → ${transfer.toLocationName}`

  return (
    <>
      <PageHeader
        title={transfer.documentNumber ?? `Transfer #${transfer.id}`}
        subtitle={`${route} · ${transfer.documentDate}`}
        backHref="/transfers"
        backLabel="Transfers"
        action={
          isStore ? (
            // Only an OUTBOUND dispatch still on the truck can be acted on. An
            // inbound receipt is a record of what arrived, and the sender is
            // the one that recalls.
            outbound && transfer.status === 'in_transit' ? (
              <StoreTransferActions
                id={transfer.id}
                number={transfer.documentNumber ?? `#${transfer.id}`}
                peerSiteId={store?.peerSiteId ?? null}
                peerSiteName={peerName}
              />
            ) : undefined
          ) : transfer.status === 'posted' ? (
            <VoidTransferButton id={transfer.id} number={transfer.documentNumber ?? ''} />
          ) : undefined
        }
      />
      <PageBody>
        {transfer.status === 'in_transit' && (
          <Callout tone="warning" title="On its way">
            These goods have left {transfer.fromLocationName || 'the location'} and are in transit
            to {peerName}. They are still owned by this store, and still on its books, until{' '}
            {peerName} confirms what arrived.
          </Callout>
        )}

        {transfer.status === 'cancelled' && (
          <Callout tone="danger" title={isStore ? 'Recalled' : 'Cancelled'}>
            Reversed{transfer.cancelReason ? `: ${transfer.cancelReason}` : '.'}{' '}
            {isStore
              ? `The stock came out of transit and back into ${transfer.fromLocationName || 'the location it left'}.`
              : `The stock was returned to ${transfer.fromLocationName}.`}
          </Callout>
        )}

        {isStore && transfer.status === 'received' && store?.peerDocumentNumber && (
          <Callout tone="success" title="Completed">
            {outbound
              ? `${peerName} confirmed this delivery on ${store.peerDocumentNumber}.`
              : `Received against ${peerName}'s dispatch ${store.peerDocumentNumber}.`}
          </Callout>
        )}

        <Card>
          <CardHeader
            title="What moved"
            description={
              isStore
                ? outbound
                  ? 'Each line took stock out of the source location and put it in transit. It leaves this store for good when the delivery is confirmed.'
                  : 'Each line wrote one movement into this store, and folded its cost into the average — these goods were not owned here a moment ago.'
                : transfer.status === 'posted'
                  ? 'Each line wrote two movements — out of the source, into the destination.'
                  : 'This transfer has been reversed. Its movements remain, with their reversals beside them.'
            }
          />
          {/* The lines are plain data; the columns' functions live in the
              client component, where they are allowed to. */}
          <TransferLinesTable lines={transfer.lines} />
        </Card>

        <Card className="p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Detail
              label="From"
              value={
                isStore && !outbound
                  ? peerName
                  : `${transfer.fromLocationCode} — ${transfer.fromLocationName}`
              }
            />
            <Detail
              label="To"
              value={
                isStore && outbound
                  ? peerName
                  : `${transfer.toLocationCode} — ${transfer.toLocationName}`
              }
            />
            <Detail label="Reference" value={transfer.reference ?? '—'} />
            <Detail label="Captured by" value={transfer.userName || '—'} />
          </dl>
        </Card>

        <Callout tone="neutral" icon={<Icons.ArrowLeftRight size={18} />}>
          {formatQty(transfer.totalQty)} unit{transfer.totalQty === 1 ? '' : 's'} across{' '}
          {transfer.lineCount} line{transfer.lineCount === 1 ? '' : 's'}.{' '}
          {isStore
            ? 'A store transfer moves goods between two businesses that keep separate books, so what leaves one is only owned by the other once it is confirmed.'
            : 'A transfer never changes what the business owns in total — only which location holds it.'}
        </Callout>
      </PageBody>
    </>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  )
}
