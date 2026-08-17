import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getAdjustment } from '@/lib/site/stockAdjustments'
import { formatMoney, formatQty } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader, Icons } from '@/components/ui'
import AdjustmentActions from './AdjustmentActions'
import AdjustmentLinesTable from './AdjustmentLinesTable'

export const dynamic = 'force-dynamic'

export default async function AdjustmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const adjustmentId = Number(id)
  if (!Number.isFinite(adjustmentId) || adjustmentId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'stock.adjust')
  const adjustment = await getAdjustment(siteId, adjustmentId)
  if (!adjustment) notFound()

  // A draft has no posted figures yet, so the totals are computed from what has
  // been captured. After posting they come from the document, which is what was
  // actually written rather than what was intended.
  const capturedQty = adjustment.lines.reduce((sum, l) => sum + l.qtyChange, 0)
  const capturedValue = adjustment.lines.reduce((sum, l) => sum + l.qtyChange * l.unitCostExcl, 0)
  const netQty = adjustment.status === 'posted' ? adjustment.varianceQty : capturedQty
  const netValue = adjustment.status === 'posted' ? adjustment.varianceValue : capturedValue

  return (
    <>
      <PageHeader
        title={adjustment.documentNumber ?? `Adjustment #${adjustment.id}`}
        subtitle={`${adjustment.locationName} · ${adjustment.documentDate}`}
        backHref="/adjustments"
        backLabel="Adjustments"
        action={
          <AdjustmentActions
            id={adjustment.id}
            number={adjustment.documentNumber ?? `#${adjustment.id}`}
            status={adjustment.status}
          />
        }
      />
      <PageBody>
        {adjustment.status === 'draft' && (
          <Callout tone="warning" title="Draft">
            Nothing has moved yet. The quantities below are what will be written when this is
            posted.
          </Callout>
        )}

        {adjustment.status === 'cancelled' && (
          <Callout tone="danger" title="Reversed">
            {adjustment.cancelReason ? `${adjustment.cancelReason}.` : 'This adjustment was reversed.'}{' '}
            {adjustment.postedAt
              ? 'The opposite movement was written against every line, so the stock went back.'
              : 'It was never posted, so nothing moved.'}
          </Callout>
        )}

        <Card>
          <CardHeader
            title="What changed"
            description={
              adjustment.status === 'posted'
                ? 'Each line wrote one movement against this location, and the value posted to stock adjustments in the ledger.'
                : 'Each line will write one movement against this location when posted.'
            }
          />
          {/* The lines are plain data; the columns' functions live in the client
              component, where they are allowed to. */}
          <AdjustmentLinesTable lines={adjustment.lines} documentReason={adjustment.reasonName} />
        </Card>

        <Card className="p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Detail
              label="Location"
              value={`${adjustment.locationCode} — ${adjustment.locationName}`}
            />
            <Detail label="Reason" value={adjustment.reasonName ?? 'Per line'} />
            <Detail label="Reference" value={adjustment.reference ?? '—'} />
            <Detail label="Captured by" value={adjustment.userName || '—'} />
          </dl>
          {adjustment.note && (
            <p className="mt-3 border-t border-border pt-3 text-sm text-muted">{adjustment.note}</p>
          )}
        </Card>

        <Callout
          tone={netValue < 0 ? 'danger' : 'neutral'}
          icon={<Icons.SlidersHorizontal size={18} />}
        >
          {netQty < 0 ? 'Written off' : 'Written on'}: {formatQty(Math.abs(netQty))} unit
          {Math.abs(netQty) === 1 ? '' : 's'} across {adjustment.lines.length} line
          {adjustment.lines.length === 1 ? '' : 's'}, worth {formatMoney(Math.abs(netValue))}. An
          adjustment changes what the business owns; it does not change what anything cost.
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
