import { requireCapability } from '@/lib/auth'
import { listRuns } from '@/lib/site/statementRuns'
import { statementCandidates } from '@/lib/statements/render'
import { isConfigured } from '@/lib/mail'
import { Card, CardHeader, Callout } from '@/components/ui'
import StatementRunClient from './StatementRunClient'
import RecentRunsTable from './RecentRunsTable'

export const dynamic = 'force-dynamic'

export default async function StatementsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.view')

  const [runs, candidates] = await Promise.all([
    listRuns(siteId),
    statementCandidates(siteId),
  ])

  const mailReady = isConfigured()
  const withEmail = candidates.filter((c) => c.email)
  const owing = candidates.filter((c) => c.balance !== 0)

  // The client component owns the header: Send is the page's one primary and
  // it reads the selection, which only a client component can.
  return (
    <StatementRunClient
      candidates={candidates.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        email: c.email,
        balance: c.balance,
        cycle: c.cycle,
      }))}
      mailReady={mailReady}
      subtitle={`${owing.length} account${owing.length === 1 ? '' : 's'} with a balance`}
      notice={
        !mailReady ? (
          <Callout tone="warning" title="Email is not set up">
            A run would fail immediately — set{' '}
            <code className="rounded bg-surface-2 px-1 text-xs">SMTP_HOST</code> and{' '}
            <code className="rounded bg-surface-2 px-1 text-xs">MAIL_FROM</code> in the
            environment. Statements can still be previewed and downloaded one at a time from each
            account.
          </Callout>
        ) : undefined
      }
    >
      <Card>
        <CardHeader
          title="Recent runs"
          description="Every account's outcome is kept, so a failure can be chased or retried."
        />
        <RecentRunsTable
          runs={runs.map((run) => ({
            id: run.id,
            period: `${run.periodFrom} to ${run.periodTo}`,
            formatLabel: run.format === 'activity' ? 'Full activity' : 'Open items',
            started: run.startedAt?.toLocaleString('en-ZA') ?? null,
            startedSort: run.startedAt?.getTime() ?? 0,
            by: run.userName,
            sent: run.sentCount,
            failed: run.failedCount,
            skipped: run.skippedCount,
            status: run.status,
            error: run.error,
          }))}
          emptyHint={`Pick accounts in the card above and send — ${withEmail.length} of ${candidates.length} accounts have an email address on file.`}
        />
      </Card>
    </StatementRunClient>
  )
}
