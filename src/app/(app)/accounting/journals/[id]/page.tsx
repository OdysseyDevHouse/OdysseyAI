import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { getBatch } from '@/lib/site/journals'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  Badge,
  TABLE,
  TABLE_HEAD_ROW,
  TABLE_TH,
  TABLE_TD,
  TABLE_ROW,
  TABLE_NUMERIC,
  TABLE_TOTAL_ROW,
} from '@/components/ui'
import { ReverseButton } from './ReverseButton'

export const dynamic = 'force-dynamic'

/** Where a document's journal is traced back to the document itself. */
const SOURCE_LINKS: Record<string, (id: number) => string> = {
  expense: (id) => `/expenses/${id}`,
  sale: (id) => `/sales/${id}`,
  credit_note: (id) => `/sales/${id}`,
  grv: (id) => `/purchasing/${id}`,
  supplier_return: (id) => `/purchasing/${id}`,
}

export default async function JournalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const { id } = await params

  const batchId = Number(id)
  if (!Number.isFinite(batchId)) notFound()

  const batch = await getBatch(siteId, batchId)
  if (!batch) notFound()

  const sourceHref =
    batch.sourceDocId && SOURCE_LINKS[batch.source]
      ? SOURCE_LINKS[batch.source](batch.sourceDocId)
      : null

  return (
    <>
      <PageHeader
        title={batch.journalNumber ?? `Journal #${batch.id}`}
        subtitle={`${batch.journalDate} · ${batch.description}`}
        action={
          <div className="flex items-center gap-2">
            {/* Posted is the normal state, so it goes unsaid — only the
                exceptions get a badge. */}
            {batch.status !== 'posted' && <Badge tone="warning">{batch.status}</Badge>}
            {batch.source === 'manual' && <Badge tone="warning">Manual journal</Badge>}
            {batch.reversesId && <Badge tone="default">Reversal</Badge>}
            {batch.status === 'posted' && batch.source === 'manual' && (
              <ReverseButton id={batch.id} journalNumber={batch.journalNumber} />
            )}
          </div>
        }
      />

      <PageBody>
        {/* A subledger journal cannot be reversed on its own — doing so would
            leave the ledger disagreeing with the document. Saying why here
            saves someone hunting for a missing button. */}
        {batch.source !== 'manual' && (
          <Card>
            <CardBody>
              <p className="text-sm text-muted">
                This entry mirrors a {batch.source.replace('_', ' ')}
                {sourceHref ? (
                  <>
                    {' '}
                    —{' '}
                    <Link href={sourceHref} className="text-brand hover:underline">
                      open the document
                    </Link>
                  </>
                ) : null}
                . To reverse it, void the document itself: reversing only the ledger entry would
                leave the two out of step.
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Entries" />
          <div className="overflow-x-auto">
            <table className={TABLE}>
              <thead>
                <tr className={TABLE_HEAD_ROW}>
                  <th className={TABLE_TH}>Account</th>
                  <th className={TABLE_TH}>Description</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Debit</th>
                  <th className={`${TABLE_TH} ${TABLE_NUMERIC}`}>Credit</th>
                </tr>
              </thead>
              <tbody>
                {batch.lines.map((line) => (
                  <tr key={line.id} className={TABLE_ROW}>
                    <td className={TABLE_TD}>
                      <Link
                        href={`/accounting/accounts/${line.accountId}`}
                        className="text-ink hover:text-brand"
                      >
                        {line.accountName}
                      </Link>
                      <span className="ml-2 text-xs text-muted">{line.accountCode}</span>
                    </td>
                    <td className={TABLE_TD}>
                      <span className="text-muted">{line.description ?? '—'}</span>
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {line.debit === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        formatMoney(line.debit)
                      )}
                    </td>
                    <td className={`${TABLE_TD} ${TABLE_NUMERIC}`}>
                      {line.credit === 0 ? (
                        <span className="text-faint">—</span>
                      ) : (
                        formatMoney(line.credit)
                      )}
                    </td>
                  </tr>
                ))}
                <tr className={TABLE_TOTAL_ROW}>
                  <td className={`${TABLE_TD} font-semibold`} colSpan={2}>
                    Total
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    {formatMoney(batch.totalDebit)}
                  </td>
                  <td className={`${TABLE_TD} ${TABLE_NUMERIC} font-semibold`}>
                    {formatMoney(batch.totalCredit)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>

        {/* Provenance in its own card, so the entries table ends on its total. */}
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted">Posted by</dt>
                <dd className="text-ink-2">{batch.userName}</dd>
              </div>
              {batch.reference && (
                <div className="flex justify-between">
                  <dt className="text-muted">Reference</dt>
                  <dd className="text-ink-2">{batch.reference}</dd>
                </div>
              )}
              {batch.reversesId && (
                <div className="flex justify-between">
                  <dt className="text-muted">Reverses</dt>
                  <dd>
                    <Link
                      href={`/accounting/journals/${batch.reversesId}`}
                      className="text-brand hover:underline"
                    >
                      journal #{batch.reversesId}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
