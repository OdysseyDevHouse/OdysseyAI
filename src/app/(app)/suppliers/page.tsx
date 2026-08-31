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
  SearchBar,
  StatStrip,
  StatTile,
  FilterBar,
  FilterChip,
  summariseCondition,
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
  /** The advanced filter's conditions. See FILTER_PARAM in lib/listFilters. */
  f?: string
}

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities, actor } = await requireCapability('suppliers.view')
  const params = await searchParams

  /* ── the advanced filter ────────────────────────────────────────────────
   *
   * Same shape as the products and customers lists. Conditions live in the
   * URL; the REMEMBERED set applies only when the URL says nothing about
   * filters at all, so an explicit `?f=` can clear one. */
  const cleared = params[FILTER_PARAM] !== undefined
  const remembered = cleared
    ? null
    : await rememberedFilters(siteId, 'suppliers', actor.userId)

  const conditions = decodeFilters(cleared ? (params[FILTER_PARAM] ?? '') : (remembered ?? ''))

  const allow = (c: Capability) => can(capabilities, c)
  /* The suppliers source joins nothing at all, so every field it offers reads
     off the table this query already has — the whole catalogue is filterable. */
  const filterFields = filterableFields('suppliers', allow).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    numeric: f.numeric ?? false,
    group: f.group ?? '',
    hint: f.hint ?? '',
    options: f.options ?? [],
  }))

  const compiled = compileListFilters(
    'suppliers',
    conditions,
    allow,
    new Set(filterFields.map((f) => f.key)),
    // listSuppliers has aliased the table `s` since long before this feature.
    's',
  )

  const status = toSupplierStatus(params.status)
  const category = params.category?.trim() || undefined
  const page = pageFrom(params.page)

  const options: SupplierListOptions = {
    search: params.q,
    statuses: status ? [status] : undefined,
    category,
    withBalanceOnly: params.balance === 'owed',
    extraWhere: compiled.where,
    extraParams: compiled.params,
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

  /* The same slice WITHOUT the advanced conditions, for the "6 of 40" in the
     subtitle — compared against what the OTHER filters already narrowed to,
     not the whole file. Only asked for when there is something to compare. */
  const unfilteredTotal = conditions.length
    ? (
        await listSuppliers(siteId, {
          ...options,
          extraWhere: undefined,
          extraParams: undefined,
          limit: 1,
          offset: 0,
        })
      ).total
    : total

  /* This list's own address, carried out to every supplier it links to so the
     trip back lands HERE. Only when something is applied, so an unfiltered
     file keeps its short, shareable links. */
  const listUrl = `/suppliers${withParams(params, {})}`
  const editSuffix = listUrl === '/suppliers' ? '' : `?from=${encodeURIComponent(listUrl)}`

  const href = hrefBuilder('/suppliers', params)
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  return (
    <>
      <PageHeader
        title="Suppliers"
        icon={<Icons.Truck size={18} />}
        /* Under an advanced filter, say what is being hidden as well as what
           is shown — see the products list for why this matters most when the
           filter was remembered rather than just typed. */
        subtitle={
          `${total} supplier${total === 1 ? '' : 's'}` +
          (conditions.length && unfilteredTotal > total ? ` of ${unfilteredTotal}` : '')
        }
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
        <div className="-mx-6 -my-3 flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <SearchBar
              action="/suppliers"
              defaultValue={params.q}
              placeholder="Search name, code, email, phone or account number…"
              /* A GET form submits only its own fields, so `f` has to be kept
                 here or searching would silently drop the advanced filter. */
              keep={{
                status: params.status,
                category: params.category,
                balance: params.balance,
                [FILTER_PARAM]: params[FILTER_PARAM],
              }}
            />
          </div>

          {/* Everything the toolbar cannot express, behind one button. */}
          <div className="pr-6">
            <ListFilterButton
              listKey="suppliers"
              fields={filterFields}
              value={conditions}
              remembered={!!remembered}
              builderHref="/reports/builder?source=suppliers"
            />
          </div>
        </div>

        {/* Status is not a chip — the segmented control on the list already
            shows which slice is active and how to leave it. */}
        {(category || params.balance === 'owed' || conditions.length > 0) && (
          <div className="-mx-6 -mt-5">
            {/* Clearing goes to an EMPTY `?f=`, not a bare /suppliers: an
                absent parameter means "nobody has said", which is when a
                remembered filter comes back. */}
            <FilterBar clearHref={`/suppliers?${FILTER_PARAM}=`}>
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

              {/* One chip per advanced condition, spelled out — the only thing
                  that explains a remembered filter nobody just typed. */}
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
          </div>
        )}

        <Card>
          <SupplierListClient
            rows={items}
            total={total}
            hasAny={summary.total > 0}
            searchTerm={params.q?.trim() || undefined}
            editSuffix={editSuffix}
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
