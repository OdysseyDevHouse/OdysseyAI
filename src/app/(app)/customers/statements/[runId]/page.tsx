import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getRun, listItems, refreshCounts } from '@/lib/site/statementRuns'
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
import RunProgress from './RunProgress'

export const dynamic = 'force-dynamic'

const ITEM_TONE = {
  queued: 'neutral',
  sent: 'success',
  failed: 'danger',
  skipped: 'warning',
} as const

export default async function StatementRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.view')
  const { runId: raw } = await params

  const runId = Number(raw)
  if (!Number.isFinite(runId) || runId <= 0) notFound()

  // Recompute from the items before reading: the worker updates items as it
  // goes, and the header should not lag behind what the rows say.
  await refreshCounts(siteId, runId)

  const [run, items] = await Promise.all([getRun(siteId, runId), listItems(siteId, runId)])
  if (!run) notFound()

  const inFlight = run.status === 'pending' || run.status === 'running'
  const done = run.sentCount + run.failedCount + run.skippedCount

  return (
    <>
      <PageHeader
        title="Statement run"
        subtitle={`${run.periodFrom} to ${run.periodTo} · ${run.format === 'activity' ? 'full activity' : 'open items'}`}
        backHref="/customers/statements"
        backLabel="Statements"
        action={<RunProgress runId={run.id} status={run.status} failedCount={run.failedCount} />}
      />

      <PageBody>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Sent"
            value={String(run.sentCount)}
            tone={run.sentCount > 0 ? 'positive' : 'default'}
            hint={`of ${run.totalCount}`}
            icon={<Icons.Send size={16} />}
          />
          <StatTile
            label="Failed"
            value={String(run.failedCount)}
            tone={run.failedCount > 0 ? 'danger' : 'default'}
            hint={run.failedCount > 0 ? 'Retryable' : 'None'}
            icon={<Icons.StatusError size={16} />}
          />
          <StatTile
            label="Skipped"
            value={String(run.skippedCount)}
            tone={run.skippedCount > 0 ? 'warning' : 'default'}
            hint="No email, or nothing owed"
            icon={<Icons.Ban size={16} />}
          />
          <StatTile
            label="Progress"
            value={run.totalCount === 0 ? '—' : `${Math.round((done / run.totalCount) * 100)}%`}
            hint={inFlight ? 'Still sending…' : (run.finishedAt?.toLocaleString('en-ZA') ?? '')}
            icon={<Icons.Clock size={16} />}
          />
        </div>

        {run.error && (
          <Card>
            <div className="px-6 py-4">
              <p className="flex items-center gap-2 text-sm text-danger">
                <Icons.StatusError size={15} />
                {run.error}
              </p>
            </div>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Every account"
            description="What happened to each one, and why — kept so a failure can be chased."
          />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Account</th>
                  <th className={TABLE_TH}>Sent to</th>
                  <th className={`${TABLE_TH} text-right`}>Balance</th>
                  <th className={`${TABLE_TH} text-right`}>Overdue</th>
                  <th className={TABLE_TH}>When</th>
                  <th className={TABLE_TH}>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <Link
                        href={`/customers/${item.customerId}`}
                        className="text-brand hover:underline"
                      >
                        {item.customerCode}
                      </Link>
                      <div className="text-ink">{item.customerName}</div>
                    </td>
                    <td className={TABLE_TD}>
                      {item.email ?? <span className="text-faint">—</span>}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {formatMoney(item.closingBalance)}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {item.overdueAmount > 0 ? (
                        <span className="text-danger">{formatMoney(item.overdueAmount)}</span>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className={TABLE_TD}>
                      {item.sentAt?.toLocaleString('en-ZA') ?? '—'}
                    </td>
                    <td className={TABLE_TD}>
                      <span title={item.error ?? undefined}>
                        <Badge tone={ITEM_TONE[item.status]}>{item.status}</Badge>
                      </span>
                      {item.error && (
                        <div className="mt-0.5 max-w-xs truncate text-xs text-muted">
                          {item.error}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </PageBody>
    </>
  )
}
