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
  StatStrip,
  StatTile,
} from '@/components/ui'
import { WriteOffActions } from './WriteOffActions'
import {
  PostedWriteOffsTable,
  CategoryTable,
  CandidatesTable,
  type PostedWriteOffRow,
  type CategoryRow,
  type CandidateRow,
} from './WriteOffTables'

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

  // Plain serializable rows — DataTable's columns and actions are functions,
  // so they live in the client components and only data crosses the boundary.
  const postedRows: PostedWriteOffRow[] = posted.map((w) => ({
    id: w.id,
    customerId: w.customerId,
    customerName: w.customerName,
    userName: w.userName,
    approvedBy: w.approvedBy,
    writeOffDate: w.writeOffDate,
    categoryLabel: w.categoryLabel,
    reason: w.reason,
    recovered: Boolean(w.recoveredAt),
    amount: w.amount,
  }))

  const categoryRows: CategoryRow[] = summary.rows.map((r) => ({
    category: r.category,
    categoryLabel: r.categoryLabel,
    count: r.count,
    total: r.total,
  }))

  const candidateRows: CandidateRow[] = candidates.map((c) => ({
    customerId: c.customerId,
    name: c.name,
    code: c.code,
    daysSinceActivity: c.daysSinceActivity,
    oldestDue: c.oldestDue,
    balance: c.balance,
  }))

  return (
    <>
      <PageHeader
        title="Write-offs"
        subtitle="Debt written off, and what is waiting for approval"
      />

      <PageBody>
        {/* One tile carries a tone — the queue somebody is waiting on. */}
        <StatStrip>
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
            hint="Paid after being written off"
          />
          <StatTile
            label="Possible candidates"
            value={String(candidates.length)}
            hint="No activity for 180 days"
          />
        </StatStrip>

        {pending.length > 0 && (
          <Card>
            <CardHeader
              title="Waiting for approval"
              description="These are above the approval threshold. No balance has moved."
            />
            <CardBody>
              {/* Kept as a list, not a table: the request's reason needs room
                  to wrap next to the approve/reject pair, and there are rarely
                  more than a handful pending. */}
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
                      <span className="mt-1 line-clamp-2 block text-sm text-ink-2">{w.reason}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="numeric text-sm font-medium text-ink">
                        {formatMoney(w.amount)}
                      </span>
                      <WriteOffActions id={w.id} mode="approve" customerName={w.customerName} />
                    </div>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Written off" description="Posted, with the reason kept." />
          <PostedWriteOffsTable rows={postedRows} />
        </Card>

        {summary.rows.length > 0 && (
          <Card>
            <CardHeader
              title="By category, last 12 months"
              description="The figure a provision is built from."
            />
            <CategoryTable rows={categoryRows} />
          </Card>
        )}

        {candidates.length > 0 && (
          <Card>
            <CardHeader
              title="Worth a look"
              description="Accounts with a balance and no activity for six months. A suggestion, not a recommendation — a customer on a long project looks identical to one who has gone under."
            />
            <CandidatesTable rows={candidateRows} />
          </Card>
        )}
      </PageBody>
    </>
  )
}
