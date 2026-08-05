import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { listRuns } from '@/lib/site/statementRuns'
import { statementCandidates } from '@/lib/statements/render'
import { isConfigured } from '@/lib/mail'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  Badge,
  Icons,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
} from '@/components/ui'
import StatementRunClient from './StatementRunClient'

export const dynamic = 'force-dynamic'

const STATUS_TONE = {
  pending: 'neutral',
  running: 'brand',
  completed: 'success',
  failed: 'danger',
} as const

export default async function StatementsPage() {
  const siteId = await requireSiteId()

  const [runs, candidates] = await Promise.all([
    listRuns(siteId),
    statementCandidates(siteId),
  ])

  const mailReady = isConfigured()
  const withEmail = candidates.filter((c) => c.email)
  const owing = candidates.filter((c) => c.balance !== 0)

  return (
    <>
      <PageHeader
        title="Statements"
        subtitle={`${owing.length} account${owing.length === 1 ? '' : 's'} with a balance`}
      />
      <PageBody>
        {!mailReady && (
          <Card>
            <CardBody>
              <p className="flex items-start gap-2 text-sm text-warning">
                <Icons.StatusWarning size={16} className="mt-0.5 shrink-0" />
                <span>
                  Email is not set up, so a run would fail immediately. Set{' '}
                  <code className="rounded bg-surface-2 px-1 text-xs">SMTP_HOST</code> and{' '}
                  <code className="rounded bg-surface-2 px-1 text-xs">MAIL_FROM</code> in the
                  environment. Statements can still be previewed and downloaded one at a time from
                  each account.
                </span>
              </p>
            </CardBody>
          </Card>
        )}

        <StatementRunClient
          candidates={candidates.map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            email: c.email,
            balance: c.balance,
          }))}
          mailReady={mailReady}
        />

        <Card>
          <CardHeader
            title="Recent runs"
            description="Every account's outcome is kept, so a failure can be chased or retried."
          />
          {runs.length === 0 ? (
            <CardBody>
              <p className="text-sm text-muted">
                No runs yet. {withEmail.length} of {candidates.length} accounts have an email
                address on file.
              </p>
            </CardBody>
          ) : (
            <div className="overflow-x-auto">
              <table className={TABLE}>
                <thead>
                  <tr className={TABLE_HEAD_ROW}>
                    <th className={TABLE_TH}>Period</th>
                    <th className={TABLE_TH}>Started</th>
                    <th className={TABLE_TH}>By</th>
                    <th className={`${TABLE_TH} text-right`}>Sent</th>
                    <th className={`${TABLE_TH} text-right`}>Failed</th>
                    <th className={`${TABLE_TH} text-right`}>Skipped</th>
                    <th className={TABLE_TH}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className={TABLE_ROW}>
                      <td className={TABLE_TD}>
                        <Link
                          href={`/customers/statements/${run.id}`}
                          className="text-brand hover:underline"
                        >
                          {run.periodFrom} to {run.periodTo}
                        </Link>
                        <div className="text-xs text-muted">
                          {run.format === 'activity' ? 'Full activity' : 'Open items'}
                        </div>
                      </td>
                      <td className={TABLE_TD}>
                        {run.startedAt?.toLocaleString('en-ZA') ?? '—'}
                      </td>
                      <td className={TABLE_TD}>{run.userName || '—'}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>{run.sentCount}</td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {run.failedCount > 0 ? (
                          <Badge tone="danger">{run.failedCount}</Badge>
                        ) : (
                          <span className="text-faint">0</span>
                        )}
                      </td>
                      <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                        {run.skippedCount || <span className="text-faint">0</span>}
                      </td>
                      <td className={TABLE_TD}>
                        <span title={run.error ?? undefined}>
                          <Badge tone={STATUS_TONE[run.status]}>{run.status}</Badge>
                        </span>
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
