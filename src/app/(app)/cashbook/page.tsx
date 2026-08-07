import { requireCapability } from '@/lib/auth'
import { listAccounts, totalCash, reconcileBankBalances } from '@/lib/site/bankAccounts'
import { unidentifiedBankReceipts } from '@/lib/site/unallocatedReceipts'
import { formatMoney } from '@/lib/decimals'
import {
  PageHeader,
  PageBody,
  ButtonLink,
  Card,
  CardHeader,
  StatTile,
  StatStrip,
  Icons,
} from '@/components/ui'
import { AccountsTable, DriftTable, UnidentifiedReceiptsTable } from './CashbookTables'

export const dynamic = 'force-dynamic'

/**
 * The cashbook — where the money actually is.
 *
 * The screen answers one question on sight: how much cash do we have, and is
 * any of it unexplained. Everything else is a route into an account.
 *
 * The loudest thing is deliberately NOT the total — it is the count of
 * unreconciled lines, because a healthy total with 300 unmatched movements
 * behind it is not a healthy total. That is also why neither header action is
 * primary: the stat tiles carry the hierarchy here.
 */

export default async function CashbookPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.view')

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
            <ButtonLink href="/cashbook/import" variant="secondary">
              <Icons.Upload size={15} />
              Import statement
            </ButtonLink>
          </div>
        }
      />

      <PageBody>
        <StatStrip>
          <StatTile
            label="Cash on hand"
            value={formatMoney(cash)}
            tone={cash < 0 ? 'danger' : 'default'}
          />
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
        </StatStrip>

        {/* A drift means a posting path wrote one side and not the other. It is
            always a bug, never rounding, so it is shown above everything. */}
        {drift.length > 0 && (
          <Card>
            <CardHeader
              title="Balances that disagree with their transactions"
              description="Each of these is a posting that moved a balance without its row, or the reverse. Investigate before trusting any figure on this page."
            />
            <DriftTable rows={drift} />
          </Card>
        )}

        <Card>
          <CardHeader
            title="Accounts"
            description="Bank, cash and card settlement accounts."
          />
          <AccountsTable rows={accounts} />
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
            <UnidentifiedReceiptsTable rows={unidentified.slice(0, 5)} />
          </Card>
        )}
      </PageBody>
    </>
  )
}
