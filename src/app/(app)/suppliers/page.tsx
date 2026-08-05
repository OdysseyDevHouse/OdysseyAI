import { requireSiteId } from '@/lib/auth'
import {
  listSuppliers,
  supplierSummary,
  toSupplierStatus,
  type SupplierListOptions,
  type SupplierStatus,
} from '@/lib/site/suppliers'
import { listSupplierCategories } from '@/lib/site/customerLookups'
import { formatMoney } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PrimaryLink,
  Card,
  SearchBar,
  StatTile,
  FilterBar,
  FilterChip,
  Pagination,
  Icons,
} from '@/components/ui'
import SupplierListClient from './SupplierListClient'

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

const STATUS_LABELS: Record<SupplierStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  inactive: 'Inactive',
  closed: 'Closed',
}

type Search = {
  q?: string
  status?: string
  category?: string
  balance?: string
  page?: string
  sort?: string
  dir?: string
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const siteId = await requireSiteId()
  const params = await searchParams

  const status = toSupplierStatus(params.status)
  const category = params.category?.trim() || undefined
  const page = pageFrom(params.page)

  const options: SupplierListOptions = {
    search: params.q,
    statuses: status ? [status] : undefined,
    category,
    withBalanceOnly: params.balance === 'owed',
    sort:
      params.sort === 'balance' || params.sort === 'code' || params.sort === 'terms'
        ? params.sort
        : 'name',
    direction: params.dir === 'desc' ? 'desc' : 'asc',
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  }

  const [{ items, total }, summary, categories] = await Promise.all([
    listSuppliers(siteId, options),
    supplierSummary(siteId),
    listSupplierCategories(siteId),
  ])

  const href = hrefBuilder('/suppliers', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  return (
    <>
      <PageHeader
        title="Suppliers"
        subtitle={`${total} supplier${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/suppliers/new">
            <Icons.Plus size={15} />
            New supplier
          </PrimaryLink>
        }
      />

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 lg:grid-cols-4">
        <StatTile
          label="Total owed"
          value={formatMoney(summary.totalOwed)}
          hint={`${summary.owed} account${summary.owed === 1 ? '' : 's'} with a balance`}
          icon={<Icons.Coins size={16} />}
        />
        <StatTile
          label="On hold"
          value={String(summary.onHold)}
          tone={summary.onHold > 0 ? 'warning' : 'default'}
          hint={summary.onHold > 0 ? 'No new orders' : 'None blocked'}
          icon={<Icons.Ban size={16} />}
          href={filterHref({ status: 'on_hold' })}
        />
        <StatTile
          label="Suppliers"
          value={String(summary.total)}
          hint="Excluding closed"
          icon={<Icons.Truck size={16} />}
        />
        <StatTile
          label="With a balance"
          value={String(summary.owed)}
          hint="Awaiting payment"
          icon={<Icons.Wallet size={16} />}
          href={filterHref({ balance: 'owed' })}
        />
      </div>

      <SearchBar
        action="/suppliers"
        defaultValue={params.q}
        placeholder="Search name, code, email, phone or account number…"
        keep={{ status: params.status, category: params.category, balance: params.balance }}
      />

      <FilterBar clearHref="/suppliers">
        {status && (
          <FilterChip
            label="Status"
            value={STATUS_LABELS[status]}
            clearHref={filterHref({ status: null })}
          />
        )}
        {category && (
          <FilterChip label="Category" value={category} clearHref={filterHref({ category: null })} />
        )}
        {params.balance === 'owed' && (
          <FilterChip label="Balance" value="Owed" clearHref={filterHref({ balance: null })} />
        )}
      </FilterBar>

      <div className="px-6 pb-6">
        <Card>
          <SupplierListClient
            rows={items}
            total={total}
            filters={{
              statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
                href: filterHref({ status: status === value ? null : value }),
                active: status === value,
              })),
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
      </div>
    </>
  )
}
