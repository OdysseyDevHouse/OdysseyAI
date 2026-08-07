import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { listRuns } from '@/lib/site/creditControl'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  EmptyState,
  Badge,
  DataTable,
  ButtonLink,
  type Column,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

type Run = Awaited<ReturnType<typeof listRuns>>[number]

/**
 * Every reminder run ever built, including the ones nobody sent.
 *
 * Cancelled runs are kept and shown. A proposal that was deliberately not sent
 * is evidence of a decision, and deleting it would make the register read as
 * though the question never came up.
 */
export default async function RunsPage() {
  const { siteId } = await requireCapability('customers.view')
  const runs = await listRuns(siteId, 50)

  const columns: Column<Run>[] = [
    {
      key: 'run',
      header: 'Run',
      cell: (r) => (
        <Link href={`/credit/runs/${r.id}`} className="block hover:text-brand">
          <span className="text-ink">#{r.id}</span>
          <span className="mt-0.5 block text-xs text-muted">as at {r.asAt}</span>
        </Link>
      ),
      sortValue: (r) => r.id,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (r) => (
        <Badge
          tone={
            r.status === 'completed'
              ? 'success'
              : r.status === 'draft'
                ? 'brand'
                : r.status === 'sending'
                  ? 'warning'
                  : 'default'
          }
        >
          {r.status === 'draft'
            ? 'Awaiting review'
            : r.status === 'sending'
              ? 'Sending'
              : r.status === 'completed'
                ? 'Sent'
                : 'Cancelled'}
        </Badge>
      ),
      sortValue: (r) => r.status,
    },
    {
      key: 'sent',
      header: 'Sent',
      numeric: true,
      cell: (r) => (
        <>
          <span className="text-ink">{r.status === 'draft' ? '—' : r.sentCount}</span>
          {r.failedCount > 0 && (
            <span className="mt-0.5 block text-xs text-danger">{r.failedCount} failed</span>
          )}
        </>
      ),
      sortValue: (r) => r.sentCount,
    },
    {
      key: 'skipped',
      header: 'Not chased',
      numeric: true,
      cell: (r) => <span className="text-muted">{r.skippedCount}</span>,
      sortValue: (r) => r.skippedCount,
    },
    {
      key: 'value',
      header: 'Chased',
      numeric: true,
      cell: (r) => <span className="text-ink">{formatMoney(r.totalOverdue)}</span>,
      sortValue: (r) => r.totalOverdue,
    },
    {
      key: 'who',
      header: 'Released by',
      cell: (r) => (
        <>
          <span className="text-ink-2">{r.sentByName ?? '—'}</span>
          <span className="mt-0.5 block text-xs text-muted">built by {r.userName}</span>
        </>
      ),
      sortValue: (r) => r.sentByName ?? '',
    },
  ]

  return (
    <>
      <PageHeader
        title="Reminder runs"
        subtitle={`${runs.length} run${runs.length === 1 ? '' : 's'}`}
        action={<ButtonLink href="/credit">Collections</ButtonLink>}
      />

      <PageBody>
        <Card>
          <CardHeader
            title="Runs"
            description="Cancelled runs are kept — a proposal that was deliberately not sent is a decision worth recording."
          />
          {runs.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No reminder runs yet"
                hint="Build one from the collections screen. It is assessed and shown to you before anything is sent."
                action={<ButtonLink href="/credit">Go to collections</ButtonLink>}
              />
            </CardBody>
          ) : (
            <DataTable
              columns={columns}
              rows={runs}
              getRowKey={(r) => r.id}
              empty={{ title: 'No runs', hint: '' }}
            />
          )}
        </Card>
      </PageBody>
    </>
  )
}
