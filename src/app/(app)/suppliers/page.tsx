import { requireCapability } from '@/lib/auth'
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
  PageBody,
  PrimaryLink,
  Card,
  SearchBar,
  StatStrip,
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
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId } = await requireCapability('suppliers.view')
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
        icon={<Icons.Truck size={18} />}
        subtitle={`${total} supplier${total === 1 ? '' : 's'}`}
        action={
          <PrimaryLink href="/suppliers/new">
            <Icons.Plus size={15} />
            New supplier
          </PrimaryLink>
        }
      />

      <PageBody>
        {/* Two tiles, not four: "Suppliers" restated the subtitle and "With a
            balance" restated Total owed's hint. What is left is the money and
            the exception — both drill into the filtered list. */}
        <StatStrip columns={2}>
          <StatTile
            label="Total owed"
            value={formatMoney(summary.totalOwed)}
            hint={`${summary.owed} account${summary.owed === 1 ? '' : 's'} with a balance`}
            iconTone="success"
            icon={<Icons.Coins size={20} />}
            href={filterHref({ balance: 'owed' })}
          />
          <StatTile
            label="On hold"
            value={String(summary.onHold)}
            tone={summary.onHold > 0 ? 'warning' : 'default'}
            hint={summary.onHold > 0 ? 'No new orders' : 'None blocked'}
            icon={<Icons.Ban size={20} />}
            href={filterHref({ status: 'on_hold' })}
          />
        </StatStrip>

        {/* SearchBar and FilterBar carry the page gutter themselves; unwind
            PageBody's so the controls still line up with everything else. */}
        <div className="-mx-6 -my-3">
          <SearchBar
            action="/suppliers"
            defaultValue={params.q}
            placeholder="Search name, code, email, phone or account number…"
            keep={{ status: params.status, category: params.category, balance: params.balance }}
          />
        </div>

        {/* Status is not a chip — the segmented control on the list already
            shows which slice is active and how to leave it. */}
        {(category || params.balance === 'owed') && (
          <div className="-mx-6 -mt-5">
            <FilterBar clearHref="/suppliers">
              {category && (
                <FilterChip
                  label="Category"
                  value={category}
                  clearHref={filterHref({ category: null })}
                />
              )}
              {params.balance === 'owed' && (
                <FilterChip label="Balance" value="Owed" clearHref={filterHref({ balance: null })} />
              )}
            </FilterBar>
          </div>
        )}

        <Card>
          <SupplierListClient
            rows={items}
            total={total}
            hasAny={summary.total > 0}
            searchTerm={params.q?.trim() || undefined}
            filters={{
              allHref: filterHref({ status: null }),
              statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({
                value,
                label,
                href: filterHref({ status: value }),
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
      </PageBody>
    </>
  )
}
