import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getStockTake, approvalState } from '@/lib/site/stockTakes'
import { listReasons } from '@/lib/site/stockAdjustments'
import { can } from '@/lib/site/permissions'
import { formatQty } from '@/lib/decimals'
import { PageHeader, PageBody, Callout, Card, CardHeader, Badge, Icons } from '@/components/ui'
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
  const { siteId, capabilities } = await requireModuleCapability(
    'inventory_advanced',
    'stock.adjust',
  )
  const take = await getStockTake(siteId, takeId)
  if (!take) notFound()

  const readOnly = take.status === 'posted' || take.status === 'cancelled'
  const counted = take.lines.filter((l) => l.countedQty !== null).length

  /*
   * Sign-off (218), and the reasons an approver picks from.
   *
   * Computed here rather than in the grid because the SAME numbers decide two
   * separate things — whether the post button will be refused, and what the
   * grid renders — and two copies of a threshold calculation is exactly how
   * a screen ends up saying a sheet is clear while posting refuses it.
   *
   * The reason list is only fetched for somebody who may actually approve.
   * Shipping the whole vocabulary to a counter who can do nothing with it is a
   * payload for nothing.
   */
  const canApprove = can(capabilities, 'stock.approve_variance')
  const [{ flagged, outstanding }, reasonRows] = await Promise.all([
    approvalState(siteId, take),
    // Active reasons only: a retired one must stay readable on an old approval
    // (218 uses SET NULL for exactly that) but must not be offered on a new one.
    canApprove && !readOnly ? listReasons(siteId) : Promise.resolve([]),
  ])
  const reasons = reasonRows.map((r) => ({ id: r.id, name: r.name }))

  /* Line id → why it is held, in the words the post refusal will use. */
  const flaggedByLine: Record<number, string> = {}
  for (const f of flagged) flaggedByLine[f.line.id] = f.reason

  /*
   * Blindness applies while the sheet is being COUNTED and not after.
   *
   * Resolved here so the grid never has to reason about status: it is handed a
   * boolean that already means "hide the answer from this person right now".
   */
  const blind = take.isBlind && !readOnly

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
            outstandingSignoffs={outstanding.length}
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

        {/* Said plainly rather than left for someone to notice two columns are
            missing. A counter who does not know the sheet is blind assumes the
            screen is broken and goes looking for the figure elsewhere, which is
            the one behaviour the mode exists to prevent. */}
        {blind && (
          <Callout tone="neutral" icon={<Icons.EyeOff size={18} />} title="Counting blind">
            What the system believes is hidden until this sheet posts, so what you write down is
            what you actually found. Count the shelf, not the screen.
          </Callout>
        )}

        {/* The refusal, before somebody meets it as an error on the post button.
            Names the count so the reader knows which sheet is held, and says who
            can clear it rather than only that it is stuck. */}
        {!readOnly && outstanding.length > 0 && (
          <Callout
            tone="warning"
            title={`${outstanding.length} line${outstanding.length === 1 ? '' : 's'} need${outstanding.length === 1 ? 's' : ''} signing off before this can post`}
          >
            {canApprove
              ? 'These variances are larger than the threshold this shop set. Give each one a reason on the sheet below and the count will post.'
              : 'These variances are larger than the threshold this shop set. Someone with permission to sign off a large variance has to review them before the count can post.'}
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
          <CountSheet
            takeId={take.id}
            lines={take.lines}
            readOnly={readOnly}
            blind={blind}
            flagged={flaggedByLine}
            reasons={reasons}
            canApprove={canApprove}
          />
        </Card>

        <Card className="p-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <Detail label="Location" value={`${take.locationCode} — ${take.locationName}`} />
            <Detail label="Scope" value={SCOPE_LABEL[take.scope] ?? take.scope} />
            <Detail label="Reference" value={take.reference ?? '—'} />
            <Detail label="Started by" value={take.userName || '—'} />
            {/* Stays on a POSTED sheet, where the grid has stopped hiding
                anything. How a count was taken is part of how much it is worth
                trusting, and that is a question asked months later. */}
            {take.isBlind && (
              <div>
                <dt className="text-xs text-muted">Counted</dt>
                <dd>
                  <Badge tone="neutral">
                    <Icons.EyeOff size={12} />
                    Blind
                  </Badge>
                </dd>
              </div>
            )}
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
