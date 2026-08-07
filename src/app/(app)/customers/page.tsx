import { requireCapability } from '@/lib/auth'
import {
  listCustomers,
  customerSummary,
  toCustomerStatus,
  type CustomerListOptions,
  type CustomerStatus,
} from '@/lib/site/customers'
import { listCustomerGroups, listSalesReps, listCustomerCategories } from '@/lib/site/customerLookups'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom, withParams } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  Card,
  Input,
  StatTile,
  StatStrip,
  FilterBar,
  FilterChip,
  LinkSegmentedControl,
  TableToolbar,
  Pagination,
  Menu,
  MenuItem,
  Icons,
} from '@/components/ui'
import CustomerListClient from './CustomerListClient'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

/** The status slices offered as filters, in the order they matter. */
const STATUS_LABELS: Record<CustomerStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  inactive: 'Inactive',
  closed: 'Closed',
}

type Search = {
  q?: string
  status?: string
  group?: string
  rep?: string
  category?: string
  balance?: string
  page?: string
  sort?: string
  dir?: string
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('customers.view')
  const params = await searchParams

  const status = toCustomerStatus(params.status)
  const groupId = Number(params.group) || undefined
  const repId = Number(params.rep) || undefined
  const category = params.category?.trim() || undefined
  const page = pageFrom(params.page)

  const options: CustomerListOptions = {
    search: params.q,
    statuses: status ? [status] : undefined,
    groupId,
    repId,
    category,
    withBalanceOnly: params.balance === 'owing',
    overLimitOnly: params.balance === 'over',
    sort: params.sort === 'balance' || params.sort === 'code' ? params.sort : 'name',
    direction: params.dir === 'desc' ? 'desc' : 'asc',
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  }

  const [{ items, total }, summary, groups, reps, categories] = await Promise.all([
    listCustomers(siteId, options),
    customerSummary(siteId),
    listCustomerGroups(siteId),
    listSalesReps(siteId),
    listCustomerCategories(siteId),
  ])

  const href = hrefBuilder('/customers', params)
  // Any filter change returns to page 1: page 7 of the old result set is rarely
  // a page of the new one, and an empty list reads as "no matches".
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  const groupName = groups.find((g) => g.id === groupId)?.name
  const repName = reps.find((r) => r.id === repId)?.name

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={`${total} account${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/customers/new">
            <Icons.Plus size={15} />
            New customer
          </PrimaryLink>
        }
      />

      <PageBody>
        {/* Three tiles, not four: an "Accounts" tile would repeat the subtitle
            count. Each of these is a figure someone acts on, and each drills
            into the filtered list behind it. */}
        <StatStrip columns={3}>
          <StatTile
            label="Total owing"
            value={formatMoney(summary.totalOwed)}
            tone={summary.totalOwed > 0 ? 'warning' : 'default'}
            hint={`${summary.owing} account${summary.owing === 1 ? '' : 's'} with a balance`}
            icon={<Icons.Coins size={16} />}
            href={filterHref({ balance: 'owing' })}
          />
          <StatTile
            label="Over limit"
            value={String(summary.overLimit)}
            tone={summary.overLimit > 0 ? 'warning' : 'default'}
            hint={summary.overLimit > 0 ? 'Credit exceeded' : 'All within limit'}
            icon={<Icons.StatusWarning size={16} />}
            href={filterHref({ balance: 'over' })}
          />
          <StatTile
            label="On hold"
            value={String(summary.onHold)}
            tone={summary.onHold > 0 ? 'danger' : 'default'}
            hint={summary.onHold > 0 ? 'Blocked from account sales' : 'None blocked'}
            icon={<Icons.Ban size={16} />}
            href={filterHref({ status: 'on_hold' })}
          />
        </StatStrip>

        <TableToolbar
          actions={
            <Menu label="Export" variant="ghost">
              <MenuItem href={`/api/customers/export${withParams(params, { format: 'xlsx' })}`} download>
                <Icons.Spreadsheet size={15} />
                Excel (.xlsx)
              </MenuItem>
              <MenuItem href={`/api/customers/export${withParams(params, { format: 'csv' })}`} download>
                <Icons.FileText size={15} />
                CSV
              </MenuItem>
            </Menu>
          }
        >
          <LinkSegmentedControl
            aria-label="Filter by status"
            value={status ?? 'all'}
            options={[
              { value: 'all', label: 'All', href: filterHref({ status: null }) },
              ...Object.entries(STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
                href: filterHref({ status: value }),
              })),
            ]}
          />
          {/* A plain GET, so search stays server-rendered and linkable. The
              hidden inputs carry the other filters through the submit. */}
          <form action="/customers" className="w-72">
            {Object.entries({
              group: params.group,
              rep: params.rep,
              category: params.category,
              balance: params.balance,
              status: params.status,
            }).map(([key, value]) =>
              value ? <input key={key} type="hidden" name={key} value={value} /> : null,
            )}
            <Input
              type="search"
              name="q"
              defaultValue={params.q}
              placeholder="Search name, code, email or phone…"
              aria-label="Search customers"
              icon={<Icons.Search size={16} />}
            />
          </form>
        </TableToolbar>

        {/* Status has no chip — the segmented control above already shows the
            active slice and how to leave it. */}
        <FilterBar clearHref="/customers" className="-mx-6 -my-2">
          {groupName && (
            <FilterChip label="Group" value={groupName} clearHref={filterHref({ group: null })} />
          )}
          {repName && <FilterChip label="Rep" value={repName} clearHref={filterHref({ rep: null })} />}
          {category && (
            <FilterChip label="Category" value={category} clearHref={filterHref({ category: null })} />
          )}
          {params.balance === 'owing' && (
            <FilterChip label="Balance" value="Owing" clearHref={filterHref({ balance: null })} />
          )}
          {params.balance === 'over' && (
            <FilterChip label="Balance" value="Over limit" clearHref={filterHref({ balance: null })} />
          )}
        </FilterBar>

        <Card>
          <CustomerListClient
            rows={items}
            total={total}
            search={params.q}
            filters={{
              groups: groups.map((g) => ({ id: g.id, name: g.name })),
              reps: reps.map((r) => ({ id: r.id, name: r.name })),
              categories,
            }}
          />

          <Pagination
            page={page}
            pageCount={pageCountFor(total, PAGE_SIZE)}
            total={total}
            pageSize={PAGE_SIZE}
            hrefFor={(next) => href({ page: next === 1 ? null : next })}
          />
        </Card>
      </PageBody>
    </>
  )
}
