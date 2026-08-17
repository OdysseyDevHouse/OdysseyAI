import { requireModuleCapability } from '@/lib/auth'
import { trialBalance, ledgerHealth } from '@/lib/site/financialStatements'
import { reconcileControlAccounts, reconcileAccountBalances } from '@/lib/site/chartOfAccounts'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  CardBody,
  CardFooter,
  StatTile,
  MiniStat,
} from '@/components/ui'
import { AsAtForm } from '../balance-sheet/AsAtForm'
import {
  TrialBalanceTable,
  ControlDriftTable,
  type TrialBalanceRow,
  type ControlDriftRow,
} from './TrialBalanceTables'

export const dynamic = 'force-dynamic'

/**
 * The trial balance — the proof the ledger is sound.
 *
 * Every account with a balance, debits against credits. It is the first thing
 * an accountant asks for and the thing you check before trusting either
 * statement: a profit and loss built on an unbalanced ledger is confidently
 * wrong, which is worse than obviously wrong.
 *
 * So the health checks lead. If any of them fails, the numbers below cannot be
 * relied on and the screen says so rather than presenting them as fact.
 */
export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<{ asAt?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireModuleCapability('accounting', 'reports.financial')
  const params = await searchParams

  const asAt = /^\d{4}-\d{2}-\d{2}$/.test(params.asAt ?? '') ? params.asAt! : today()

  const [tb, health, controls, drift] = await Promise.all([
    trialBalance(siteId, asAt),
    ledgerHealth(siteId),
    reconcileControlAccounts(siteId),
    reconcileAccountBalances(siteId),
  ])

  const healthy = tb.balanced && health.unbalancedBatches.length === 0 && drift.length === 0

  // Plain serializable rows — DataTable's columns are functions, so they live
  // in the client components and only data crosses the boundary.
  const tbRows: TrialBalanceRow[] = tb.rows.map((row) => ({
    accountId: row.accountId,
    accountCode: row.accountCode,
    name: row.name,
    accountType: row.accountType,
    debit: row.debit,
    credit: row.credit,
  }))

  const controlRows: ControlDriftRow[] = controls.map((c) => ({
    accountCode: c.accountCode,
    name: c.name,
    glBalance: c.glBalance,
    subledgerBalance: c.subledgerBalance,
    drift: c.drift,
  }))

  return (
    <>
      <PageHeader
        title="Trial balance"
        subtitle={`As at ${asAt}`}
        action={<AsAtForm asAt={asAt} path="/accounting/trial-balance" />}
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Total debits" value={formatMoney(tb.totalDebit)} />
          <StatTile label="Total credits" value={formatMoney(tb.totalCredit)} />
          <StatTile
            label={tb.balanced ? 'In balance' : 'Out of balance'}
            value={tb.balanced ? 'Balanced' : formatMoney(Math.abs(tb.difference))}
            tone={tb.balanced ? 'success' : 'danger'}
            hint={tb.balanced ? 'Debits equal credits' : 'An unbalanced entry got in'}
          />
          <StatTile
            label="Accounts with a balance"
            value={String(tb.rows.length)}
            hint="Zero balances omitted"
          />
        </div>

        {/* Health leads. A trial balance that does not balance means every
            statement built on it is wrong, and saying so is more useful than
            showing the figures as though they were sound. */}
        {!healthy && (
          <Card>
            <CardHeader
              title="The ledger needs attention"
              description="Until these are resolved, the profit and loss and the balance sheet cannot be relied on."
            />
            <CardBody>
              <ul className="space-y-2">
                {!tb.balanced && (
                  <li className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink">
                    Debits and credits differ by {formatMoney(Math.abs(tb.difference))}. An
                    unbalanced entry reached the ledger.
                  </li>
                )}
                {health.unbalancedBatches.map((b) => (
                  <li
                    key={b.id}
                    className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                  >
                    Journal {b.journalNumber ?? `#${b.id}`} does not balance — out by{' '}
                    {formatMoney(Math.abs(b.difference))}.
                  </li>
                ))}
                {drift.map((d) => (
                  <li
                    key={d.id}
                    className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-ink"
                  >
                    {d.accountCode} {d.name}: the stored balance is out by{' '}
                    {formatMoney(d.drift)} against its own entries.
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {/* Control drift is a different, softer problem: the ledger is
            internally consistent but disagrees with a subledger. */}
        {controls.length > 0 && (
          <Card>
            <CardHeader
              title="Control accounts differ from their subledgers"
              description="The ledger balances, but these accounts disagree with the detail behind them. On a site where the ledger was switched on after trading began, that is expected for historical figures."
            />
            <ControlDriftTable rows={controlRows} />
          </Card>
        )}

        <Card>
          <CardHeader title="Trial balance" description="Every account carrying a balance." />
          <TrialBalanceTable rows={tbRows} />
          {tb.rows.length > 0 && (
            /* Sorting reorders the rows, so the totals live in a strip below
               the table rather than as a row that would sort with them. */
            <CardFooter>
              <MiniStat label="Total debits" value={formatMoney(tb.totalDebit)} />
              <MiniStat label="Total credits" value={formatMoney(tb.totalCredit)} />
            </CardFooter>
          )}
        </Card>
      </PageBody>
    </>
  )
}
