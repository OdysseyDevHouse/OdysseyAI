import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { getAccount, listAccounts } from '@/lib/site/bankAccounts'
import { listTransactions, listReconciliations, previewReconciliation } from '@/lib/site/cashbook'
import { listCategories } from '@/lib/site/expenseCategories'
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
  StatStrip,
  Badge,
  EmptyState,
  Icons,
} from '@/components/ui'
import { ReconcileClient } from './ReconcileClient'
import { MovementsTable } from './MovementsTable'

export const dynamic = 'force-dynamic'

/**
 * One account: what it holds, what is still unexplained, and the tools to fix
 * that.
 *
 * The unmatched list is the working surface and gets the room. The history
 * below it is reference — present, but deliberately quieter, because nobody
 * opens this screen to read last month's reconciled deposits. The one primary
 * action on this screen is signing off the statement, inside the reconcile
 * card — so the header actions stay secondary.
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

  const [unmatched, recent, reconciliations, imports, preview, expenseCategories, allAccounts] =
    await Promise.all([
      listTransactions(siteId, accountId, { status: 'unreconciled', unmatchedOnly: true, limit: 200 }),
      listTransactions(siteId, accountId, { limit: 100 }),
      listReconciliations(siteId, accountId, 10),
      listImportBatches(siteId, accountId, 5),
      previewReconciliation(siteId, accountId, today(), account.balance),
      listCategories(siteId),
      listAccounts(siteId),
    ])

  /*
   * Where the other side of a capture can post — the gl_mappings coordinates
   * the mirror resolves. Expense categories carry their id as the ref; the
   * fixed entries are the movements a shop actually captures here: charges go
   * through their category, the rest are the 130 seeds.
   */
  const categories = [
    ...expenseCategories.map((c) => ({
      key: 'expense_category',
      refId: c.id,
      label: `${c.name} (expense)`,
    })),
    { key: 'interest_received', refId: null, label: 'Interest received' },
    { key: 'other_income', refId: null, label: 'Other income' },
    { key: 'owner_drawings', refId: null, label: 'Owner drawings' },
    { key: 'capital_introduced', refId: null, label: 'Capital introduced' },
  ]

  const otherAccounts = allAccounts
    .filter((a) => a.id !== accountId)
    .map((a) => ({ id: a.id, name: a.name }))

  const unmatchedTotal = unmatched.reduce((sum, t) => sum + (t.unlinkedAmount ?? 0), 0)

  // listTransactions returns oldest first, which is the order the running
  // balance reads in — keep the most recent 30 of that window, newest last.
  const movements = recent.slice(-30)

  const importAction = (
    <ButtonLink href={`/cashbook/import?account=${accountId}`} variant="secondary" size="sm">
      <Icons.Upload size={15} />
      Import a statement
    </ButtonLink>
  )

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
            <ButtonLink href={`/cashbook/import?account=${accountId}`} variant="secondary">
              <Icons.Upload size={15} />
              Import statement
            </ButtonLink>
          </div>
        }
      />

      <PageBody>
        <StatStrip>
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
        </StatStrip>

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
            categoryKey: t.categoryKey,
          }))}
          initialUnreconciledTotal={preview.unreconciledTotal}
          categories={categories}
          otherAccounts={otherAccounts}
        />

        <Card>
          <CardHeader
            title="Recent movements"
            description="Every line on this account, newest last, with the running balance."
          />
          <MovementsTable rows={movements} accountId={accountId} />
          {recent.length > 30 && (
            <p className="border-t border-border px-4 py-2 text-xs text-muted">
              Showing the last 30 movements.
            </p>
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Reconciliation history" description="Signed-off statements." />
            <CardBody>
              {reconciliations.length === 0 ? (
                <EmptyState
                  title="This account has never been reconciled"
                  hint="Import a statement, match what it contains, then sign it off."
                  action={importAction}
                />
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
                <EmptyState
                  title="No statements imported yet"
                  hint="Importing one matches receipts automatically."
                  action={importAction}
                />
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
