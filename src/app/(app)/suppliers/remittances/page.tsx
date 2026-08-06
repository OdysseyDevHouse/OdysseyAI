import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { payableSuppliers, listPaymentRuns } from '@/lib/site/paymentRuns'
import { supplierAgingSummary } from '@/lib/site/supplierLedger'
import { addDays } from '@/lib/site/interestRules'
import { today as todayIso } from '@/lib/site/ledger'
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

  // Settlement discount still on the table, and how much of it is about to
  // lapse. Unlike an overdue balance — which is still payable tomorrow — a
  // discount deadline that passes is money gone, so it gets its own callout.
  const discountAvailable = round2(
    payables.reduce((sum, s) => sum + s.discountAvailable, 0),
  )
  const soonCutoff = addDays(todayIso(), 7)
  const expiring = payables.filter(
    (s) => s.discountAvailable > 0 && (s.nextDiscountDeadline ?? '') <= soonCutoff,
  )
  const expiringSoon = round2(expiring.reduce((sum, s) => sum + s.discountAvailable, 0))

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
          {/* Discount earns this slot over "not yet due": one is money you can
              still capture this week, the other is a figure with no action
              attached. Falls back when no supplier offers a discount. */}
          {discountAvailable > 0 ? (
            <StatTile
              label="Discount available"
              value={formatMoney(discountAvailable)}
              tone="positive"
              hint={
                expiringSoon > 0
                  ? `${formatMoney(expiringSoon)} expires within 7 days`
                  : 'By paying early'
              }
              icon={<Icons.Percent size={16} />}
            />
          ) : (
            <StatTile
              label="Not yet due"
              value={formatMoney(aging.current)}
              hint="No rush"
              icon={<Icons.Clock size={16} />}
            />
          )}
          <StatTile
            label="Runs in progress"
            value={String(drafts.length)}
            tone={drafts.length > 0 ? 'warning' : 'default'}
            hint={drafts.length > 0 ? 'Prepared but not paid' : 'None waiting'}
            icon={<Icons.Wallet size={16} />}
          />
        </div>

        {aging.total !== 0 && <AgeingStrip aging={aging} />}

        {/* The one genuinely time-sensitive thing on this screen. Named
            suppliers and deadlines, because "R4 200 available" is not
            actionable but "pay Acme by Thursday" is. */}
        {expiring.length > 0 && (
          <Card>
            <CardHeader
              title={`${formatMoney(expiringSoon)} of discount expires within a week`}
              description="Paying these before their deadline earns the discount. After it, the full amount is due."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {expiring.slice(0, 8).map((s) => (
                  <li key={s.supplierId} className="flex items-center justify-between py-2">
                    <div>
                      <span className="text-sm text-ink">{s.name}</span>
                      <span className="ml-2 text-xs text-muted">
                        {s.code} · by {s.nextDiscountDeadline}
                      </span>
                    </div>
                    <span className="numeric text-sm text-success">
                      saves {formatMoney(s.discountAvailable)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <PaymentRunClient
          suppliers={payables.map((s) => ({
            supplierId: s.supplierId,
            code: s.code,
            name: s.name,
            email: s.email,
            balance: s.balance,
            overdueTotal: s.overdueTotal,
            discountAvailable: s.discountAvailable,
            nextDiscountDeadline: s.nextDiscountDeadline,
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
