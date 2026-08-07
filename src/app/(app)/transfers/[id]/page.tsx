import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getTransfer } from '@/lib/site/stockTransfers'
import { formatQty } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader, Icons } from '@/components/ui'
import VoidTransferButton from './VoidTransferButton'
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

  return (
    <>
      <PageHeader
        title={transfer.documentNumber ?? `Transfer #${transfer.id}`}
        subtitle={`${transfer.fromLocationName} → ${transfer.toLocationName} · ${transfer.documentDate}`}
        backHref="/transfers"
        backLabel="Transfers"
        action={
          transfer.status === 'posted' ? (
            <VoidTransferButton id={transfer.id} number={transfer.documentNumber ?? ''} />
          ) : undefined
        }
      />
      <PageBody>
        {transfer.status === 'cancelled' && (
          <Callout tone="danger" title="Cancelled">
            Reversed{transfer.cancelReason ? `: ${transfer.cancelReason}` : '.'} The stock was
            returned to {transfer.fromLocationName}.
          </Callout>
        )}

        <Card>
          <CardHeader
            title="What moved"
            description={
              transfer.status === 'posted'
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
            <Detail label="From" value={`${transfer.fromLocationCode} — ${transfer.fromLocationName}`} />
            <Detail label="To" value={`${transfer.toLocationCode} — ${transfer.toLocationName}`} />
            <Detail label="Reference" value={transfer.reference ?? '—'} />
            <Detail label="Captured by" value={transfer.userName || '—'} />
          </dl>
        </Card>

        <Callout tone="neutral" icon={<Icons.ArrowLeftRight size={18} />}>
          {formatQty(transfer.totalQty)} unit{transfer.totalQty === 1 ? '' : 's'} across{' '}
          {transfer.lineCount} line{transfer.lineCount === 1 ? '' : 's'}. A transfer never changes
          what the business owns in total — only which location holds it.
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
