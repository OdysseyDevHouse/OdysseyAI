import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getLayby, LAYBY_STATUS_LABELS, cancellationFeePct } from '@/lib/site/laybys'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import { getSettings } from '@/lib/site/settings'
import { cancellationOutcome, percentPaid } from '@/lib/laybyRules'
import { formatMoney, formatQty } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  StatTile,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import LaybyActions from './LaybyActions'

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

  return (
    <>
      <PageHeader
        title={layby.laybyNumber ?? `Lay-by #${layby.id}`}
        subtitle={`${layby.customerName ?? '—'} · opened ${layby.createdAt.toLocaleDateString('en-ZA')}`}
        backHref="/sales/laybys"
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
        {layby.status === 'open' && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Info size={18} className="mt-0.5 shrink-0 text-muted" />
              <div className="text-sm">
                <p className="font-medium text-ink">
                  The goods are still the shop&apos;s, and the money is still the customer&apos;s.
                </p>
                <p className="text-muted">
                  Nothing is invoiced and no VAT is due until the lay-by is paid in full and the
                  goods are handed over. What has been paid so far is refundable.
                </p>
              </div>
            </div>
          </Card>
        )}

        {late && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-danger" />
              <div className="text-sm">
                <p className="font-medium text-ink">
                  Past its due date of {layby.dueDate}.
                </p>
                <p className="text-muted">
                  {wouldBe.businessDaysOverdue} business days over.{' '}
                  {wouldBe.noFeeReason ?? `A ${fee.pct}% cancellation fee may now be charged.`}
                </p>
              </div>
            </div>
          </Card>
        )}

        {layby.status === 'completed' && layby.invoiceDocId && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Check size={18} className="mt-0.5 shrink-0 text-success" />
              <div className="text-sm">
                <p className="font-medium text-ink">
                  Paid in full and handed over
                  {layby.completedAt ? ` on ${layby.completedAt.toLocaleDateString('en-ZA')}` : ''}.
                </p>
                <p className="text-muted">
                  Invoiced as{' '}
                  <Link href={`/sales/${layby.invoiceDocId}`} className="text-brand hover:underline">
                    {layby.invoiceNumber ?? `#${layby.invoiceDocId}`}
                  </Link>
                  , which is when the VAT became due.
                </p>
              </div>
            </div>
          </Card>
        )}

        {(layby.status === 'cancelled' || layby.status === 'expired') && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.Ban size={18} className="mt-0.5 shrink-0 text-muted" />
              <div className="text-sm">
                <p className="font-medium text-ink">
                  {LAYBY_STATUS_LABELS[layby.status]}
                  {layby.cancelReason ? ` — ${layby.cancelReason}` : ''}
                </p>
                <p className="text-muted">
                  {layby.status === 'expired'
                    ? 'Left too long past its due date. The money paid is still the customer’s — cancel it properly to refund them.'
                    : layby.cancellationFee > 0
                      ? `${formatMoney(layby.cancellationFee)} was kept as the disclosed cancellation fee.`
                      : (layby.feeWaivedReason ?? 'Refunded in full.')}
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
        </div>

        <Card>
          <CardHeader title="Put aside" description="Reserved, but still on the shelf until paid in full." />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Item</th>
                  <th className={`${TABLE_TH} text-right`}>Qty</th>
                  <th className={`${TABLE_TH} text-right`}>Price</th>
                  <th className={`${TABLE_TH} text-right`}>Total</th>
                </tr>
              </thead>
              <tbody>
                {layby.lines.map((line) => (
                  <tr key={line.id} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <div className="text-ink">{line.description}</div>
                      {line.productCode && (
                        <div className="text-xs text-muted">{line.productCode}</div>
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{formatQty(line.qty)}</td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {formatMoney(line.unitPriceIncl)}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                      {formatMoney(line.lineTotalIncl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <CardHeader
            title="Payments"
            description="Every instalment, and where it went."
          />
          {layby.payments.length === 0 ? (
            <div className="px-6 py-4">
              <p className="text-sm text-muted">Nothing paid yet.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Date</th>
                    <th className={TABLE_TH}>Kind</th>
                    <th className={TABLE_TH}>Tender</th>
                    <th className={TABLE_TH}>Taken by</th>
                    <th className={`${TABLE_TH} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {layby.payments.map((payment) => (
                    <tr key={payment.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>{payment.paidOn}</td>
                      <td className={TABLE_TD}>
                        <Badge
                          tone={
                            payment.kind === 'forfeit'
                              ? 'danger'
                              : payment.kind === 'refund'
                                ? 'neutral'
                                : 'success'
                          }
                        >
                          {payment.kind}
                        </Badge>
                      </td>
                      <td className={TABLE_TD}>{payment.tenderName || '—'}</td>
                      <td className={TABLE_TD}>{payment.userName || '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        <span className={payment.amount < 0 ? 'text-muted' : 'text-ink'}>
                          {formatMoney(payment.amount)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </PageBody>
    </>
  )
}
