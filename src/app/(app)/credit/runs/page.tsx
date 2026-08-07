import { requireCapability } from '@/lib/auth'
import { listRuns } from '@/lib/site/creditControl'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  EmptyState,
  ButtonLink,
} from '@/components/ui'
import { RunsTable, type RunRow } from './RunsTable'

export const dynamic = 'force-dynamic'

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

  // Plain serialisable rows — the Dates on a run never cross the boundary, and
  // the table that draws them owns its own columns. See RunsTable.
  const rows: RunRow[] = runs.map((r) => ({
    id: r.id,
    asAt: r.asAt,
    status: r.status,
    sentCount: r.sentCount,
    failedCount: r.failedCount,
    skippedCount: r.skippedCount,
    totalOverdue: r.totalOverdue,
    userName: r.userName,
    sentByName: r.sentByName,
  }))

  return (
    <>
      <PageHeader
        title="Reminder runs"
        subtitle={`${rows.length} run${rows.length === 1 ? '' : 's'}`}
        action={<ButtonLink href="/credit">Collections</ButtonLink>}
      />

      <PageBody>
        <Card>
          <CardHeader
            title="Runs"
            description="Cancelled runs are kept — a proposal that was deliberately not sent is a decision worth recording."
          />
          {rows.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No reminder runs yet"
                hint="Build one from the collections screen. It is assessed and shown to you before anything is sent."
                action={<ButtonLink href="/credit">Go to collections</ButtonLink>}
              />
            </CardBody>
          ) : (
            <RunsTable rows={rows} />
          )}
        </Card>
      </PageBody>
    </>
  )
}
