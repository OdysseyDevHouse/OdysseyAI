import { requireCapability } from '@/lib/auth'
import { listAccounts } from '@/lib/site/chartOfAccounts'
import { CONTROL_SOURCE_HINTS } from '@/lib/glModel'
import { hrefBuilder } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  CardBody,
  TableToolbar,
  LinkSegmentedControl,
  SearchBar,
  Icons,
} from '@/components/ui'
import { AccountsClient } from './AccountsClient'
import { AccountsTable, type AccountRow } from './AccountsTable'

export const dynamic = 'force-dynamic'

/**
 * The five account types, each with a glyph.
 *
 * These name a TAXONOMY, not a state — an expense account is not "worse" than
 * an income one — so the icons describe what each type holds rather than
 * borrowing the tick/cross pair that means status elsewhere in the app.
 */
const TYPES = [
  { type: 'asset', label: 'Assets', icon: <Icons.Package size={15} /> },
  { type: 'liability', label: 'Liabilities', icon: <Icons.Scale size={15} /> },
  { type: 'equity', label: 'Equity', icon: <Icons.Wallet size={15} /> },
  { type: 'income', label: 'Income', icon: <Icons.Coins size={15} /> },
  { type: 'expense', label: 'Expenses', icon: <Icons.Receipt size={15} /> },
] as const

/**
 * The chart of accounts.
 *
 * One sortable table rather than five stacked cards: the account codes are
 * banded by type (1000s assets, 2000s liabilities, …), so the default code
 * order already reads the way an accountant expects, and a single table can be
 * searched and sorted — which five separate ones never could.
 */
export default async function ChartOfAccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('reports.financial')
  const params = await searchParams

  const accounts = await listAccounts(siteId, { includeInactive: true })
  const href = hrefBuilder('/accounting/accounts', params)

  const type = TYPES.some((t) => t.type === params.type) ? params.type! : 'all'
  const q = (params.q ?? '').trim().toLowerCase()

  // Plain serializable rows — DataTable's columns are functions, so they live
  // in the client component and only data crosses the boundary.
  const rows: AccountRow[] = accounts
    .filter((a) => type === 'all' || a.accountType === type)
    .filter(
      (a) =>
        q === '' ||
        a.name.toLowerCase().includes(q) ||
        a.accountCode.toLowerCase().includes(q),
    )
    .map((a) => ({
      id: a.id,
      accountCode: a.accountCode,
      name: a.name,
      isActive: a.isActive,
      controlHint: a.controlType ? CONTROL_SOURCE_HINTS[a.controlType] : null,
      subtypeLabel: a.subtypeLabel,
      balance: a.balance,
      displayBalance: a.displayBalance,
    }))

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        icon={<Icons.Scale size={18} />}
        subtitle={`${accounts.filter((a) => a.isActive).length} active accounts`}
        action={<AccountsClient accounts={accounts} />}
      />

      <PageBody>
        <TableToolbar>
          <LinkSegmentedControl
            aria-label="Account type"
            value={type}
            options={[
              {
                value: 'all',
                label: 'All',
                icon: <Icons.LayoutGrid size={15} />,
                href: href({ type: null }),
                count: accounts.length,
              },
              ...TYPES.map((t) => ({
                value: t.type as string,
                label: t.label,
                icon: t.icon,
                href: href({ type: t.type }),
                count: accounts.filter((a) => a.accountType === t.type).length,
              })),
            ]}
          />
        </TableToolbar>

        <Card>
          <SearchBar
            action="/accounting/accounts"
            defaultValue={params.q}
            placeholder="Search by code or name..."
            keep={{ type: params.type }}
          />
          <AccountsTable
            rows={rows}
            empty={
              q
                ? {
                    title: `Nothing matches "${params.q}"`,
                    hint: 'Try a different code or name, or clear the search.',
                  }
                : {
                    title: 'No accounts here',
                    hint: 'Add an account, or pick a different type above.',
                  }
            }
          />
        </Card>

        <Card>
          <CardBody>
            <p className="text-sm text-muted">
              Balances are shown the way each type reads: a liability of 12 000 appears as 12 000,
              not as a negative. Control accounts are maintained by their subledgers and cannot be
              journalled to directly — posting to one by hand would put the ledger and the detail
              behind it permanently out of step.
            </p>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
