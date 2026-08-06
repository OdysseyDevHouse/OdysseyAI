import Link from 'next/link'
import { requireSiteId } from '@/lib/auth'
import { listExpenses } from '@/lib/site/expenses'
import { expenseSummary, spendByCategory } from '@/lib/site/expenseReports'
import { listRecurring } from '@/lib/site/recurringExpenses'
import { formatMoney } from '@/lib/decimals'
import { today } from '@/lib/site/ledger'
import { addDays } from '@/lib/site/interestRules'
import { hrefBuilder } from '@/lib/searchParams'
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
  LinkTabs,
  DataTable,
  type Column,
} from '@/components/ui'
import { GenerateButton } from './GenerateButton'

export const dynamic = 'force-dynamic'

/**
 * What the business spends that is not stock.
 *
 * The screen leads with the two things that need an action rather than the
 * total: drafts sitting unreviewed (which are in nobody's figures, including
 * the VAT return) and bills not yet paid. A total nobody can act on belongs
 * lower down.
 */

type ExpenseRow = Awaited<ReturnType<typeof listExpenses>>['items'][number]

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; from?: string; to?: string; q?: string }>
}) {
  const siteId = await requireSiteId()
  const params = await searchParams

  const to = /^\d{4}-\d{2}-\d{2}$/.test(params.to ?? '') ? params.to! : today()
  const from = /^\d{4}-\d{2}-\d{2}$/.test(params.from ?? '') ? params.from! : addDays(to, -90)
  const status =
    params.status === 'draft' || params.status === 'void' || params.status === 'finalised'
      ? params.status
      : undefined

  const [list, summary, byCategory, schedules] = await Promise.all([
    listExpenses(siteId, { from, to, status, search: params.q, limit: 200 }),
    expenseSummary(siteId, { from, to }),
    spendByCategory(siteId, { from, to }),
    listRecurring(siteId),
  ])

  const href = hrefBuilder('/expenses', params)
  const dueSchedules = schedules.filter((s) => s.due)

  const columns: Column<ExpenseRow>[] = [
    {
      key: 'date',
      header: 'Date',
      cell: (e) => (
        <Link href={`/expenses/${e.id}`} className="block hover:text-brand">
          <span className="text-ink">{e.expenseDate}</span>
          <span className="mt-0.5 block text-xs text-muted">
            {e.documentNumber ?? 'Draft'}
          </span>
        </Link>
      ),
      sortValue: (e) => e.expenseDate,
    },
    {
      key: 'payee',
      header: 'Paid to',
      cell: (e) => (
        <>
          <span className="text-ink">{e.supplierName ?? 'Not stated'}</span>
          {e.description && (
            <span className="mt-0.5 block truncate text-xs text-muted">{e.description}</span>
          )}
        </>
      ),
      sortValue: (e) => e.supplierName ?? '',
    },
    {
      key: 'type',
      header: 'Type',
      cell: (e) =>
        e.paymentType === 'on_account' ? (
          <Badge tone="warning">Bill</Badge>
        ) : (
          <Badge tone="default">Paid</Badge>
        ),
      sortValue: (e) => e.paymentType,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (e) =>
        e.status === 'draft' ? (
          <Badge tone="warning">Draft</Badge>
        ) : e.status === 'void' ? (
          <Badge tone="default">Void</Badge>
        ) : (
          <Badge tone="success">Posted</Badge>
        ),
      sortValue: (e) => e.status,
    },
    {
      key: 'vat',
      header: 'VAT',
      numeric: true,
      cell: (e) =>
        e.vatTotal === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <span className={e.vatClaimable === 0 ? 'text-muted' : 'text-ink-2'}>
            {formatMoney(e.vatTotal)}
            {e.vatClaimable === 0 && <span className="ml-1 text-xs">(not claimable)</span>}
          </span>
        ),
      sortValue: (e) => e.vatTotal,
    },
    {
      key: 'total',
      header: 'Total',
      numeric: true,
      cell: (e) => (
        <span className={e.status === 'void' ? 'text-faint line-through' : 'text-ink'}>
          {formatMoney(e.totalIncl)}
        </span>
      ),
      sortValue: (e) => e.totalIncl,
    },
  ]

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle={`${from} to ${to}`}
        action={
          <div className="flex items-center gap-2">
            <ButtonLink href="/expenses/recurring" variant="secondary">
              <Icons.Clock size={15} />
              Recurring
            </ButtonLink>
            <ButtonLink href="/expenses/new">
              <Icons.Plus size={15} />
              Capture expense
            </ButtonLink>
          </div>
        }
      />

      <PageBody>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Total cost"
            value={formatMoney(summary.totalCost)}
            hint="Excluding VAT and capital items"
          />
          <StatTile
            label="Awaiting review"
            value={String(summary.draftCount)}
            tone={summary.draftCount > 0 ? 'warning' : 'default'}
            hint={
              summary.draftCount > 0
                ? `${formatMoney(summary.draftTotal)} not in any figures yet`
                : 'Everything is posted'
            }
          />
          <StatTile
            label="Bills unpaid"
            value={formatMoney(summary.unpaidTotal)}
            tone={summary.unpaidCount > 0 ? 'warning' : 'default'}
            hint={`${summary.unpaidCount} on account`}
          />
          <StatTile
            label="VAT claimable"
            value={formatMoney(summary.vatClaimable)}
            hint="Included in the VAT return"
          />
        </div>

        {/* Recurring schedules that are due. Leads because nothing else on the
            screen will produce these — they are simply missing until generated. */}
        {dueSchedules.length > 0 && (
          <Card>
            <CardHeader
              title={`${dueSchedules.length} recurring expense${dueSchedules.length === 1 ? '' : 's'} due`}
              description="These have not been raised yet. Generating creates drafts to review — nothing is posted."
              action={<GenerateButton />}
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {dueSchedules.map((s) => (
                  <li key={s.id} className="flex items-center justify-between py-2 text-sm">
                    <div>
                      <span className="text-ink">{s.name}</span>
                      <span className="ml-2 text-xs text-muted">
                        {s.frequencyLabel.toLowerCase()} · due {s.nextDue}
                      </span>
                    </div>
                    <span className="numeric text-ink-2">{formatMoney(s.totalIncl)}</span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        )}

        {summary.capital > 0 && (
          <Card>
            <CardHeader
              title="Capital items in this period"
              description="Assets rather than costs — kept out of the expense total above, and depreciated instead."
            />
            <CardBody>
              <p className="numeric text-lg font-semibold text-ink">
                {formatMoney(summary.capital)}
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Expenses" description="Newest first." />

          <LinkTabs
            items={[
              { value: 'all', label: 'All', href: href({ status: null }) },
              { value: 'draft', label: `Drafts${summary.draftCount ? ` (${summary.draftCount})` : ''}`, href: href({ status: 'draft' }) },
              { value: 'finalised', label: 'Posted', href: href({ status: 'finalised' }) },
              { value: 'void', label: 'Void', href: href({ status: 'void' }) },
            ]}
            value={status ?? 'all'}
            aria-label="Expense status"
          />

          {list.items.length === 0 ? (
            <CardBody>
              <EmptyState
                title={
                  params.q
                    ? `Nothing matches "${params.q}"`
                    : status === 'draft'
                      ? 'No drafts waiting'
                      : 'No expenses in this period'
                }
                hint={
                  params.q
                    ? 'Try a different search, or widen the date range.'
                    : 'Rent, fuel, insurance, subscriptions — everything the business spends that is not stock goes here.'
                }
                action={
                  !params.q ? (
                    <ButtonLink href="/expenses/new">
                      <Icons.Plus size={15} />
                      Capture the first one
                    </ButtonLink>
                  ) : undefined
                }
              />
            </CardBody>
          ) : (
            <DataTable
              columns={columns}
              rows={list.items}
              getRowKey={(e) => e.id}
              empty={{ title: 'No expenses', hint: 'Nothing in this period.' }}
            />
          )}
        </Card>

        {byCategory.rows.length > 0 && (
          <Card>
            <CardHeader
              title="Where it went"
              description="By category, against the period before this one."
            />
            <CardBody>
              <ul className="divide-y divide-border">
                {byCategory.rows.slice(0, 12).map((r) => (
                  <li key={r.categoryId} className="flex items-center justify-between py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <span className="text-ink">{r.name}</span>
                      <span className="ml-2 text-xs text-muted">
                        {r.accountCode} · {r.count} expense{r.count === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-4">
                      {/* Change against the prior period is what makes a figure
                          worth reading. Only flagged when it is material. */}
                      {r.changePct !== null && Math.abs(r.changePct) >= 20 && (
                        <Badge tone={r.changePct > 0 ? 'warning' : 'success'}>
                          {r.changePct > 0 ? '+' : ''}
                          {r.changePct}%
                        </Badge>
                      )}
                      {r.changePct === null && r.total > 0 && <Badge tone="brand">New</Badge>}
                      <span className="w-12 text-right text-xs text-muted">{r.sharePct}%</span>
                      <span className="numeric w-28 text-right text-ink">
                        {formatMoney(r.total)}
                      </span>
                    </div>
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
