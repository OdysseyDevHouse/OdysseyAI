import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getStockTake } from '@/lib/site/stockTakes'
import { formatQty } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader, Icons } from '@/components/ui'
import CountSheet from './CountSheet'
import SheetActions from './SheetActions'

export const dynamic = 'force-dynamic'

const STATUS_SUBTITLE: Record<string, string> = {
  draft: 'Being built. Freeze it when counting starts.',
  counting: 'Counting is under way. The till is still selling.',
  posted: 'Posted. The variances are on the books.',
  cancelled: 'Cancelled.',
}

export default async function StockTakePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const takeId = Number(id)
  if (!Number.isFinite(takeId) || takeId <= 0) notFound()

  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('inventory_advanced', 'stock.adjust')
  const take = await getStockTake(siteId, takeId)
  if (!take) notFound()

  const readOnly = take.status === 'posted' || take.status === 'cancelled'
  const counted = take.lines.filter((l) => l.countedQty !== null).length

  /*
   * Which lines "differ" depends on whether the sheet has posted.
   *
   * Before posting, the honest figure is counted-vs-snapshot: that is what the
   * person counting is looking at, and nothing has been written yet.
   *
   * After posting, variance_qty holds what was ACTUALLY written — measured
   * against the pile at the moment of posting. That is the set worth re-counting,
   * and it is not always the same set: a line that looked wrong against a stale
   * snapshot may have posted a variance of zero because the difference was a
   * sale that had not yet reached the sheet.
   */
  const varianceLines =
    take.status === 'posted'
      ? take.lines.filter((l) => l.varianceQty !== null && Math.abs(l.varianceQty) > 0.0005)
      : take.lines.filter(
          (l) => l.countedQty !== null && Math.abs(l.countedQty - l.snapshotQty) > 0.0005,
        )

  return (
    <>
      <PageHeader
        title={take.documentNumber ?? `Stock take #${take.id}`}
        subtitle={`${take.locationName} · ${take.documentDate} · ${STATUS_SUBTITLE[take.status] ?? ''}`}
        backHref="/stock-takes"
        backLabel="Stock takes"
        action={
          <SheetActions
            id={take.id}
            status={take.status}
            number={take.documentNumber}
            counted={counted}
            lineCount={take.lineCount}
            varianceCount={varianceLines.length}
          />
        }
      />
      <PageBody>
        {take.status === 'cancelled' && (
          <Callout tone="danger" title="Cancelled">
            {take.cancelReason ? `${take.cancelReason}. ` : ''}
            {take.postedAt
              ? 'The adjustments this sheet wrote have been reversed — the movements remain, with their reversals beside them.'
              : 'This sheet was abandoned before it posted, so no stock moved.'}
          </Callout>
        )}

        {take.status === 'posted' && (
          <Callout
            tone={Math.abs(take.varianceValue) < 0.005 ? 'success' : 'warning'}
            /* Titled on VALUE, because that is what a variance means to the
               business — and because value and units can point opposite ways:
               forty cheap units found against two expensive ones missing is a
               write-OFF, however good "+38 units" looks. */
            title={
              Math.abs(take.varianceValue) < 0.005
                ? 'Counted straight'
                : `R ${Math.abs(take.varianceValue).toFixed(2)} ${take.varianceValue < 0 ? 'written off' : 'written on'}`
            }
          >
            {Math.abs(take.varianceValue) < 0.005
              ? 'Every line matched what the books said. Nothing moved and no ledger entry was needed.'
              : `${take.varianceQty > 0 ? '+' : ''}${formatQty(take.varianceQty)} units across the sheet, posted against stock adjustments. Only lines that differed wrote a movement.`}
          </Callout>
        )}

        {take.status === 'draft' && (
          <Callout tone="brand" icon={<Icons.Info size={18} />}>
            This sheet is still a draft, so its figures refresh as stock moves. Freezing it fixes
            what the system believes at that moment — which is what you count against. The till
            carries on selling either way.
          </Callout>
        )}

        <Card>
          <CardHeader
            title="The count"
            description={
              readOnly
                ? 'What was counted, and what the system believed at the time.'
                : 'Scan to jump to a line. Enter saves it and moves to the next one still to count.'
            }
          />
          {/* The lines are plain data; the inputs and handlers live in the
              client component, where they are allowed to. */}
          <CountSheet takeId={take.id} lines={take.lines} readOnly={readOnly} />
        </Card>

        <Card className="p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Detail label="Location" value={`${take.locationCode} — ${take.locationName}`} />
            <Detail label="Scope" value={SCOPE_LABEL[take.scope] ?? take.scope} />
            <Detail label="Reference" value={take.reference ?? '—'} />
            <Detail label="Started by" value={take.userName || '—'} />
          </dl>
        </Card>
      </PageBody>
    </>
  )
}

const SCOPE_LABEL: Record<string, string> = {
  full: 'Everything in this location',
  department: 'One department',
  brand: 'One brand',
  supplier: 'One supplier',
  manual: 'Chosen products',
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-ink-2">{value}</dd>
    </div>
  )
}
