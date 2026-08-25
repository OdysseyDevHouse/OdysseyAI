import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listProductsForPricing } from '@/lib/site/bulkPricing'
import { listPriceStructures, listVatRates } from '@/lib/site/lookups'
import { listSuppliers } from '@/lib/site/suppliers'
import { getSetting } from '@/lib/site/settings'
import { toEndingDirection } from '@/lib/repricing'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  Card,
  ButtonLink,
  SearchBar,
  FilterChip,
  Pagination,
  TableToolbar,
  LinkSelect,
  EmptyState,
  Icons,
} from '@/components/ui'
import BulkPricingGrid from './BulkPricingGrid'

export const dynamic = 'force-dynamic'

/** Rows per page — the same fifty the product list settled on. */
const PAGE_SIZE = 50

/**
 * Bulk edit pricing — a page of products with their selling price, editable.
 *
 * The manual counterpart to Setup → Pricing's bulk reprice. That one fills a
 * whole price type from a RULE ("cost plus 40%, ending .99"); this is somebody
 * walking down a department adjusting individual prices by eye. Both write
 * through writePriceRows, so both land in the same price history.
 *
 * One price type at a time, chosen at the top. A column per type would be
 * unreadable at five types and impossible at ten, and the cost/markup/GP
 * figures beside each price only mean anything against ONE price.
 */
export default async function BulkPricingPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    department?: string
    supplier?: string
    structure?: string
    archived?: string
    page?: string
  }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('products.edit')
  const showCost = can(capabilities, 'products.cost')
  const params = await searchParams
  const { q, department, archived } = params

  const [departments, structures, vatRates, suppliers, endingDirection] =
    await Promise.all([
    listDepartments(siteId, true),
    listPriceStructures(siteId),
    listVatRates(siteId),
    /* Through listSuppliers rather than a join in the product query: the
       creditors book may be shared from another site's database. Closed
       suppliers are dropped — you do not reprice a range you no longer buy. */
    listSuppliers(siteId, {
      statuses: ['active', 'on_hold', 'inactive'],
      sort: 'name',
      limit: 500,
    }),
    getSetting(siteId, 'price_ending_direction'),
  ])

  /* No active price type means nothing can be edited here. Setup owns that,
     so say so and point there rather than rendering an empty grid. */
  if (structures.length === 0) {
    return (
      <>
        <PageHeader title="Bulk edit pricing" subtitle="Change selling prices across the catalogue" />
        <PageBody>
          <Card>
            <EmptyState
              icon={<Icons.Tag size={28} />}
              title="No price types yet"
              hint="Prices are held per price type — Retail, Wholesale, and any others you sell at. Add one before editing prices in bulk."
              action={<ButtonLink href="/setup/pricing">Go to price setup</ButtonLink>}
            />
          </Card>
        </PageBody>
      </>
    )
  }

  /* Narrowed against the real ids rather than trusted: these reach a WHERE and
     the URL is typeable. An unrecognised value falls back to the default
     instead of erroring — a stale bookmark should show a working screen. */
  const wanted = Number(params.structure)
  const structure =
    structures.find((s) => s.id === wanted) ??
    structures.find((s) => s.isDefault) ??
    structures[0]

  const departmentId = Number(department)
  const filterIds =
    Number.isFinite(departmentId) && departmentId > 0
      ? [...descendantIds(departments, departmentId)]
      : undefined

  const supplierId = Number(params.supplier)
  const supplierFilter =
    Number.isFinite(supplierId) && suppliers.items.some((s) => s.id === supplierId)
      ? supplierId
      : undefined

  const page = pageFrom(params.page)
  const { items, total, costBasis } = await listProductsForPricing(siteId, {
    structureId: structure.id,
    search: q,
    departmentIds: filterIds,
    supplierId: supplierFilter,
    includeArchived: archived === '1',
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  const pageCount = pageCountFor(total, PAGE_SIZE)

  // Every link composes onto the current query, so choosing a price type does
  // not silently drop the department filter or the search.
  const href = hrefBuilder('/products/bulk-pricing', params)
  /* Any filter change returns to page 1 — page 7 of the old result set is
     rarely a page of the new one. */
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  const departmentPaths: Record<number, string> = Object.fromEntries(
    departments.map((d) => [d.id, departmentPath(departments, d.id)]),
  )

  const structureOptions = structures.map((s) => ({
    value: String(s.id),
    label: s.name,
    href: filterHref({ structure: String(s.id) }),
  }))

  const departmentOptions = [
    { value: '', label: 'All departments', href: filterHref({ department: null }) },
    ...departments
      .map((d) => ({
        value: String(d.id),
        label: departmentPaths[d.id],
        href: filterHref({ department: String(d.id) }),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ]

  const supplierOptions = [
    { value: '', label: 'All suppliers', href: filterHref({ supplier: null }) },
    ...suppliers.items.map((s) => ({
      value: String(s.id),
      label: s.name,
      href: filterHref({ supplier: String(s.id) }),
    })),
  ]

  const filtered = !!filterIds || !!supplierFilter || !!q?.trim()

  return (
    <>
      <PageHeader
        title="Bulk edit pricing"
        subtitle={`Editing ${structure.name} prices${
          costBasis === 'last' ? ', margins off last cost' : ', margins off average cost'
        }`}
      />
      <PageBody>
        <Card>
          <TableToolbar inCard>
            <div className="w-72 max-w-full">
              <SearchBar
                action="/products/bulk-pricing"
                defaultValue={q}
                placeholder="Search description, code or barcode…"
                className="p-0"
                /* A GET form submits only its own fields, so without these a
                   search would clear the price type and every filter with it. */
                keep={{
                  structure: String(structure.id),
                  department,
                  supplier: params.supplier,
                  archived,
                }}
              />
            </div>

            <LinkSelect
              aria-label="Price type"
              options={structureOptions}
              value={String(structure.id)}
              icon={<Icons.Tag size={16} />}
            />

            <LinkSelect
              aria-label="Department"
              options={departmentOptions}
              value={filterIds ? String(departmentId) : ''}
              icon={<Icons.LayoutGrid size={16} />}
            />

            {suppliers.items.length > 0 && (
              <LinkSelect
                aria-label="Supplier"
                options={supplierOptions}
                value={supplierFilter ? String(supplierFilter) : ''}
              />
            )}

            {filtered && (
              <FilterChip
                label="Matching"
                value={`${total} ${total === 1 ? 'product' : 'products'}`}
                clearHref={filterHref({
                  department: null,
                  supplier: null,
                  q: null,
                })}
              />
            )}
          </TableToolbar>

          {items.length === 0 ? (
            <EmptyState
              icon={<Icons.Search size={28} />}
              title="No products here"
              hint={
                filtered
                  ? 'Nothing matches these filters. Try a different department, or clear the search.'
                  : 'There are no products to price yet.'
              }
            />
          ) : (
            <BulkPricingGrid
              rows={items}
              /* Split here rather than in the grid: which rates apply to buying
                 and which to selling is a fact about the data, and the row
                 should not be filtering the same list fifty times. */
              purchaseVatRates={vatRates
                .filter((v) => v.vatType === 'purchase')
                .map((v) => ({ id: v.id, rate: v.rate, code: v.code }))}
              sellingVatRates={vatRates
                .filter((v) => v.vatType === 'sales')
                .map((v) => ({ id: v.id, rate: v.rate, code: v.code }))}
              structureId={structure.id}
              structureName={structure.name}
              costBasis={costBasis}
              showCost={showCost}
              defaultEndingDirection={toEndingDirection(endingDirection)}
            />
          )}
        </Card>

        <Pagination
          page={page}
          pageCount={pageCount}
          total={total}
          pageSize={PAGE_SIZE}
          hrefFor={(p) => href({ page: p === 1 ? null : String(p) })}
        />
      </PageBody>
    </>
  )
}
