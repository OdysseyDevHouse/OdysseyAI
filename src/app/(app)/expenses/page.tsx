import { requireCapability } from '@/lib/auth'
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
  StatTile,
  StatStrip,
  Icons,
  TableToolbar,
  SearchBar,
  LinkSegmentedControl,
} from '@/components/ui'
import { DueSchedulesCard } from './DueSchedulesCard'
import { DateRangeFilter } from './DateRangeFilter'
import { ExpensesTable, SpendByCategoryTable } from './ExpensesTables'

export const dynamic = 'force-dynamic'

/**
 * What the business spends that is not stock.
 *
 * The screen leads with the two things that need an action rather than the
 * total: drafts sitting unreviewed (which are in nobody's figures, including
 * the VAT return) and bills not yet paid. A total nobody can act on belongs
 * lower down.
 */

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; from?: string; to?: string; q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('cashbook.view')
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

  return (
    <>
      <PageHeader
        title="Expenses"
        icon={<Icons.Receipt size={18} />}
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
        <StatStrip columns={summary.capital > 0 ? 5 : 4}>
          <StatTile
            label="Total cost"
            value={formatMoney(summary.totalCost)}
            hint="Excluding VAT and capital items"
            iconTone="success"
            icon={<Icons.Coins size={20} />}
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
            icon={<Icons.Clock size={20} />}
          />
          <StatTile
            label="Bills unpaid"
            value={formatMoney(summary.unpaidTotal)}
            tone={summary.unpaidCount > 0 ? 'warning' : 'default'}
            hint={`${summary.unpaidCount} on account`}
            icon={<Icons.StatusWarning size={20} />}
          />
          <StatTile
            label="VAT claimable"
            value={formatMoney(summary.vatClaimable)}
            hint="Included in the VAT return"
            icon={<Icons.Scale size={20} />}
          />
          {summary.capital > 0 && (
            <StatTile
              label="Capital items"
              value={formatMoney(summary.capital)}
              hint="Assets — depreciated, not expensed"
              icon={<Icons.Package size={20} />}
            />
          )}
        </StatStrip>

        {/* Recurring schedules that are due. Leads because nothing else on the
            screen will produce these — they are simply missing until generated. */}
        <DueSchedulesCard
          schedules={dueSchedules.map((s) => ({
            id: s.id,
            name: s.name,
            frequencyLabel: s.frequencyLabel,
            nextDue: s.nextDue,
            totalIncl: s.totalIncl,
          }))}
        />

        <Card>
          <CardHeader title="Expenses" description="Newest first." />

          <TableToolbar inCard>
            <LinkSegmentedControl
              aria-label="Expense status"
              value={status ?? 'all'}
              options={[
                {
                  value: 'all',
                  label: 'All',
                  icon: <Icons.LayoutGrid size={15} />,
                  href: href({ status: null }),
                },
                {
                  value: 'draft',
                  label: 'Drafts',
                  count: summary.draftCount > 0 ? summary.draftCount : undefined,
                  icon: <Icons.Clock size={15} />,
                  href: href({ status: 'draft' }),
                },
                {
                  value: 'finalised',
                  label: 'Posted',
                  icon: <Icons.StatusSuccess size={15} />,
                  href: href({ status: 'finalised' }),
                },
                {
                  value: 'void',
                  label: 'Void',
                  icon: <Icons.StatusFailure size={15} />,
                  href: href({ status: 'void' }),
                },
              ]}
            />
            {/* SearchBar carries its own page gutter for screens without a
                toolbar; here the toolbar spaces it, so strip it. */}
            <div className="w-72 max-w-full [&>form]:p-0">
              <SearchBar
                action="/expenses"
                defaultValue={params.q}
                placeholder="Search payee, number or description…"
                keep={{ status: params.status, from: params.from, to: params.to }}
              />
            </div>
            <DateRangeFilter
              from={from}
              to={to}
              path="/expenses"
              keep={{ q: params.q, status: params.status }}
            />
          </TableToolbar>

          <ExpensesTable rows={list.items} searchQuery={params.q} status={status} />
        </Card>

        {byCategory.rows.length > 0 && (
          <Card>
            <CardHeader
              title="Where it went"
              description="By category, against the period before this one."
            />
            <SpendByCategoryTable rows={byCategory.rows.slice(0, 12)} />
          </Card>
        )}
      </PageBody>
    </>
  )
}
