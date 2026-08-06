import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireCapability } from '@/lib/auth'
import { getAccount } from '@/lib/site/bankAccounts'
import { listTransactions, listReconciliations, previewReconciliation } from '@/lib/site/cashbook'
import { listImportBatches } from '@/lib/site/bankImport'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  Badge,
  Icons,
} from '@/components/ui'
import { ReconcileClient } from './ReconcileClient'

export const dynamic = 'force-dynamic'

/**
 * One account: what it holds, what is still unexplained, and the tools to fix
 * that.
 *
 * The unmatched list is the working surface and gets the room. The history
 * below it is reference — present, but deliberately quieter, because nobody
 * opens this screen to read last month's reconciled deposits.
 */
export default async function BankAccountPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.view')
  const { id } = await params
  const accountId = Number(id)
  if (!Number.isFinite(accountId)) notFound()

  const account = await getAccount(siteId, accountId)
  if (!account) notFound()

  const [unmatched, recent, reconciliations, imports, preview] = await Promise.all([
    listTransactions(siteId, accountId, { status: 'unreconciled', unmatchedOnly: true, limit: 200 }),
    listTransactions(siteId, accountId, { limit: 100 }),
    listReconciliations(siteId, accountId, 10),
    listImportBatches(siteId, accountId, 5),
    previewReconciliation(siteId, accountId, today(), account.balance),
  ])

  const unmatchedTotal = unmatched.reduce((sum, t) => sum + (t.unlinkedAmount ?? 0), 0)

  return (
    <>
      <PageHeader
        title={account.name}
        subtitle={`${account.code} · ${account.accountTypeLabel}${account.bankName ? ` · ${account.bankName}` : ''}`}
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href={`/cashbook/${accountId}/edit`} variant="secondary">
              <Icons.Settings size={15} />
              Settings
            </ButtonLink>
            <ButtonLink href={`/cashbook/import?account=${accountId}`}>
              <Icons.Upload size={15} />
              Import statement
            </ButtonLink>
          </div>
        }
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Balance"
            value={formatMoney(account.balance)}
            tone={account.balance < 0 ? 'danger' : 'default'}
          />
          <StatTile
            label="Unmatched"
            value={String(unmatched.length)}
            tone={unmatched.length > 0 ? 'warning' : 'positive'}
            hint={
              unmatched.length > 0
                ? `${formatMoney(Math.abs(unmatchedTotal))} unexplained`
                : 'Everything is matched'
            }
          />
          <StatTile
            label="Last reconciled"
            value={account.lastReconciledDate ?? 'Never'}
            tone={account.lastReconciledDate ? 'default' : 'warning'}
            hint={
              account.lastReconciledBalance !== null
                ? `Statement said ${formatMoney(account.lastReconciledBalance)}`
                : 'No sign-off on record'
            }
          />
          <StatTile
            label="Opening balance"
            value={formatMoney(account.openingBalance)}
            hint={account.openingDate ?? 'No date set'}
          />
        </div>

        {/* The working surface: match, capture, reconcile. */}
        <ReconcileClient
          accountId={accountId}
          accountName={account.name}
          bookBalance={account.balance}
          unmatched={unmatched.map((t) => ({
            id: t.id,
            txnDate: t.txnDate,
            amountSigned: t.amountSigned,
            unlinkedAmount: t.unlinkedAmount ?? 0,
            description: t.description,
            reference: t.reference,
            source: t.source,
          }))}
          initialUnreconciledTotal={preview.unreconciledTotal}
        />

        <Card>
          <CardHeader
            title="Recent movements"
            description="Every line on this account, newest last, with the running balance."
          />
          <CardBody>
            {recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted">
                Nothing has moved through this account yet.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {[...recent].reverse().slice(0, 30).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <span
                        className={`block truncate ${t.status === 'void' ? 'text-faint line-through' : 'text-ink'}`}
                      >
                        {t.description ?? t.reference ?? 'No description'}
                      </span>
                      <span className="text-xs text-muted">
                        {t.txnDate}
                        {t.reference ? ` · ${t.reference}` : ''}
                        {t.source !== 'manual' ? ` · ${t.source}` : ''}
                      </span>
                    </div>
                    {t.status === 'reconciled' && (
                      <Badge tone="success">Reconciled</Badge>
                    )}
                    {t.status === 'void' && <Badge tone="default">Void</Badge>}
                    <span
                      className={`numeric w-32 shrink-0 text-right ${
                        t.status === 'void'
                          ? 'text-faint'
                          : t.amountSigned < 0
                            ? 'text-danger'
                            : 'text-success'
                      }`}
                    >
                      {formatMoney(t.amountSigned)}
                    </span>
                    <span className="numeric w-32 shrink-0 text-right text-muted">
                      {formatMoney(t.runningBalance ?? 0)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Reconciliation history" description="Signed-off statements." />
            <CardBody>
              {reconciliations.length === 0 ? (
                <p className="py-4 text-sm text-muted">
                  This account has never been reconciled. Import a statement, match what it
                  contains, then sign it off.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {reconciliations.map((r) => (
                    <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                      <div>
                        <span className="text-ink">{r.statementDate}</span>
                        <span className="ml-2 text-xs text-muted">by {r.userName}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {r.difference !== 0 && (
                          <Badge tone="danger">
                            {formatMoney(Math.abs(r.difference))} out
                          </Badge>
                        )}
                        {r.status === 'draft' && <Badge tone="warning">Reopened</Badge>}
                        <span className="numeric text-ink-2">
                          {formatMoney(r.statementBalance)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Statement imports" description="Files read into this account." />
            <CardBody>
              {imports.length === 0 ? (
                <p className="py-4 text-sm text-muted">
                  No statements imported yet.{' '}
                  <Link href={`/cashbook/import?account=${accountId}`} className="text-brand hover:underline">
                    Import one
                  </Link>{' '}
                  to match receipts automatically.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {imports.map((b) => (
                    <li key={b.id} className="py-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="truncate text-ink">{b.filename ?? 'Statement'}</span>
                        <span className="text-xs text-muted">
                          {b.periodFrom} → {b.periodTo}
                        </span>
                      </div>
                      <span className="text-xs text-muted">
                        {b.importedCount} imported
                        {b.duplicateCount > 0 ? `, ${b.duplicateCount} already present` : ''}
                        {b.autoMatchedCount > 0 ? `, ${b.autoMatchedCount} auto-matched` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>
      </PageBody>
    </>
  )
}
