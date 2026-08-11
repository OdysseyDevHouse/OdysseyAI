import Link from 'next/link'
import { Pencil, Plus } from '@/components/ui/icons'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import ProductsTable from './ProductsTable'
import { listProducts, getProduct } from '@/lib/site/products'
import { getGroup } from '@/lib/site/productVariants'
import { getCostBasis } from '@/lib/site/lookups'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { formatMoney, formatQty } from '@/lib/decimals'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  Badge,
  RowTile,
  TextLink,
  FilterChip,
  Pagination,
  TableToolbar,
  LinkSegmentedControl,
  LinkSelect,
  Icons,
  DataTable,
  type Column,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/** Rows per page. The list used to render a flat 100 with no way to reach 101. */
const PAGE_SIZE = 50

type ProductRow = Awaited<ReturnType<typeof listProducts>>['items'][number]

/** The shelf price: the structure flagged default, else the first one. */
function defaultPrice(p: ProductRow) {
  return p.prices.find((x) => x.isDefault) ?? p.prices[0]
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    archived?: string
    low?: string
    department?: string
    page?: string
    group?: string
  }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('products.view')
  const showCost = can(capabilities, 'products.cost')
  const params = await searchParams
  const { q, archived, low, department } = params

  /* Which variant group is open, if any. A group id that is not a parent falls
     back to the whole catalogue rather than showing an empty list — the URL is
     typeable, and a product can stop being a parent while a tab sits open. */
  const groupId = Number(params.group)
  const openGroup =
    Number.isFinite(groupId) && groupId > 0 ? await getGroup(siteId, groupId) : null

  const [departments, costBasis] = await Promise.all([
    listDepartments(siteId, true),
    getCostBasis(siteId),
  ])

  // Filtering by a department includes everything beneath it — picking
  // "Fresh Produce" should not hide the products filed under its sub-levels.
  const departmentId = Number(department)
  const filterIds =
    Number.isFinite(departmentId) && departmentId > 0
      ? [...descendantIds(departments, departmentId)]
      : undefined

  const page = pageFrom(params.page)
  const { items, total } = await listProducts(siteId, {
    search: q,
    includeArchived: archived === '1',
    belowMinimum: low === '1',
    departmentIds: filterIds,
    parentId: openGroup ? openGroup.parentId : undefined,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  /* The parent names for whichever children are on screen — a search
     un-collapses groups, and "Large" alone does not say large what. Resolved
     here rather than joined into every product row, because outside a search
     there are usually none to resolve.

     Skipped INSIDE a group: the page header already names the parent there, so
     tagging all twenty rows "in Cotton Shirt" repeats what was just read. */
  const parentIds = openGroup
    ? []
    : [...new Set(items.map((p) => p.parentId).filter((id): id is number => !!id))]
  const parentNames: Record<number, string> = Object.fromEntries(
    (await Promise.all(parentIds.map((id) => getProduct(siteId, id))))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => [p.id, p.description]),
  )

  const filterLabel = filterIds ? departmentPath(departments, departmentId) : null

  // A plain id -> path map rather than the department tree plus the function
  // that walks it: ProductsTable is a client component, and departments.ts is
  // server-only.
  const departmentPaths: Record<number, string> = Object.fromEntries(
    departments.map((d) => [d.id, departmentPath(departments, d.id)]),
  )

  /* Every link on this screen composes onto the current query rather than
     replacing it, so searching no longer drops the department filter and
     paging no longer drops both. */
  const href = hrefBuilder('/products', params)
  /* Any filter change returns to page 1 — page 7 of the old result set is
     rarely a page of the new one, and landing on an empty list reads as "no
     matches" when there are plenty. */
  const filterHref = (changes: Record<string, string | null>) => href({ ...changes, page: null })

  /* Opening a group keeps the department filter and the slice — the question
     "which of these are below minimum" survives the click — but drops the
     search, which is what un-collapsed the groups in the first place.

     Built here as a plain id -> href map rather than passed as a function:
     ProductsTable is a client component and the URL helpers are server-side,
     so a function prop could not cross the boundary — the same reasoning that
     makes departmentPaths a map. */
  const groupHrefs: Record<number, string> = Object.fromEntries(
    items
      .filter((p) => p.hasVariants)
      .map((p) => [p.id, filterHref({ group: String(p.id), q: null })]),
  )

  /* The picker lists every department by full path, sorted by that path so a
     sub-department sits under its parent rather than wherever sort_order left
     it. Picking one filters to it AND everything beneath it, which is why the
     child entries are still worth listing separately. */
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

  /* Which slice the segmented control shows. The two flags are mutually
     exclusive here: a segmented control is one choice, and "archived products
     below minimum" was a combination nobody ever asked for. */
  const slice = archived === '1' ? 'archived' : low === '1' ? 'low' : 'all'

  /* Empty means one of three things — say which, and offer the way out. */
  const empty = q
    ? {
        title: `Nothing matches “${q}”`,
        hint: 'Check the spelling, or search by code or barcode.',
        action: (
          <ButtonLink variant="secondary" href={filterHref({ q: null })}>
            Clear search
          </ButtonLink>
        ),
      }
    : slice !== 'all' || filterLabel
      ? {
          title: 'No products match this filter',
          hint: 'Nothing on file fits the current slice.',
          action: (
            <ButtonLink variant="secondary" href="/products">
              Clear filters
            </ButtonLink>
          ),
        }
      : {
          title: 'No products yet',
          hint: 'Create your first product to get started.',
          action: (
            <PrimaryLink href="/products/new">
              <Plus size={15} />
              New product
            </PrimaryLink>
          ),
        }


  return (
    <>
      {/* Inside a group the screen is about ONE product, so it says so and
          offers the way back out. The variant axes are named in the subtitle —
          "Size · Colour" tells the reader what the rows below differ by. */}
      <PageHeader
        title={openGroup ? openGroup.parentDescription : 'Products'}
        subtitle={
          openGroup
            ? `${total} variant${total === 1 ? '' : 's'}` +
              (openGroup.axes.length
                ? ` by ${openGroup.axes.map((a) => a.label).join(' · ')}`
                : '')
            : `${total} product${total === 1 ? '' : 's'}${archived === '1' ? ', including archived' : ''}`
        }
        action={
          openGroup ? (
            <div className="flex items-center gap-2">
              <ButtonLink variant="secondary" href={filterHref({ group: null })}>
                All products
              </ButtonLink>
              <PrimaryLink href={`/products/${openGroup.parentId}`}>
                <Pencil size={15} />
                Edit group
              </PrimaryLink>
            </div>
          ) : (
            <PrimaryLink href="/products/new">
              <Plus size={15} />
              New product
            </PrimaryLink>
          )
        }
      />

      <PageBody>
        <TableToolbar>
          <div className="w-80 max-w-full">
            <SearchBar
              action="/products"
              defaultValue={q}
              placeholder="Search description, code or barcode…"
              className="p-0"
              /* A GET form submits only its own fields, so without these a
                 search would silently clear whichever filters were applied. */
              keep={{ archived, low, department }}
            />
          </div>

          <LinkSegmentedControl
            aria-label="Filter products"
            value={slice}
            options={[
              { value: 'all', label: 'Active', href: filterHref({ low: null, archived: null }) },
              {
                value: 'low',
                label: 'At or below minimum',
                href: filterHref({ low: '1', archived: null }),
              },
              {
                value: 'archived',
                label: 'Include archived',
                href: filterHref({ archived: '1', low: null }),
              },
            ]}
          />

          {/* Options carry their own href, built here on the server: a function
              prop cannot cross into a client component, and this keeps the URL
              helpers out of the browser bundle. */}
          <LinkSelect
            aria-label="Filter by department"
            icon={<Icons.LayoutGrid size={16} />}
            value={filterIds ? String(departmentId) : ''}
            options={departmentOptions}
            className="w-64"
          />

          {filterLabel && (
            <FilterChip
              label="Department"
              value={filterLabel}
              clearHref={filterHref({ department: null })}
            />
          )}
        </TableToolbar>

        <Card>
          <ProductsTable
            items={items}
            departmentPaths={departmentPaths}
            costBasis={costBasis}
            showCost={showCost}
            empty={empty}
            groupHrefs={groupHrefs}
            parentNames={parentNames}
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
