import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { payableSuppliers, listPaymentRuns } from '@/lib/site/paymentRuns'
import { supplierAgingSummary } from '@/lib/site/supplierLedger'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
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
import { AgeingStrip } from '@/components/ledger/AgeingStrip'
import PaymentRunClient from './PaymentRunClient'

export const dynamic = 'force-dynamic'

const STATUS_TONE = {
  draft: 'warning',
  posted: 'success',
  cancelled: 'neutral',
} as const

export default async function RemittancesPage() {
  const siteId = await requireSiteId()

  const [payables, runs, aging] = await Promise.all([
    payableSuppliers(siteId),
    listPaymentRuns(siteId),
    supplierAgingSummary(siteId),
  ])

  const overdue = round2(aging.d30 + aging.d60 + aging.d90 + aging.d120)
  const drafts = runs.filter((r) => r.status === 'draft')

  return (
    <>
      <PageHeader
        title="Pay suppliers"
        subtitle={`${payables.length} account${payables.length === 1 ? '' : 's'} with something outstanding`}
      />
      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Total owed"
            value={formatMoney(aging.total)}
            icon={<Icons.Coins size={16} />}
          />
          <StatTile
            label="Overdue"
            value={formatMoney(overdue)}
            tone={overdue > 0 ? 'warning' : 'default'}
            hint={overdue > 0 ? 'Past their terms' : 'All within terms'}
            icon={<Icons.StatusWarning size={16} />}
            href="/suppliers/age-analysis"
          />
          <StatTile
            label="Not yet due"
            value={formatMoney(aging.current)}
            hint="No rush"
            icon={<Icons.Clock size={16} />}
          />
          <StatTile
            label="Runs in progress"
            value={String(drafts.length)}
            tone={drafts.length > 0 ? 'warning' : 'default'}
            hint={drafts.length > 0 ? 'Prepared but not paid' : 'None waiting'}
            icon={<Icons.Wallet size={16} />}
          />
        </div>

        {aging.total !== 0 && <AgeingStrip aging={aging} />}

        <PaymentRunClient
          suppliers={payables.map((s) => ({
            supplierId: s.supplierId,
            code: s.code,
            name: s.name,
            email: s.email,
            balance: s.balance,
            overdueTotal: s.overdueTotal,
            invoices: s.invoices,
          }))}
        />

        <Card>
          <CardHeader
            title="Recent runs"
            description="A run sits as a draft until it is posted — money only moves when you say so."
          />
          {runs.length === 0 ? (
            <CardBody>
              <p className="text-sm text-muted">
                No runs yet. Choose what to pay above and prepare one.
              </p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Payment date</th>
                    <th className={TABLE_TH}>Reference</th>
                    <th className={TABLE_TH}>Prepared by</th>
                    <th className={`${TABLE_TH} text-right`}>Suppliers</th>
                    <th className={`${TABLE_TH} text-right`}>Total</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link
                          href={`/suppliers/remittances/${run.id}`}
                          className="text-brand hover:underline"
                        >
                          {run.paymentDate}
                        </Link>
                      </td>
                      <td className={TABLE_TD}>{run.reference ?? '—'}</td>
                      <td className={TABLE_TD}>{run.userName || '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{run.supplierCount}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC} text-ink`}>
                        {formatMoney(run.totalAmount)}
                      </td>
                      <td className={TABLE_TD}>
                        <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
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

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
