import { Pencil, Plus } from '@/components/ui/icons'
import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { compileListFilters, filterableFields } from '@/lib/site/listFilterSql'
import { rememberedFilters } from '@/lib/site/listFilterMemory'
import { decodeFilters, encodeFilters, FILTER_PARAM } from '@/lib/listFilters'
import ProductListClient from './ProductListClient'
import { listProducts, getProduct, type ProductSort } from '@/lib/site/products'
import { PRODUCT_TYPES, type ProductTypeId } from '@/lib/productTypes'
import { getGroup } from '@/lib/site/productVariants'
import { getCostBasis, listBrands, listVatRates } from '@/lib/site/lookups'
import { listGroups } from '@/lib/site/instructions'
import { listLocations } from '@/lib/site/stockLocations'
import { listDepartments, departmentPath, descendantIds } from '@/lib/site/departments'
import { hrefBuilder, offsetFor, pageCountFor, pageFrom, withParams } from '@/lib/searchParams'
import { listColumnsFor } from '@/lib/site/listColumns'
import { PRODUCT_COLUMN_IDS, PRODUCT_DEFAULT_COLUMNS } from './columns'
import ProductColumnsButton from './ProductColumnsButton'
import ListFilterButton from '@/components/lists/ListFilterButton'
import {
  PageHeader,
  PageBody,
  PrimaryLink,
  ButtonLink,
  Card,
  SearchBar,
  FilterChip,
  summariseCondition,
  Pagination,
  TableToolbar,
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
    /** The advanced filter's conditions. See FILTER_PARAM in lib/listFilters. */
    f?: string
  }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities, actor } = await requireCapability('products.view')
  const showCost = can(capabilities, 'products.cost')
  const params = await searchParams
  const { q, archived, low, department } = params

  /* ── the advanced filter ────────────────────────────────────────────────
   *
   * Conditions live in the URL like every other filter on this screen, so a
   * filtered list stays linkable and reloadable.
   *
   * The REMEMBERED set is what makes a worklist survive arriving here by a
   * route that carries no query string — the sidebar, a bookmark, the browser's
   * own history. It applies only when the URL says nothing about filters at
   * all: `?f=` with an empty value is how "clear" is written, and rehydrating
   * over that would make the filter impossible to turn off.
   *
   * `cleared` is therefore a real distinction and not a nicety — see the two
   * different absences it separates. */
  const cleared = params[FILTER_PARAM] !== undefined
  const remembered = cleared
    ? null
    : await rememberedFilters(siteId, 'products', actor.userId)

  const filterSource = cleared ? (params[FILTER_PARAM] ?? '') : (remembered ?? '')
  const conditions = decodeFilters(filterSource)

  /* What may be filtered on: the report catalog's products source, minus the
     fields whose SQL needs a join this list does not have, minus whatever this
     user may not read. Both narrowings matter — see listFilterSql.ts. */
  const allow = (c: Capability) => can(capabilities, c)
  const filterFields = filterableFields('products', allow).map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    numeric: f.numeric ?? false,
    group: f.group ?? '',
    hint: f.hint ?? '',
    options: f.options ?? [],
  }))

  const compiled = compileListFilters(
    'products',
    conditions,
    allow,
    new Set(filterFields.map((f) => f.key)),
    // listProducts has aliased the table `p` since long before this feature.
    'p',
  )

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
    extraWhere: compiled.where,
    extraParams: compiled.params,
    sort: sortKey,
    direction,
    parentId: openGroup ? openGroup.parentId : undefined,
    limit: PAGE_SIZE,
    offset: offsetFor(page, PAGE_SIZE),
  })

  /* The same slice WITHOUT the advanced conditions, for the "10 of 3,214" in
     the subtitle. Only asked for when there is a filter to compare against, so
     an ordinary catalogue load still runs exactly the queries it always did —
     and `limit: 1` because only the count is wanted, never the rows. */
  const unfilteredTotal = conditions.length
    ? (
        await listProducts(siteId, {
          search: q,
          includeArchived: archived === '1',
          belowMinimum: low === '1',
          departmentIds: filterIds,
          productTypes: productType ? [productType] : undefined,
          parentId: openGroup ? openGroup.parentId : undefined,
          limit: 1,
        })
      ).total
    : total

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

  /* This list's own address, carried out to every product it links to so the
     trip back lands HERE — same filters, same sort, same page — instead of on
     the bare catalogue. A filtered list is a worklist: someone narrows to ten
     products and edits them one after another, and re-applying the filter
     after every save is the thing that made that painful.

     Only when something is actually applied. An unfiltered catalogue keeps the
     short `/products/123` links it has always had, because there is nothing
     about `/products` worth carrying and a redundant `?from=` on every row
     makes a shared link look like a tracking URL. */
  const listUrl = `/products${withParams(params, {})}`
  const editSuffix = listUrl === '/products' ? '' : `?from=${encodeURIComponent(listUrl)}`

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

  /* Which slice a URL is asking for. The toolbar no longer offers the choice,
     but both flags still work when a link carries them — and this is what
     tells the empty state to say "nothing fits the filters" rather than
     "nothing on file". Kept mutually exclusive: "archived products below
     minimum" was a combination nobody ever asked for. */
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
    : slice !== 'all' || filterLabel || typeLabel || conditions.length
      ? {
          title: 'No products match this filter',
          /* Name the conditions rather than saying "the current slice". An
             empty list under a REMEMBERED filter is the worst case this screen
             has — nobody typed anything, so the hint is the only thing that
             explains why the catalogue looks empty. */
          hint: conditions.length
            ? `Nothing matches ${conditions
                .map((c) => summariseCondition(c, filterFields))
                .join(', and ')}.`
            : 'Nothing on file fits the current slice.',
          action: (
            /* An EMPTY `?f=`, not a bare /products: absent means "nobody has
               said", which is exactly when a remembered filter comes back. A
               plain link here would leave the list stuck empty. */
            <ButtonLink variant="secondary" href={`/products?${FILTER_PARAM}=`}>
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
            : /* Under an advanced filter, say what is being HIDDEN as well as
                 what is shown. "10 products" on a catalogue of 3,214 is the
                 same sentence whether the filter was typed just now or
                 remembered from before lunch — and only the second number
                 tells the reader which of those they are looking at. */
              `${total} product${total === 1 ? '' : 's'}` +
              (conditions.length && unfilteredTotal > total ? ` of ${unfilteredTotal}` : '') +
              (archived === '1' ? ', including archived' : '')
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
            <div className="flex items-center gap-2">
              {/* The whole catalogue, headed for Excel and back through the
                  import — the round trip, not a view of this list's filters. */}
              <ButtonLink variant="ghost" href="/api/products/export">
                <Icons.Download size={15} />
                Export
              </ButtonLink>
              <PrimaryLink href="/products/new">
                <Plus size={15} />
                New product
              </PrimaryLink>
            </div>
          )
        }
      />

      {/* `flush` because this screen ENDS in a viewport-capped table. The table
          is sized by useFitViewport to the room left below it, and that hook
          counts PageBody's pb-10 as space to reserve — so on a page that does
          not scroll, the 40px is not breathing room under the last card, it is
          40px the table was refused and nothing else uses. The card's own
          padding still keeps the last row off the window edge. */}
      <PageBody flush>
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

          {/* The Active / At-or-below-minimum / Include-archived control used to
              sit here. Both flags still work when a URL carries them — the
              query, the count line and the empty state all still read them —
              so a saved link or a bookmark keeps doing what it did. What is
              gone is the toolbar making the choice. Archived stays reachable
              through the Filter button, which offers it as a yes/no field. */}

          {/* Options carry their own href, built here on the server: a function
              prop cannot cross into a client component, and this keeps the URL
              helpers out of the browser bundle. */}
          {/* A FIXED width, narrower than the longest option it can hold. A
              department path can be "Food > Bakery > Morning goods", and a
              picker sized to fit that is a control whose width is decided by
              the deepest branch in the tree — different in every shop, and
              wider than the pickers beside it here. The chosen value truncates
              instead; the open menu is what shows a long path in full. */}
          <LinkSelect
            aria-label="Filter by department"
            icon={<Icons.LayoutGrid size={16} />}
            value={filterIds ? String(departmentId) : ''}
            options={departmentOptions}
            className="w-44"
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

          {/* Everything the toolbar cannot express, behind one button. Sits
              after the built-in pickers because it is the escape hatch from
              them, not a peer — and most people never open it. */}
          <ListFilterButton
            listKey="products"
            fields={filterFields}
            value={conditions}
            remembered={!!remembered}
            builderHref="/reports/builder?source=products"
          />

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

          {/* One chip per advanced condition, spelled out in words.

              This is what keeps a REMEMBERED filter honest: it applies without
              anyone having typed a URL, so the only thing standing between that
              and "the catalogue has lost three thousand products" is the screen
              saying, plainly and always, what it is currently showing. Each
              chip clears just itself; the count in the subtitle says the rest. */}
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
        </TableToolbar>

        <Card>
          <ProductListClient
            items={items}
            departmentPaths={departmentPaths}
            costBasis={costBasis}
            showCost={showCost}
            empty={empty}
            groupHrefs={groupHrefs}
            editSuffix={editSuffix}
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
