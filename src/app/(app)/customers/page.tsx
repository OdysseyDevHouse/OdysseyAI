import type { ReactNode } from 'react'
import { requireModuleCapability } from '@/lib/auth'
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
import { can, type Capability } from '@/lib/site/permissions'
import { compileListFilters, filterableFields } from '@/lib/site/listFilterSql'
import { rememberedFilters } from '@/lib/site/listFilterMemory'
import { decodeFilters, encodeFilters, FILTER_PARAM } from '@/lib/listFilters'
import ListFilterButton from '@/components/lists/ListFilterButton'
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
  summariseCondition,
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

/**
 * A glyph per account state. On hold and closed are deliberately different: a
 * hold is a block someone applied and can lift, a closed account is finished —
 * and the money still owed against each is chased differently.
 */
const STATUS_ICONS: Record<CustomerStatus | 'all', ReactNode> = {
  all: <Icons.LayoutGrid size={15} />,
  active: <Icons.StatusSuccess size={15} />,
  on_hold: <Icons.Ban size={15} />,
  inactive: <Icons.Clock size={15} />,
  closed: <Icons.StatusFailure size={15} />,
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
  /** The advanced filter's conditions. See FILTER_PARAM in lib/listFilters. */
  f?: string
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities, actor } = await requireModuleCapability(
    'customers',
    'customers.view',
  )
  const params = await searchParams

  /* ── the advanced filter ────────────────────────────────────────────────
   *
   * Same shape as the products list. Conditions live in the URL; the
   * REMEMBERED set applies only when the URL says nothing about filters at
   * all, so that an explicit `?f=` can clear one. See that page for the full
   * reasoning behind the `cleared` distinction. */
  const cleared = params[FILTER_PARAM] !== undefined
  const remembered = cleared
    ? null
    : await rememberedFilters(siteId, 'customers', actor.userId)

  const conditions = decodeFilters(cleared ? (params[FILTER_PARAM] ?? '') : (remembered ?? ''))

  const allow = (c: Capability) => can(capabilities, c)
  /* Every field whose SQL reads off `customers` itself. The customer group is
     the one that does not — it is a joined name, and this query has no join —
     so it is absent here and the toolbar's own group picker covers it. */
  const filterFields = filterableFields('customers', allow).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    numeric: f.numeric ?? false,
    group: f.group ?? '',
    hint: f.hint ?? '',
    options: f.options ?? [],
  }))

  const compiled = compileListFilters(
    'customers',
    conditions,
    allow,
    new Set(filterFields.map((f) => f.key)),
    // listCustomers has aliased the table `c` since long before this feature.
    'c',
  )

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
    extraWhere: compiled.where,
    extraParams: compiled.params,
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

  /* The same slice WITHOUT the advanced conditions, for the "12 of 84" in the
     subtitle. Deliberately not summary.total, which is the whole book: the
     honest comparison is against what the OTHER filters already narrowed to,
     or a status slice would make the advanced filter look like it hid far more
     than it did. Only asked for when there is something to compare, so an
     ordinary load runs exactly the queries it always did. */
  const unfilteredTotal = conditions.length
    ? (
        await listCustomers(siteId, {
          ...options,
          extraWhere: undefined,
          extraParams: undefined,
          limit: 1,
          offset: 0,
        })
      ).total
    : total

  /* This list's own address, carried out to every account it links to so the
     trip back lands HERE — same filters, same sort, same page. Only when
     something is applied, so an unfiltered book keeps its short links. */
  const listUrl = `/customers${withParams(params, {})}`
  const editSuffix = listUrl === '/customers' ? '' : `?from=${encodeURIComponent(listUrl)}`

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
        icon={<Icons.Users size={18} />}
        /* Under an advanced filter, say what is being HIDDEN as well as what
           is shown: "12 accounts" on a book of 400 reads the same whether the
           filter was typed just now or remembered from before lunch. */
        subtitle={
          `${total} account${total === 1 ? '' : 's'}` +
          (conditions.length && unfilteredTotal > total ? ` of ${unfilteredTotal}` : '')
        }
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
            icon={<Icons.Coins size={20} />}
            href={filterHref({ balance: 'owing' })}
          />
          <StatTile
            label="Over limit"
            value={String(summary.overLimit)}
            tone={summary.overLimit > 0 ? 'warning' : 'default'}
            hint={summary.overLimit > 0 ? 'Credit exceeded' : 'All within limit'}
            icon={<Icons.StatusWarning size={20} />}
            href={filterHref({ balance: 'over' })}
          />
          <StatTile
            label="On hold"
            value={String(summary.onHold)}
            tone={summary.onHold > 0 ? 'danger' : 'default'}
            hint={summary.onHold > 0 ? 'Blocked from account sales' : 'None blocked'}
            icon={<Icons.Ban size={20} />}
            href={filterHref({ status: 'on_hold' })}
          />
        </StatStrip>

        <TableToolbar
          /* Applied filters take the second row — see TableToolbar's `filters`
             note. Status has no chip: the segmented control above already
             shows the active slice and how to leave it.

             Clearing goes to an EMPTY `?f=`, not a bare /customers: an absent
             parameter means "nobody has said", which is exactly when a
             remembered filter comes back. A plain link would appear to do
             nothing. */
          filters={
            <FilterBar inToolbar clearHref={`/customers?${FILTER_PARAM}=`}>
              {groupName && (
                <FilterChip label="Group" value={groupName} clearHref={filterHref({ group: null })} />
              )}
              {repName && (
                <FilterChip label="Rep" value={repName} clearHref={filterHref({ rep: null })} />
              )}
              {category && (
                <FilterChip
                  label="Category"
                  value={category}
                  clearHref={filterHref({ category: null })}
                />
              )}
              {params.balance === 'owing' && (
                <FilterChip label="Balance" value="Owing" clearHref={filterHref({ balance: null })} />
              )}
              {params.balance === 'over' && (
                <FilterChip
                  label="Balance"
                  value="Over limit"
                  clearHref={filterHref({ balance: null })}
                />
              )}

              {/* One chip per advanced condition, spelled out in words. This is
                  what keeps a REMEMBERED filter honest: it applies without
                  anyone having typed a URL, so the screen has to say plainly
                  what it is currently showing. */}
              {conditions.map((condition, i) => (
                <FilterChip
                  key={`${condition.field}-${i}`}
                  label="Where"
                  value={summariseCondition(condition, filterFields)}
                  clearHref={filterHref({
                    [FILTER_PARAM]: encodeFilters(conditions.filter((_, j) => j !== i)),
                  })}
                />
              ))}
            </FilterBar>
          }
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
              {
                value: 'all',
                label: 'All',
                icon: STATUS_ICONS.all,
                href: filterHref({ status: null }),
              },
              ...Object.entries(STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
                icon: STATUS_ICONS[value as CustomerStatus],
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
              /* A GET form submits only its own fields, so without this a
                 search would silently drop the advanced filter. */
              [FILTER_PARAM]: params[FILTER_PARAM],
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

          {/* Everything the toolbar cannot express, behind one button. Sits
              after the built-in controls because it is the escape hatch from
              them, not a peer — and most people never open it. */}
          <ListFilterButton
            listKey="customers"
            fields={filterFields}
            value={conditions}
            remembered={!!remembered}
            builderHref="/reports/builder?source=customers"
          />
        </TableToolbar>

        <Card>
          <CustomerListClient
            rows={items}
            total={total}
            /* The whole book, not the filtered slice — see the prop's note.
               summary.total is COUNT(*) over every account, which is exactly
               the "has this shop got any customers at all" question. */
            hasAny={summary.total > 0}
            search={params.q}
            editSuffix={editSuffix}
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
