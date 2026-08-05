import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSiteId } from '@/lib/auth'
import { getPaymentRun, listPaymentItems } from '@/lib/site/paymentRuns'
import { isConfigured } from '@/lib/mail'
import { formatMoney } from '@/lib/decimals'
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
import RunActions from './RunActions'

export const dynamic = 'force-dynamic'

const REMITTANCE_TONE = {
  none: 'neutral',
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
} as const

export default async function PaymentRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  const siteId = await requireSiteId()
  const { runId: raw } = await params

  const runId = Number(raw)
  if (!Number.isFinite(runId) || runId <= 0) notFound()

  const [run, items] = await Promise.all([getPaymentRun(siteId, runId), listPaymentItems(siteId, runId)])
  if (!run) notFound()

  const invoiceCount = items.reduce((sum, i) => sum + i.allocations.length, 0)
  const withoutEmail = items.filter((i) => !i.email).length

  return (
    <>
      <PageHeader
        title={`Payment run · ${run.paymentDate}`}
        subtitle={run.reference ? `Reference ${run.reference}` : 'No bank reference'}
        backHref="/suppliers/remittances"
        backLabel="Pay suppliers"
        action={
          <RunActions
            runId={run.id}
            status={run.status}
            mailReady={isConfigured()}
            hasItems={items.length > 0}
          />
        }
      />

      <PageBody>
        {run.status === 'draft' && (
          <Card>
            <div className="flex items-start gap-3 px-6 py-4">
              <Icons.StatusWarning size={18} className="mt-0.5 shrink-0 text-warning" />
              <div>
                <p className="font-medium text-ink">Nothing has been paid yet.</p>
                <p className="text-sm text-muted">
                  Check the allocations below, then post the run. Posting writes one payment per
                  supplier and settles exactly the invoices listed.
                </p>
              </div>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Total"
            value={formatMoney(run.totalAmount)}
            hint={run.status === 'posted' ? 'Paid' : 'To be paid'}
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Suppliers"
            value={String(items.length)}
            hint={`${invoiceCount} invoice${invoiceCount === 1 ? '' : 's'} settled`}
            icon={<Icons.Truck size={16} />}
          />
          <StatTile
            label="Remittances sent"
            value={String(items.filter((i) => i.remittanceStatus === 'sent').length)}
            hint={withoutEmail > 0 ? `${withoutEmail} with no email` : 'All reachable'}
            tone={withoutEmail > 0 ? 'warning' : 'default'}
            icon={<Icons.Mail size={16} />}
          />
          <StatTile
            label="Status"
            value={run.status}
            hint={run.postedAt?.toLocaleString('en-ZA') ?? 'Not posted'}
            tone={run.status === 'posted' ? 'positive' : run.status === 'draft' ? 'warning' : 'default'}
            icon={<Icons.Wallet size={16} />}
          />
        </div>

        {items.map((item) => (
          <Card key={item.id}>
            <CardHeader
              title={item.supplierName}
              description={
                item.email
                  ? `${item.supplierCode} · ${item.email}`
                  : `${item.supplierCode} · no email on file`
              }
              action={
                <div className="flex items-center gap-2">
                  {item.remittanceStatus !== 'none' && (
                    <span title={item.remittanceError ?? undefined}>
                      <Badge tone={REMITTANCE_TONE[item.remittanceStatus]}>
                        {item.remittanceStatus}
                      </Badge>
                    </span>
                  )}
                  {run.status === 'posted' && (
                    <Link
                      href={`/api/suppliers/${item.supplierId}/remittance?run=${run.id}`}
                      className="text-sm text-brand hover:underline"
                    >
                      Advice PDF
                    </Link>
                  )}
                  <span className="numeric font-semibold text-ink">{formatMoney(item.amount)}</span>
                </div>
              }
            />
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Invoice</th>
                    <th className={TABLE_TH}>Date</th>
                    <th className={`${TABLE_TH} text-right`}>Invoice total</th>
                    <th className={`${TABLE_TH} text-right`}>Paying</th>
                    <th className={`${TABLE_TH} text-right`}>Left after</th>
                  </tr>
                </thead>
                <tbody>
                  {item.allocations.map((allocation) => {
                    const remaining = Math.round((allocation.docAmount - allocation.amount) * 100) / 100
                    return (
                      <tr key={allocation.id} className={TABLE_ROW}>
                        <td className={TABLE_TD}>{allocation.docNumber ?? `#${allocation.txnId}`}</td>
                        <td className={TABLE_TD}>{allocation.docDate ?? '—'}</td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {formatMoney(allocation.docAmount)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                          {formatMoney(allocation.amount)}
                        </td>
                        <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                          {remaining <= 0 ? (
                            <Badge tone="success">Settled</Badge>
                          ) : (
                            <span className="text-warning">{formatMoney(remaining)}</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </PageBody>
    </>
  )
}
