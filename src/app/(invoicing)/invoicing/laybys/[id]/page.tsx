import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getLayby, LAYBY_STATUS_LABELS, cancellationFeePct } from '@/lib/site/laybys'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getSettings } from '@/lib/site/settings'
import { cancellationOutcome, percentPaid } from '@/lib/laybyRules'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  Callout,
  StatTile,
  StatStrip,
  Icons,
} from '@/components/ui'
import LaybyActions from './LaybyActions'
import {
  LaybyItemsTable,
  LaybyPaymentsTable,
  type LaybyItemRow,
  type LaybyPaymentRow,
} from './LaybyTables'

export const dynamic = 'force-dynamic'

export default async function LaybyPage({ params }: { params: Promise<{ id: string }> }) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('sales.view')
  const { id: raw } = await params

  const id = Number(raw)
  if (!Number.isFinite(id) || id <= 0) notFound()

  const layby = await getLayby(siteId, id)
  if (!layby) notFound()

  const [tenders, fee, settings] = await Promise.all([
    listTenderTypes(siteId),
    cancellationFeePct(siteId),
    getSettings(siteId, ['layby_terms_text']),
  ])

  const today = new Date().toISOString().slice(0, 10)
  const disclosed = (settings.layby_terms_text ?? '').trim().length > 0

  // What cancelling right now would cost the customer, shown BEFORE they
  // commit to it rather than as a surprise afterwards.
  const wouldBe = cancellationOutcome({
    totalIncl: layby.totalIncl,
    paidTotal: layby.paidTotal,
    dueDate: layby.dueDate,
    asAt: today,
    feePct: disclosed ? fee.pct : 0,
  })

  const late = layby.status === 'open' && layby.dueDate !== null && layby.dueDate < today

  // DataTable's cells are functions, which cannot cross the server→client
  // boundary — so the tables live in LaybyTables and get plain rows.
  const itemRows: LaybyItemRow[] = layby.lines.map((line) => ({
    id: line.id,
    description: line.description,
    productCode: line.productCode,
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    lineTotalIncl: line.lineTotalIncl,
  }))

  const paymentRows: LaybyPaymentRow[] = layby.payments.map((payment) => ({
    id: payment.id,
    paidOn: payment.paidOn,
    kind: payment.kind,
    tenderName: payment.tenderName,
    userName: payment.userName,
    amount: payment.amount,
  }))

  /*
   * One callout, chosen by severity — a lay-by is never two of these at once,
   * and stacking banners buries the one that matters. The "how lay-bys work"
   * explainer that used to sit here permanently now lives in the Put aside
   * card's description.
   */
  const callout = late ? (
    <Callout tone="danger" title={`Past its due date of ${layby.dueDate}.`}>
      {wouldBe.businessDaysOverdue} business days over.{' '}
      {wouldBe.noFeeReason ?? `A ${fee.pct}% cancellation fee may now be charged.`}
    </Callout>
  ) : layby.status === 'completed' && layby.invoiceDocId ? (
    <Callout
      tone="success"
      title={`Paid in full and handed over${
        layby.completedAt ? ` on ${layby.completedAt.toLocaleDateString('en-ZA')}` : ''
      }.`}
    >
      Invoiced as{' '}
      <Link href={`/sales/${layby.invoiceDocId}`} className="text-brand hover:underline">
        {layby.invoiceNumber ?? `#${layby.invoiceDocId}`}
      </Link>
      , which is when the VAT became due.
    </Callout>
  ) : layby.status === 'cancelled' || layby.status === 'expired' ? (
    <Callout
      tone="neutral"
      icon={<Icons.Ban size={18} />}
      title={`${LAYBY_STATUS_LABELS[layby.status]}${layby.cancelReason ? ` — ${layby.cancelReason}` : ''}`}
    >
      {layby.status === 'expired'
        ? 'Left too long past its due date. The money paid is still the customer’s — cancel it properly to refund them.'
        : layby.cancellationFee > 0
          ? `${formatMoney(layby.cancellationFee)} was kept as the disclosed cancellation fee.`
          : (layby.feeWaivedReason ?? 'Refunded in full.')}
    </Callout>
  ) : null

  return (
    <>
      <PageHeader
        title={layby.laybyNumber ?? `Lay-by #${layby.id}`}
        subtitle={`${layby.customerName ?? '—'} · opened ${layby.createdAt.toLocaleDateString('en-ZA')}`}
        backHref="/invoicing/laybys"
        backLabel="Lay-bys"
        action={
          <LaybyActions
            laybyId={layby.id}
            status={layby.status}
            outstanding={layby.outstanding}
            tenders={tenders.filter((t) => t.isActive && !t.postsToDebtor)}
            cancellationFee={wouldBe.fee}
            cancellationRefund={wouldBe.refund}
            noFeeReason={wouldBe.noFeeReason}
          />
        }
      />

      <PageBody>
        <StatStrip columns={4}>
          <StatTile
            label="Lay-by total"
            value={formatMoney(layby.totalIncl)}
            hint={`${layby.lines.length} item${layby.lines.length === 1 ? '' : 's'}`}
            icon={<Icons.Package size={16} />}
          />
          <StatTile
            label="Paid so far"
            value={formatMoney(layby.paidTotal)}
            hint={`${percentPaid(layby)}% of the total`}
            tone={layby.paidTotal > 0 ? 'positive' : 'default'}
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Outstanding"
            value={formatMoney(layby.outstanding)}
            hint={layby.outstanding > 0 ? 'Before the goods go out' : 'Paid up'}
            tone={layby.outstanding > 0 ? 'warning' : 'positive'}
            icon={<Icons.HandCoins size={16} />}
          />
          <StatTile
            label="Due by"
            value={layby.dueDate ?? '—'}
            hint={LAYBY_STATUS_LABELS[layby.status]}
            tone={late ? 'danger' : 'default'}
            icon={<Icons.Calendar size={16} />}
          />
        </StatStrip>

        {callout}

        <Card>
          <CardHeader
            title="Put aside"
            description={
              layby.status === 'open'
                ? 'Reserved, but still on the shelf — the goods stay the shop’s and the money stays the customer’s until it is paid in full and handed over. Nothing is invoiced and no VAT is due before then.'
                : 'Reserved, but still on the shelf until paid in full.'
            }
          />
          <LaybyItemsTable rows={itemRows} />
        </Card>

        <Card>
          <CardHeader title="Payments" description="Every instalment, and where it went." />
          <LaybyPaymentsTable rows={paymentRows} />
        </Card>
      </PageBody>
    </>
  )
}
