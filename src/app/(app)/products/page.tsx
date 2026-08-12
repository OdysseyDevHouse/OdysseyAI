import { Pencil, Plus } from '@/components/ui/icons'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import ProductListClient from './ProductListClient'
import { listProducts, getProduct, type ProductSort } from '@/lib/site/products'
import { PRODUCT_TYPES, type ProductTypeId } from '@/lib/productTypes'
import { getGroup } from '@/lib/site/productVariants'
import { getCostBasis, listBrands, listVatRates } from '@/lib/site/lookups'
import { listGroups } from '@/lib/site/instructions'
import { listLocations } from '@/lib/site/stockLocations'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom } from '@/lib/searchParams'
import { listColumnsFor } from '@/lib/site/listColumns'
import { PRODUCT_COLUMN_IDS, PRODUCT_DEFAULT_COLUMNS } from './columns'
import ProductColumnsButton from './ProductColumnsButton'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  FilterChip,
  Pagination,
  TableToolbar,
  LinkSegmentedControl,
  LinkSelect,
  Icons,
} from '@/components/ui'

export const dynamic = 'force-dynamic'

/** Rows per page. The list used to render a flat 100 with no way to reach 101. */
const PAGE_SIZE = 50

/**
 * The sort choices, in the order the picker offers them.
 *
 * Each carries the direction it should START in, because the useful end of a
 * column differs: a name is read A to Z, but "date created" is asked to answer
 * "what is new", which is the newest first. Picking a sort a second time from
 * the column header flips it — that is DataTable's business, not this list's.
 */
const SORTS: { value: ProductSort; label: string; initial: 'asc' | 'desc' }[] = [
  { value: 'description', label: 'Description', initial: 'asc' },
  { value: 'code', label: 'Product code', initial: 'asc' },
  { value: 'created', label: 'Date created', initial: 'desc' },
  { value: 'edited', label: 'Last modified', initial: 'desc' },
]

const SORT_IDS = new Set<string>(SORTS.map((s) => s.value))
const TYPE_IDS = new Set<string>(PRODUCT_TYPES.map((t) => t.id))

/**
 * A DATETIME for the screen.
 *
 * Read out of the UTC fields and formatted HERE, on the server: the site pool
 * parses a DATETIME as though its wall-clock were UTC, so handing the Date to
 * the browser would re-read it in the viewer's timezone and could show the day
 * before. See src/lib/siteDb.ts.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function formatDate(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) return ''
  return `${String(value.getUTCDate()).padStart(2, '0')} ${MONTHS[value.getUTCMonth()]} ${value.getUTCFullYear()}`
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    archived?: string
    low?: string
    department?: string
    type?: string
    sort?: string
    dir?: string
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

  /* The bulk-options lookups load with the list rather than on demand: the
     dialog is a client component, so fetching them when it opens would mean a
     round trip between clicking "Bulk options" and seeing the actions. */
  const [departments, costBasis, brands, vatRates, instructionGroups, locations] =
    await Promise.all([
      listDepartments(siteId, true),
      getCostBasis(siteId),
      listBrands(siteId),
      listVatRates(siteId),
      listGroups(siteId),
      listLocations(siteId, false, true),
    ])

  // Filtering by a department includes everything beneath it — picking
  // "Fresh Produce" should not hide the products filed under its sub-levels.
  const departmentId = Number(department)
  const filterIds =
    Number.isFinite(departmentId) && departmentId > 0
      ? [...descendantIds(departments, departmentId)]
      : undefined

  /* Both narrowed against the known ids rather than trusted: these reach an
     ORDER BY and a WHERE, and the URL is typeable. An unrecognised value falls
     back to the default instead of erroring — a stale bookmark should show the
     catalogue, not a broken screen. */
  const productType = TYPE_IDS.has(params.type ?? '') ? (params.type as ProductTypeId) : undefined
  const sortKey: ProductSort = SORT_IDS.has(params.sort ?? '')
    ? (params.sort as ProductSort)
    : 'description'
  const direction = params.dir === 'desc' ? 'desc' : 'asc'

  const page = pageFrom(params.page)
  const { items, total } = await listProducts(siteId, {
    search: q,
    includeArchived: archived === '1',
    belowMinimum: low === '1',
    departmentIds: filterIds,
    productTypes: productType ? [productType] : undefined,
    sort: sortKey,
    direction,
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

  /* What the bulk-options forms need to offer a choice. Plain values only:
     these cross into a client component, so ids and labels rather than the
     domain objects the queries returned. Departments reuse the same full-path
     labels the filter picker uses, sorted the same way. */
  const bulkLookups = {
    departments: departments
      .map((d) => ({ id: d.id, label: departmentPaths[d.id] }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    brands: brands.map((b) => ({ id: b.id, name: b.name })),
    sellingVatRates: vatRates
      .filter((v) => v.vatType === 'sales')
      .map((v) => ({ id: v.id, label: `${v.name} (${v.rate}%)` })),
    purchaseVatRates: vatRates
      .filter((v) => v.vatType === 'purchase')
      .map((v) => ({ id: v.id, label: `${v.name} (${v.rate}%)` })),
    instructionGroups: instructionGroups.map((g) => ({ id: g.id, name: g.name })),
    locations: locations.map((l) => ({ id: l.id, name: l.name, isMain: l.isMain })),
  }

  /* The type picker. Eight kinds is too many for a segmented bar and they are
     read by name rather than by position, so it is a select — the same
     reasoning that makes the department filter one. The stored ids are dropped
     in favour of the names the product form uses, minus the trailing
     "product": the label above the control already says what is being
     filtered. */
  const typeOptions = [
    { value: '', label: 'All types', href: filterHref({ type: null }) },
    ...PRODUCT_TYPES.map((t) => ({
      value: t.id,
      label: t.name.replace(/ product$/i, ''),
      href: filterHref({ type: t.id }),
    })),
  ]

  /* Sorting keeps its own page — unlike a filter, re-ordering does not change
     WHICH products match, so page 4 of the same result set is still a page of
     it. Every ordering gets an href so both the picker and the column headers
     can navigate; the headers need the flipped direction too, which is why the
     map is keyed by "key:direction" rather than by key alone. */
  const sortHrefs: Record<string, string> = Object.fromEntries(
    SORTS.flatMap((s) =>
      (['asc', 'desc'] as const).map((d) => [
        `${s.value}:${d}`,
        href({ sort: s.value, dir: d === 'asc' ? null : 'desc' }),
      ]),
    ),
  )

  const sortOptions = SORTS.map((s) => ({
    value: s.value,
    label: s.label,
    href: sortHrefs[`${s.value}:${s.initial}`],
  }))

  /* Formatted on the server and passed as strings: a DATETIME arrives parsed
     as UTC, so a Date crossing into the client would be re-read in the
     viewer's timezone. See formatDate above.

     Every date the column catalogue offers is formatted whether or not it is
     currently shown — six strings for fifty rows, against the alternative of
     threading the visible set into this loop so a column can arrive blank the
     first time somebody switches it on. */
  const dates: Record<
    number,
    {
      created: string
      edited: string
      lastSold: string
      lastPurchase: string
      lastAdjust: string
      lastStockTake: string
    }
  > = Object.fromEntries(
    items.map((p) => [
      p.id,
      {
        created: formatDate(p.createdAt),
        edited: formatDate(p.lastEditDate),
        lastSold: formatDate(p.lastSoldDate),
        lastPurchase: formatDate(p.lastPurchaseDate),
        lastAdjust: formatDate(p.lastAdjustDate),
        lastStockTake: formatDate(p.lastStockTakeDate),
      },
    ]),
  )

  /* The store's columns, or the list's own default when it has never chosen.
     The device may narrow this further — see ProductListClient. */
  const storeColumns =
    (await listColumnsFor(siteId, 'products', PRODUCT_COLUMN_IDS)) ?? PRODUCT_DEFAULT_COLUMNS

  const typeLabel = productType
    ? PRODUCT_TYPES.find((t) => t.id === productType)!.name.replace(/ product$/i, '')
    : null

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
    : slice !== 'all' || filterLabel || typeLabel
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
        {/* Columns goes in the actions slot — right-aligned, beside the other
            things you do TO the list, rather than in a strip of its own
            between the toolbar and the table. */}
        <TableToolbar
          actions={
            <ProductColumnsButton
              storeColumns={storeColumns}
              canSetColumns={can(capabilities, 'setup.edit')}
            />
          }
        >
          <div className="w-80 max-w-full">
            <SearchBar
              action="/products"
              defaultValue={q}
              placeholder="Search description, code or barcode…"
              className="p-0"
              /* A GET form submits only its own fields, so without these a
                 search would silently clear whichever filters were applied —
                 and the chosen ordering with them. */
              keep={{ archived, low, department, type: params.type, sort: params.sort, dir: params.dir }}
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

          <LinkSelect
            aria-label="Filter by product type"
            icon={<Icons.Tag size={16} />}
            value={productType ?? ''}
            options={typeOptions}
            className="w-48"
          />

          {/* Sort sits with the filters rather than in the actions slot: it is
              a statement about the list, not something done to it. The column
              headers offer the same four orderings and flip the direction — the
              picker is for choosing one that is not on screen.

              Not offered inside a group: the variants there are in the order
              the group defines (Small, Medium, Large — not alphabetical), and
              a picker whose choice the query ignores is worse than none. */}
          {!openGroup && (
            <LinkSelect
              aria-label="Sort products"
              icon={<Icons.SortIcon size={16} />}
              value={sortKey}
              options={sortOptions}
              className="w-52"
            />
          )}

          {filterLabel && (
            <FilterChip
              label="Department"
              value={filterLabel}
              clearHref={filterHref({ department: null })}
            />
          )}

          {typeLabel && (
            <FilterChip label="Type" value={typeLabel} clearHref={filterHref({ type: null })} />
          )}
        </TableToolbar>

        <Card>
          <ProductListClient
            items={items}
            departmentPaths={departmentPaths}
            costBasis={costBasis}
            showCost={showCost}
            empty={empty}
            groupHrefs={groupHrefs}
            parentNames={parentNames}
            dates={dates}
            storeColumns={storeColumns}
            /* Null inside a group: those rows are in the group's own size
               order, which the sort argument deliberately does not override. */
            sort={openGroup ? null : { key: sortKey, direction }}
            sortHrefs={sortHrefs}
            canDelete={can(capabilities, 'products.delete')}
            lookups={bulkLookups}
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
