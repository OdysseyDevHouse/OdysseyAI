import { notFound } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { getRun, listItems, refreshCounts, itemPeriod } from '@/lib/site/statementRuns'
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
import RunProgress from './RunProgress'
import RunItemsTable from './RunItemsTable'

export const dynamic = 'force-dynamic'

export default async function StatementRunPage({
  params,
}: {
  params: Promise<{ runId: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('customers', 'customers.view')
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
  const pct = run.totalCount === 0 ? null : Math.round((done / run.totalCount) * 100)

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
        <StatStrip columns={4}>
          <StatTile
            label="Sent"
            value={String(run.sentCount)}
            tone={run.sentCount > 0 ? 'success' : 'default'}
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
            value={pct === null ? '—' : `${pct}%`}
            // Warning while in flight, success only once everything is done —
            // the tile answers "can I close this screen yet".
            tone={pct === 100 && !inFlight ? 'success' : inFlight ? 'warning' : 'default'}
            hint={inFlight ? 'Still sending…' : (run.finishedAt?.toLocaleString('en-ZA') ?? '')}
            icon={<Icons.Clock size={16} />}
          />
        </StatStrip>

        {run.error && (
          <Callout tone="danger" title="The run stopped">
            {run.error}
          </Callout>
        )}

        <Card>
          <CardHeader
            title="Every account"
            description="What happened to each one, and why — kept so a failure can be chased."
          />
          <RunItemsTable
            items={items.map((item) => ({
              id: item.id,
              customerId: item.customerId,
              code: item.customerCode,
              name: item.customerName,
              email: item.email,
              period: formatPeriod(itemPeriod(run, item)),
              balance: item.closingBalance,
              overdue: item.overdueAmount,
              when: item.sentAt?.toLocaleString('en-ZA') ?? null,
              whenSort: item.sentAt?.getTime() ?? 0,
              status: item.status,
              error: item.error,
            }))}
          />
        </Card>
      </PageBody>
    </>
  )
}

/** '1–31 Aug 2026' when one month, otherwise both dates. Kept short — it is a column. */
function formatPeriod({ from, to }: { from: string; to: string }): string {
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${Number(from.slice(8))}–${Number(to.slice(8))} ${MONTHS[Number(to.slice(5, 7)) - 1]} ${to.slice(0, 4)}`
    : `${from} → ${to}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
