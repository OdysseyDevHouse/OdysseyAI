import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { listAccounts, totalCash, reconcileBankBalances } from '@/lib/site/bankAccounts'
import { unidentifiedBankReceipts } from '@/lib/site/unallocatedReceipts'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  CardHeader,
  CardBody,
  StatTile,
  EmptyState,
  Badge,
  Icons,
  DataTable,
  type Column,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/**
 * The cashbook — where the money actually is.
 *
 * The screen answers one question on sight: how much cash do we have, and is
 * any of it unexplained. Everything else is a route into an account.
 *
 * The loudest thing is deliberately NOT the total — it is the count of
 * unreconciled lines, because a healthy total with 300 unmatched movements
 * behind it is not a healthy total.
 */

type AccountRow = Awaited<ReturnType<typeof listAccounts>>[number]

export default async function CashbookPage() {
  const siteId = await requireSiteId()

  const [accounts, cash, drift, unidentified] = await Promise.all([
    listAccounts(siteId),
    totalCash(siteId),
    reconcileBankBalances(siteId),
    unidentifiedBankReceipts(siteId, { limit: 20 }),
  ])

  const needsAttention = accounts.reduce((sum, a) => sum + (a.unreconciledCount ?? 0), 0)
  const neverReconciled = accounts.filter(
    (a) => a.accountType === 'bank' && !a.lastReconciledDate,
  ).length

  const columns: Column<AccountRow>[] = [
    {
      key: 'name',
      header: 'Account',
      cell: (a) => (
        <Link href={`/cashbook/${a.id}`} className="block hover:text-brand">
          <span className="font-medium text-ink">{a.name}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {a.code}
            {a.bankName ? ` · ${a.bankName}` : ''}
            {a.accountNumber ? ` · ${a.accountNumber}` : ''}
          </span>
        </Link>
      ),
      sortValue: (a) => a.name,
    },
    {
      key: 'type',
      header: 'Type',
      cell: (a) => <Badge tone="default">{a.accountTypeLabel}</Badge>,
      sortValue: (a) => a.accountType,
    },
    {
      key: 'reconciled',
      header: 'Last reconciled',
      cell: (a) =>
        a.accountType !== 'bank' ? (
          <span className="text-faint">—</span>
        ) : a.lastReconciledDate ? (
          <span className="text-ink-2">{a.lastReconciledDate}</span>
        ) : (
          // Never reconciled is a real state, not a blank: it means every
          // figure on this account is unverified.
          <Badge tone="warning">Never</Badge>
        ),
      sortValue: (a) => a.lastReconciledDate ?? '',
    },
    {
      key: 'unreconciled',
      header: 'Unmatched',
      cell: (a) =>
        (a.unreconciledCount ?? 0) === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <Badge tone={(a.unreconciledCount ?? 0) > 20 ? 'warning' : 'default'}>
            {a.unreconciledCount}
          </Badge>
        ),
      sortValue: (a) => a.unreconciledCount ?? 0,
    },
    {
      key: 'balance',
      header: 'Balance',
      numeric: true,
      cell: (a) => (
        <span className={a.balance < 0 ? 'text-danger' : 'text-ink'}>
          {formatMoney(a.balance)}
        </span>
      ),
      sortValue: (a) => a.balance,
    },
  ]

  return (
    <>
      <PageHeader
        title="Cashbook"
        subtitle={`${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href="/cashbook/new" variant="secondary">
              <Icons.Plus size={15} />
              New account
            </ButtonLink>
            <ButtonLink href="/cashbook/import">
              <Icons.Upload size={15} />
              Import statement
            </ButtonLink>
          </div>
        }
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Cash on hand" value={formatMoney(cash)} />
          <StatTile
            label="Unmatched lines"
            value={String(needsAttention)}
            tone={needsAttention > 0 ? 'warning' : 'default'}
            hint={needsAttention > 0 ? 'Money the ledgers do not explain' : 'Everything is matched'}
          />
          <StatTile
            label="Never reconciled"
            value={String(neverReconciled)}
            tone={neverReconciled > 0 ? 'warning' : 'default'}
            hint={neverReconciled > 0 ? 'Bank accounts with no sign-off' : 'All accounts checked'}
          />
          <StatTile
            label="Unidentified receipts"
            value={String(unidentified.length)}
            tone={unidentified.length > 0 ? 'warning' : 'default'}
            hint={unidentified.length > 0 ? 'Money in, customer unknown' : 'All receipts identified'}
          />
        </div>

        {/* A drift means a posting path wrote one side and not the other. It is
            always a bug, never rounding, so it is shown above everything. */}
        {drift.length > 0 && (
          <Card>
            <CardHeader
              title="Balances that disagree with their transactions"
              description="Each of these is a posting that moved a balance without its row, or the reverse. Investigate before trusting any figure on this page."
            />
            <CardBody>
              <ul className="space-y-2">
                {drift.map((d) => (
                  <li key={d.id} className="flex items-center justify-between text-sm">
                    <span className="text-ink">
                      {d.code} — {d.name}
                    </span>
                    <span className="numeric text-danger">
                      out by {formatMoney(d.drift)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Accounts"
            description="Bank, cash and card settlement accounts."
          />
          {accounts.length === 0 ? (
            <CardBody>
              <EmptyState
                title="No accounts yet"
                hint="Add the bank account your takings are deposited into, and the cashbook can start reconciling against a statement."
                action={
                  <ButtonLink href="/cashbook/new">
                    <Icons.Plus size={15} />
                    New account
                  </ButtonLink>
                }
              />
            </CardBody>
          ) : (
            <DataTable
              columns={columns}
              rows={accounts}
              getRowKey={(a) => a.id}
              empty={{ title: 'No accounts', hint: 'Add one to get started.' }}
            />
          )}
        </Card>

        {unidentified.length > 0 && (
          <Card>
            <CardHeader
              title="Money in, customer unknown"
              description="These receipts reached the bank but were never matched to an account — somebody's invoice still shows as unpaid."
              action={
                <ButtonLink href="/cashbook/unallocated" variant="secondary" size="sm">
                  See all
                </ButtonLink>
              }
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {unidentified.slice(0, 5).map((r) => (
                  <li key={r.bankTxnId} className="flex items-center justify-between py-2 text-sm">
                    <div className="min-w-0">
                      <span className="block truncate text-ink">
                        {r.description ?? r.reference ?? 'No description'}
                      </span>
                      <span className="text-xs text-muted">
                        {r.txnDate} · {r.bankAccountName} · held {r.daysHeld} day
                        {r.daysHeld === 1 ? '' : 's'}
                      </span>
                    </div>
                    <span className="numeric shrink-0 pl-4 text-ink">{formatMoney(r.amount)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </PageBody>
    </>
  )
}
