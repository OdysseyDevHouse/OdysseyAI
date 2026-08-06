import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listWriteOffs, writeOffSummary, writeOffCandidates } from '@/lib/site/writeOffs'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { addDays } from '@/lib/site/interestRules'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Badge,
} from '@/components/ui'
import { WriteOffActions } from './WriteOffActions'

export const dynamic = 'force-dynamic'

/**
 * Bad debt written off.
 *
 * Mechanically these are journals the sub-ledger could always post. What it
 * could not do is answer "how much did we write off last year, who approved it,
 * and why" — which is what an auditor asks and what a provision is built from.
 *
 * Pending approvals lead, because nothing has moved on those yet and someone is
 * waiting.
 */
export default async function WriteOffsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.credit')

  const yearAgo = addDays(today(), -365)

  const [pending, posted, summary, candidates] = await Promise.all([
    listWriteOffs(siteId, { status: 'pending' }),
    listWriteOffs(siteId, { status: 'posted', limit: 100 }),
    writeOffSummary(siteId, { from: yearAgo, to: today() }),
    writeOffCandidates(siteId, { minDaysSinceActivity: 180, minAmount: 50, limit: 25 }),
  ])

  return (
    <>
      <PageHeader
        title="Write-offs"
        subtitle="Debt written off, and what is waiting for approval"
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Awaiting approval"
            value={String(pending.length)}
            tone={pending.length > 0 ? 'warning' : 'default'}
            hint={pending.length > 0 ? 'Nothing has moved yet' : 'Nothing waiting'}
          />
          <StatTile
            label="Written off (12 months)"
            value={formatMoney(summary.total)}
            hint={`Across ${summary.rows.length} categor${summary.rows.length === 1 ? 'y' : 'ies'}`}
          />
          <StatTile
            label="Recovered"
            value={formatMoney(summary.recovered)}
            tone={summary.recovered > 0 ? 'positive' : 'default'}
            hint="Paid after being written off"
          />
          <StatTile
            label="Possible candidates"
            value={String(candidates.length)}
            hint="No activity for 180 days"
          />
        </div>

        {pending.length > 0 && (
          <Card>
            <CardHeader
              title="Waiting for approval"
              description="These are above the approval threshold. No balance has moved."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {pending.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-4 py-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/customers/${w.customerId}`}
                        className="text-sm text-ink hover:text-brand"
                      >
                        {w.customerName}
                      </Link>
                      <span className="mt-0.5 block text-xs text-muted">
                        {w.customerCode} · {w.categoryLabel} · requested by {w.userName} on{' '}
                        {w.writeOffDate}
                      </span>
                      <span className="mt-1 block text-sm text-ink-2">{w.reason}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="numeric text-sm font-medium text-ink">
                        {formatMoney(w.amount)}
                      </span>
                      <WriteOffActions id={w.id} mode="approve" />
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Written off" description="Posted, with the reason kept." />
          {posted.length === 0 ? (
            <CardBody>
              <EmptyState
                title="Nothing has been written off"
                hint="When a debt becomes uncollectable, write it off from the customer's account so the reason and the approval are on record."
              />
            </CardBody>
          ) : (
            <CardBody>
              <ul className="divide-y divide-border">
                {posted.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/customers/${w.customerId}`}
                        className="text-sm text-ink hover:text-brand"
                      >
                        {w.customerName}
                      </Link>
                      <span className="mt-0.5 block text-xs text-muted">
                        {w.writeOffDate} · {w.categoryLabel} · {w.userName}
                        {w.approvedBy && w.approvedBy !== w.userName
                          ? `, approved by ${w.approvedBy}`
                          : w.approvedBy
                            ? ', self-approved'
                            : ''}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{w.reason}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      {w.recoveredAt && <Badge tone="success">Recovered</Badge>}
                      <span className="numeric text-sm text-ink">{formatMoney(w.amount)}</span>
                      {!w.recoveredAt && <WriteOffActions id={w.id} mode="recover" />}
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>

        {summary.rows.length > 0 && (
          <Card>
            <CardHeader
              title="By category, last 12 months"
              description="The figure a provision is built from."
            />
            <CardBody>
              <ul className="space-y-2">
                {summary.rows.map((r) => (
                  <li key={r.category} className="flex items-center justify-between text-sm">
                    <span className="text-ink-2">
                      {r.categoryLabel}
                      <span className="ml-2 text-xs text-muted">
                        {r.count} write-off{r.count === 1 ? '' : 's'}
                      </span>
                    </span>
                    <span className="numeric text-ink">{formatMoney(r.total)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {candidates.length > 0 && (
          <Card>
            <CardHeader
              title="Worth a look"
              description="Accounts with a balance and no activity for six months. A suggestion, not a recommendation — a customer on a long project looks identical to one who has gone under."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {candidates.map((c) => (
                  <li key={c.customerId} className="flex items-center justify-between py-2">
                    <div>
                      <Link
                        href={`/customers/${c.customerId}`}
                        className="text-sm text-ink hover:text-brand"
                      >
                        {c.name}
                      </Link>
                      <span className="ml-2 text-xs text-muted">
                        {c.code} · nothing for {c.daysSinceActivity} days
                        {c.oldestDue ? ` · oldest due ${c.oldestDue}` : ''}
                      </span>
                    </div>
                    <span className="numeric text-sm text-ink">{formatMoney(c.balance)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
