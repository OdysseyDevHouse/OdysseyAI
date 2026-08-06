import { notFound } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getTransfer } from '@/lib/site/stockTransfers'
import { formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import VoidTransferButton from './VoidTransferButton'

export const dynamic = 'force-dynamic'

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const transferId = Number(id)
  if (!Number.isFinite(transferId) || transferId <= 0) notFound()

  const siteId = await requireSiteId()
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
          <Card className="p-4">
            <div className="flex items-start gap-3">
              <Badge tone="danger">Cancelled</Badge>
              <div className="text-sm text-muted">
                Reversed{transfer.cancelReason ? `: ${transfer.cancelReason}` : '.'} The stock was
                returned to {transfer.fromLocationName}.
              </div>
            </div>
          </Card>
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
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Code</th>
                  <th className={TABLE_TH}>Description</th>
                  <th className={`${TABLE_TH} text-right`}>Quantity</th>
                </tr>
              </thead>
              <tbody>
                {transfer.lines.map((line) => (
                  <tr key={line.id} className={TABLE_ROW}>
                    <td className={`${TABLE_TD} text-ink`}>{line.productCode ?? '—'}</td>
                    <td className={`${TABLE_TD} text-ink-2`}>{line.description}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Detail label="From" value={`${transfer.fromLocationCode} — ${transfer.fromLocationName}`} />
            <Detail label="To" value={`${transfer.toLocationCode} — ${transfer.toLocationName}`} />
            <Detail label="Reference" value={transfer.reference ?? '—'} />
            <Detail label="Captured by" value={transfer.userName || '—'} />
          </dl>
        </Card>

        <Card className="p-3">
          <p className="flex items-center gap-2 text-xs text-muted">
            <Icons.ArrowLeftRight size={14} className="text-faint" />
            {formatQty(transfer.totalQty)} unit{transfer.totalQty === 1 ? '' : 's'} across{' '}
            {transfer.lineCount} line{transfer.lineCount === 1 ? '' : 's'}. A transfer never changes
            what the business owns in total — only which location holds it.
          </p>
        </Card>
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
