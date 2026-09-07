'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { formatCost, formatMoney, formatQty } from '@/lib/decimals'
import {
  AdvancedFilter,
  Badge,
  Button,
  ColumnPicker,
  DataTable,
  EmptyState,
  Field,
  FIELD_CONTROL_OFFSET,
  FilterBar,
  FilterChip,
  Icons,
  Input,
  Modal,
  Pagination,
  RowGlyph,
  Select,
  TableToolbar,
  summariseCondition,
  useToast,
  type Column,
  type FilterCondition,
  type FilterField,
} from '@/components/ui'
import { useColumnPrefs } from '@/lib/useColumnPrefs'
import { encodeFilters } from '@/lib/listFilters'
import { setListColumnsAction } from '@/app/(app)/listColumnActions'
import {
  searchProductsForPickerAction,
  type ProductSearchLookups,
} from './productSearchActions'
import {
  PRODUCT_SEARCH_COLUMNS,
  PRODUCT_SEARCH_DEFAULT_COLUMNS,
  type ProductSearchRow,
} from './productSearchColumns'

/**
 * The product search pop-up — the catalogue, in a dialog, from anywhere.
 *
 * ── WHAT IT IS FOR ───────────────────────────────────────────────────────
 *
 * Every screen that puts a product on a document needs to find one, and until
 * now each grew its own picker: a search box over a flat list of twenty rows,
 * with no columns, no sort and no way to ask "which of these is below
 * minimum". That is a fine control for someone who already knows the code and
 * a dead end for everyone else — which is the case a picker exists to serve.
 *
 * So this is the products LIST, not a lookup box: the same grid, the same
 * column catalogue, the same advanced filter, the same sort. What it adds is
 * the two ways a picker is asked to answer.
 *
 * ── THE TWO WAYS TO PICK ─────────────────────────────────────────────────
 *
 * Clicking the DESCRIPTION picks that one product and closes. It is the
 * commonest case by a distance — someone opened this to add a thing, found the
 * thing, and wants to be back on their document — and it costs one click.
 *
 * Ticking rows collects SEVERAL and the footer sends them together. The tick
 * boxes are DataTable's own, so shift-click ranges and the header's select-all
 * work here exactly as they do on the catalogue screen.
 *
 * The two never fight: a tick is a tick and a click on the name is a pick, and
 * because the name is a distinct target inside the row there is no gesture that
 * could mean either. Rows do NOT navigate on click — this is a dialog over
 * somebody's half-finished invoice, and a row that opened /products/123 would
 * throw that work away.
 *
 * ── ITS COLUMNS ARE ITS OWN ──────────────────────────────────────────────
 *
 * Stored under the `productSearch` list key, never `products`. Hiding GP% while
 * pricing must not hide it while invoicing: the two screens are opened by
 * different people asking different questions, and one stored set would make
 * each one's tidying-up the other's missing column. Both layers are separate —
 * the store's row in list_columns, and this device's localStorage key.
 */

/** Rows per page. Matches the catalogue screen, so the pager reads the same. */
const PAGE_SIZE = 50

export type ProductSearchPick = {
  id: number
  code: string
  description: string
  /** The shelf price incl. VAT, or null for a variant parent that prices per child. */
  priceIncl: number | null
  barcode: string | null
  stockOnHand: number
}

export default function ProductSearchModal({
  open,
  onClose,
  onPick,
  onPickMany,
  title = 'Search products',
  description = 'Search, filter and sort the catalogue. Click a name to add one, or tick several and add them together.',
  confirmLabel = 'Add',
  search = searchProductsForPickerAction,
}: {
  open: boolean
  onClose: () => void
  /**
   * One product was chosen — a click on its name.
   *
   * The dialog closes itself immediately afterwards, which is the whole point
   * of the single-pick gesture: the caller does not have to, and cannot forget
   * to. A caller that wants to stay open for several should offer the tick
   * boxes instead, which is what `onPickMany` is.
   */
  onPick: (product: ProductSearchPick) => void
  /**
   * Several products were chosen — the footer's Add button.
   *
   * Optional. Omit it and the tick boxes do not appear at all, which is right
   * for a caller that can only take one thing: a picker offering a selection it
   * will then ignore is worse than one that never offered it.
   */
  onPickMany?: (products: ProductSearchPick[]) => void
  title?: string
  description?: string
  /** The footer verb — "Add", "Link", "Receive". The count is appended. */
  confirmLabel?: string
  /**
   * Where the rows come from. Defaults to the real action, so no call site
   * passes it.
   *
   * Injectable because the Style Guide is how a dialog gets LOOKED at in this
   * app, and a component that imports its own action can only be previewed by
   * hitting the live catalogue — which makes the preview depend on whichever
   * store the screenshot harness happened to sign into. It also leaves room
   * for a caller that wants this grid over a NARROWER query: a picker for one
   * supplier's own lines is the same dialog and a different search.
   */
  search?: typeof searchProductsForPickerAction
}) {
  const toast = useToast()

  /* ── What the grid is currently asking for ──────────────────────────────
   *
   * All of it React state rather than URL parameters, unlike the catalogue
   * screen. The URL belongs to the page BEHIND this dialog — an invoice being
   * captured — and rewriting it to remember a department would put a
   * half-finished document one Back button away from being lost. */
  const [term, setTerm] = useState('')
  const [departmentId, setDepartmentId] = useState<number | null>(null)
  const [productType, setProductType] = useState<string | null>(null)
  const [conditions, setConditions] = useState<FilterCondition[]>([])
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' }>({
    key: 'description',
    direction: 'asc',
  })
  const [page, setPage] = useState(1)

  const [rows, setRows] = useState<ProductSearchRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [lookups, setLookups] = useState<ProductSearchLookups | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  const searchRef = useRef<HTMLInputElement>(null)

  /* Every picked row, by id — NOT just the ones on this page.
   *
   * The selection survives paging and re-searching, so someone can tick two
   * things in Bakery, search "milk", tick a third and add all three. Keeping
   * only the keys would lose the other two the moment their rows left `rows`,
   * and the footer would send one product having shown a count of three. */
  const picked = useRef(new Map<number, ProductSearchPick>())

  const encodedFilters = useMemo(() => encodeFilters(conditions), [conditions])

  /* ── Fetching ───────────────────────────────────────────────────────────
   *
   * Debounced, and guarded by a `live` flag rather than by cancelling: a short
   * term matches far more rows than a long one, so a slow early request can
   * land after a fast later one and replace the right answer with a stale
   * list. Only the newest request is allowed to write.
   *
   * No debounce on the very first load, or the dialog opens empty for a
   * quarter second every single time. */
  const needLookups = lookups === null

  useEffect(() => {
    if (!open) return

    let live = true
    setLoading(true)
    const timer = setTimeout(
      async () => {
        try {
          const result = await search({
            search: term.trim() || undefined,
            departmentId,
            productType,
            filters: encodedFilters,
            sort: sort.key,
            direction: sort.direction,
            page,
            pageSize: PAGE_SIZE,
            withLookups: needLookups,
          })
          if (!live) return
          setRows(result.rows)
          setTotal(result.total)
          if (result.lookups) setLookups(result.lookups)
        } catch {
          if (!live) return
          setRows([])
          setTotal(0)
          /* Say so. A grid that silently empties is read as "the shop does not
             stock it", and the product someone cannot find is the one they
             conclude does not exist. */
          toast.error('Could not load products. Check the connection and try again.')
        } finally {
          if (live) setLoading(false)
        }
      },
      needLookups ? 0 : 250,
    )

    return () => {
      live = false
      clearTimeout(timer)
    }
    // `search` IS listed — an injected function that is not named here would
    // leave the effect calling whichever one it closed over first, which is
    // exactly how a preview silently keeps hitting the real catalogue. `toast`
    // is stable, and `needLookups` is derived: listing it would re-run the
    // whole query the moment the lookups land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    term,
    departmentId,
    productType,
    encodedFilters,
    sort.key,
    sort.direction,
    page,
    search,
  ])

  /* Any narrowing goes back to page 1. Page 7 of the old result set is rarely a
     page of the new one, and landing on an empty page reads as "no matches"
     when there are plenty. Sort keeps its page: re-ordering does not change
     WHICH products match. */
  useEffect(() => {
    setPage(1)
  }, [term, departmentId, productType, encodedFilters])

  /* A fresh dialog every time it opens.
   *
   * Someone reaching for the picker a second time is nearly always looking for
   * something unrelated to the first, and a grid still showing the last
   * search's four rows looks like a catalogue that has lost everything else. */
  useEffect(() => {
    if (!open) return
    setTerm('')
    setDepartmentId(null)
    setProductType(null)
    setConditions([])
    setSort({ key: 'description', direction: 'asc' })
    setPage(1)
    setSelected(new Set())
    picked.current.clear()
  }, [open])

  /* ── Which columns ──────────────────────────────────────────────────────
   *
   * Two layers, the same pair every list in the app uses. The STORE's set says
   * which columns this business uses at all (list_columns, under this picker's
   * OWN key); the DEVICE set says how many of them fit on the screen in front
   * of you (localStorage, also its own key). So the store's choice is the
   * default handed to useColumnPrefs, and Reset lands there. */
  const storeColumns = lookups?.storeColumns ?? PRODUCT_SEARCH_DEFAULT_COLUMNS
  const showCost = lookups?.showCost ?? false

  /* The catalogue this device may pick from: what the store shows, minus what
     this role may not read. A cost column nobody may see is not offered — it
     would tick on and render dashes. */
  const pickable = useMemo(
    () =>
      PRODUCT_SEARCH_COLUMNS.filter(
        (c) =>
          (storeColumns.includes(c.id) || c.locked) &&
          (showCost || !COST_COLUMNS.has(c.id)),
      ),
    [storeColumns, showCost],
  )

  const prefs = useColumnPrefs(
    'odyssey.productSearch.columns',
    storeColumns,
    PRODUCT_SEARCH_COLUMNS.map((c) => c.id),
  )

  // Locked columns are always in: the picker shows them ticked and disabled,
  // and a stored set from before one was locked would otherwise drop it.
  const visibleColumns = useMemo(() => {
    const next = new Set(prefs.visible)
    for (const c of PRODUCT_SEARCH_COLUMNS) if (c.locked) next.add(c.id)
    for (const id of COST_COLUMNS) if (!showCost) next.delete(id)
    return next
  }, [prefs.visible, showCost])

  const [savingColumns, startSaveColumns] = useTransition()

  function saveColumnsForStore(next: Set<string>) {
    /* Shown NOW, not when the server answers. The tick has to move on the click
       that caused it — doing the round trip first and then resetting lands on
       the pre-save set, which reads as a checkbox that needs clicking twice. */
    prefs.setVisible(next)

    startSaveColumns(async () => {
      const result = await setListColumnsAction(
        'productSearch',
        [...next],
        PRODUCT_SEARCH_COLUMNS.map((c) => c.id),
      )
      if (!result.ok) {
        prefs.reset()
        toast.error(result.error)
        return
      }
      /* The device override is FORGOTTEN rather than reset: reset would land on
         `storeColumns`, which is the value from before this save, so the column
         would come on, go off and come back. Forgetting keeps what was chosen
         and lets the next open read the store's copy. */
      prefs.forget()
      setLookups((prev) => (prev ? { ...prev, storeColumns: [...next] } : prev))
      toast.success('Columns saved for the store')
    })
  }

  /* ── Picking ────────────────────────────────────────────────────────────── */

  const toPick = useCallback(
    (p: ProductSearchRow): ProductSearchPick => ({
      id: p.id,
      code: p.code,
      description: p.description,
      priceIncl: p.priceIncl,
      barcode: p.barcode,
      stockOnHand: p.stockOnHand,
    }),
    [],
  )

  /** A click on the name: one product, and the dialog is done. */
  const pickOne = useCallback(
    (p: ProductSearchRow) => {
      onPick(toPick(p))
      onClose()
    },
    [onPick, onClose, toPick],
  )

  function changeSelection(next: ReadonlySet<string>) {
    /* Keep the MAP in step with the keys, so a row picked three pages ago is
       still a whole product when the footer sends it. Adds are resolved from
       the rows on screen — the only place a key can be added from — and drops
       are removed outright. */
    const byId = new Map(rows.map((r) => [String(r.id), r]))
    for (const key of next) {
      if (!picked.current.has(Number(key))) {
        const row = byId.get(key)
        if (row) picked.current.set(row.id, toPick(row))
      }
    }
    for (const id of [...picked.current.keys()]) {
      if (!next.has(String(id))) picked.current.delete(id)
    }
    setSelected(next)
  }

  function confirmMany() {
    if (!onPickMany || picked.current.size === 0) return
    onPickMany([...picked.current.values()])
    onClose()
  }

  /* ── The grid ───────────────────────────────────────────────────────────── */

  const departmentPaths = lookups?.departmentPaths ?? {}
  const costBasis = lookups?.costBasis ?? 'last'

  const columns = useMemo<Column<ProductSearchRow>[]>(() => {
    const all: Column<ProductSearchRow>[] = [
      {
        key: 'description',
        header: 'Product',
        sortable: true,
        /* THE PICK TARGET. A button, not a link: this dialog sits over
           somebody's half-captured document, and an anchor to /products/123
           would offer to navigate away from it — one stray middle-click and
           the invoice is gone. It reads as the row's name and behaves as the
           row's action, which is what "click the description to choose it"
           means.

           Description and code are ONE identity, not two columns the eye has
           to join up: the name reads first, the code a step down underneath,
           the way every other list in the app names a record. */
        cell: (p) => (
          <button
            type="button"
            onClick={() => pickOne(p)}
            title={`Add ${p.description}`}
            className="flex w-full items-center gap-2.5 text-left transition hover:text-brand"
          >
            <RowGlyph
              label={p.description}
              token={p.imageColor}
              src={p.hasImage ? `/api/product-icon/${p.id}` : null}
            />
            <span className="flex min-w-0 flex-col">
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="min-w-0 truncate text-ink">{p.description}</span>
                {/* A group prices and stocks per child, so picking the parent
                    would put a thing with no price on the document. The badge
                    says why the row is here and that it is not the answer. */}
                {p.hasVariants && (
                  <Badge tone="brand">
                    {p.variantCount} variant{p.variantCount === 1 ? '' : 's'}
                  </Badge>
                )}
                {p.isArchived && <Badge>Archived</Badge>}
              </span>
              <span className="numeric mt-0.5 truncate text-xs text-muted">{p.code}</span>
            </span>
          </button>
        ),
      },
      {
        key: 'barcode',
        header: 'Barcode',
        cell: (p) =>
          p.barcode ? (
            <span className="numeric text-muted">{p.barcode}</span>
          ) : (
            <span className="text-faint">—</span>
          ),
      },
      {
        key: 'department',
        header: 'Department',
        cell: (p) => {
          const path = p.departmentId ? departmentPaths[p.departmentId] : null
          return path ? (
            <span className="text-muted">{path}</span>
          ) : (
            <span className="text-faint">—</span>
          )
        },
      },
      {
        key: 'productType',
        header: 'Type',
        cell: (p) => (
          <span className="text-muted">
            {lookups?.productTypes.find((t) => t.id === p.productType)?.name ?? p.productType}
          </span>
        ),
      },
      {
        key: 'cost',
        header: costBasis === 'last' ? 'Last cost' : 'Avg cost',
        numeric: true,
        cell: (p) => money(p.cost, formatCost),
      },
      {
        key: 'costIncl',
        header: 'Cost incl.',
        numeric: true,
        cell: (p) => money(p.costIncl, formatCost),
      },
      {
        key: 'sellExcl',
        header: 'Selling excl.',
        numeric: true,
        cell: (p) => money(p.sellExcl, formatMoney),
      },
      {
        key: 'price',
        header: 'Price incl.',
        numeric: true,
        // The one figure this dialog exists to confirm, so it keeps full ink
        // where the other money columns are muted.
        cell: (p) =>
          p.priceIncl === null ? (
            <span className="text-faint">—</span>
          ) : (
            <span className="text-ink">{formatMoney(p.priceIncl)}</span>
          ),
      },
      {
        key: 'gpValue',
        header: 'GP value',
        numeric: true,
        // Selling below cost is the exception the eye must catch; a healthy
        // margin is just a number.
        cell: (p) =>
          p.gpValue === null ? (
            <span className="text-faint">—</span>
          ) : p.gpValue < 0 ? (
            <Badge tone="danger">{formatMoney(p.gpValue)}</Badge>
          ) : (
            <span className="text-muted">{formatMoney(p.gpValue)}</span>
          ),
      },
      {
        key: 'gp',
        header: 'GP %',
        numeric: true,
        cell: (p) =>
          p.gp === null ? (
            <span className="text-faint">—</span>
          ) : p.gp < 0 ? (
            <Badge tone="danger">{p.gp.toFixed(1)}%</Badge>
          ) : (
            <span className="text-muted">{p.gp.toFixed(1)}%</span>
          ),
      },
      {
        key: 'maxDiscount',
        header: 'Max disc. %',
        numeric: true,
        // Zero means "no discount allowed" — a real setting, not a blank.
        cell: (p) => <span className="text-muted">{p.maxDiscountPct.toFixed(1)}%</span>,
      },
      {
        key: 'stock',
        header: 'On hand',
        numeric: true,
        /* State gets a form, not just a value — and here it is the second
           question the dialog is asked. Billing for something the shop does
           not have is the mistake a picker is most likely to cause, so an
           empty shelf is a badge rather than a 0 in a grey column.
           A NEGATIVE pile shows its figure: 0 and -40 are different problems,
           and hiding the second behind "Out of stock" is how a product sits at
           -3 unnoticed. */
        cell: (p) =>
          p.stockOnHand < 0 ? (
            <Badge tone="danger">{formatQty(p.stockOnHand)}</Badge>
          ) : p.stockOnHand === 0 ? (
            <Badge tone="danger">Out of stock</Badge>
          ) : p.belowMinimum ? (
            <Badge tone="warning">{formatQty(p.stockOnHand)}</Badge>
          ) : (
            formatQty(p.stockOnHand)
          ),
      },
      {
        key: 'minStock',
        header: 'Min level',
        numeric: true,
        cell: (p) => qty(p.minStock),
      },
      {
        key: 'maxStock',
        header: 'Max level',
        numeric: true,
        cell: (p) => qty(p.maxStock),
      },
      {
        key: 'packSize',
        header: 'Pack size',
        numeric: true,
        cell: (p) => <span className="text-muted">{formatQty(p.packSize)}</span>,
      },
      {
        key: 'packDescription',
        header: 'Pack desc.',
        cell: (p) => <span className="text-muted">{p.packDescription || '—'}</span>,
      },
      {
        key: 'packWeight',
        header: 'Pack weight',
        numeric: true,
        cell: (p) => <span className="text-muted">{formatQty(p.packWeight)}</span>,
      },
      {
        key: 'weightDescription',
        header: 'Weight unit',
        cell: (p) => <span className="text-muted">{p.weightDescription || '—'}</span>,
      },
      { key: 'lastSold', header: 'Last sold', cell: (p) => date(p.lastSold) },
      { key: 'lastPurchase', header: 'Last received', cell: (p) => date(p.lastPurchase) },
      { key: 'lastAdjust', header: 'Last adjusted', cell: (p) => date(p.lastAdjust) },
      { key: 'lastStockTake', header: 'Last stock take', cell: (p) => date(p.lastStockTake) },
      { key: 'edited', header: 'Last edit', sortable: true, cell: (p) => date(p.edited) },
      { key: 'created', header: 'Created', sortable: true, cell: (p) => date(p.created) },
    ]

    return all.filter((c) => visibleColumns.has(c.key))
  }, [visibleColumns, departmentPaths, costBasis, lookups, pickOne])

  /* The advanced filter's fields, as the kit's type wants them. Cast because
     the action flattens `options` to unknown[] to cross the wire — the catalog
     is the authority on their shape and it is unchanged on the way through. */
  const filterFields = (lookups?.filterFields ?? []) as unknown as FilterField[]

  const departmentLabel =
    departmentId !== null
      ? (lookups?.departments.find((d) => d.id === departmentId)?.label ?? null)
      : null
  const typeLabel =
    productType !== null
      ? (lookups?.productTypes.find((t) => t.id === productType)?.name ?? null)
      : null

  const count = selected.size
  const pageCount = Math.max(Math.ceil(total / PAGE_SIZE), 1)

  /* Empty means one of three things — say which, and offer the way out. */
  const empty = term.trim()
    ? {
        icon: <Icons.Search size={22} />,
        title: `Nothing matches “${term.trim()}”`,
        hint: 'Check the spelling, or search by code or barcode.',
        action: (
          <Button variant="secondary" onClick={() => setTerm('')}>
            Clear search
          </Button>
        ),
      }
    : departmentId !== null || productType !== null || conditions.length > 0
      ? {
          icon: <Icons.Filter size={22} />,
          title: 'No products match this filter',
          hint: 'Nothing on file fits the current slice.',
          action: (
            <Button variant="secondary" onClick={clearAllFilters}>
              Clear filters
            </Button>
          ),
        }
      : {
          icon: <Icons.Barcode size={22} />,
          title: 'No products yet',
          hint: 'Nothing has been added to the catalogue.',
        }

  function clearAllFilters() {
    setDepartmentId(null)
    setProductType(null)
    setConditions([])
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      /* A workspace, not a question: the grid, its toolbar, the chips and the
         pager have to be readable at once, and `full` caps at 1600px so the
         columns do not stretch into unreadable bands on a widescreen. */
      size="full"
      /* The body is a LAYOUT, not a document: a toolbar that stays put, a grid
         that scrolls, a pager pinned under it. That is what `bodyFills` is for,
         and `bodyTall` because the toolbar and pager spend a good part of 70vh
         on chrome before a single row is drawn.

         The measurement that settles it: DataTable caps its own scroll box to
         the room left inside its nearest scrolling ancestor, which here is the
         modal body. So the body's height IS the grid's height, and a body that
         sizes to its content (bodyGrows) hands the grid whatever eight rows
         happened to need — 402px of a 905px window, with the dialog ending
         200px above the fold. Filling gives the rows the screen. */
      bodyFills
      bodyTall
      /* Off: a selection built up across three searches is real work, and a
         stray click on the backdrop would throw it away. */
      closeOnBackdrop={false}
      footer={
        <>
          {/* The count is the whole reason this row exists when multi-select is
              on — it is the only place someone can see that the two things they
              ticked in Bakery are still ticked after searching "milk". */}
          {onPickMany && count > 0 && (
            <span className="mr-auto text-sm text-muted">
              <span className="numeric text-ink">{count}</span> selected
            </span>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {onPickMany && (
            <Button variant="primary" onClick={confirmMany} disabled={count === 0}>
              <Icons.Plus size={16} />
              {confirmLabel}
              {count > 0 ? ` ${count} product${count === 1 ? '' : 's'}` : ''}
            </Button>
          )}
        </>
      }
    >
      {/* A flex COLUMN with `min-h-0`, so the table below scrolls inside the
          body instead of growing past it and taking the footer off-screen. */}
      <div className="flex min-h-0 flex-col">
        {/* ── THE GAP UNDER THE CONTROLS ────────────────────────────────────
            `pb-3.5` and a rule, and NOT `inCard`.

            `inCard` is the right instinct — this toolbar IS a band directly
            above a table — but it carries `px-4` as well, and the Modal body
            already supplies its own `px-5` gutter. Taking both would indent
            the search box past the column headings underneath it, which is the
            misalignment `inCard` exists to prevent, arrived at from the other
            direction.

            So: the vertical half of it only. `pb-3.5` is TOOLBAR_IN_CARD's own
            figure rather than a number picked by eye, so the breathing room
            under these controls matches every other in-card toolbar in the
            app; the rule is what stops the row reading as a first table
            heading. Without either, the Filter button sat flush on the
            "Product / Department" header. */}
        <TableToolbar
          className="shrink-0 border-b border-border pb-3.5"
          actions={
            <ColumnPicker
              columns={lookups?.canSetColumns ? PRODUCT_SEARCH_COLUMNS : pickable}
              visible={visibleColumns}
              onChange={lookups?.canSetColumns ? saveColumnsForStore : prefs.setVisible}
              onReset={lookups?.canSetColumns ? undefined : prefs.reset}
              label={savingColumns ? 'Saving…' : 'Columns'}
            />
          }
          filters={
            <FilterBar inToolbar onClearAll={clearAllFilters}>
              {departmentLabel && (
                <FilterChip
                  label="Department"
                  value={departmentLabel}
                  onClear={() => setDepartmentId(null)}
                />
              )}
              {typeLabel && (
                <FilterChip label="Type" value={typeLabel} onClear={() => setProductType(null)} />
              )}
              {/* One chip per advanced condition, spelled out in words — the
                  only thing standing between a filter somebody set two searches
                  ago and "the catalogue has lost three thousand products". */}
              {conditions.map((condition, i) => (
                <FilterChip
                  key={`${condition.field}-${i}`}
                  label="Where"
                  value={summariseCondition(condition, filterFields)}
                  onClear={() => setConditions(conditions.filter((_, j) => j !== i))}
                />
              ))}
            </FilterBar>
          }
        >
          <div className="w-80 max-w-full">
            <Field label="Search" className="mb-0">
              <Input
                ref={searchRef}
                autoFocus
                value={term}
                placeholder="Description, code or barcode…"
                aria-label="Search products by description, code or barcode"
                icon={<Icons.Search size={15} />}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => {
                  /* Enter takes the first match, so a search that has already
                     narrowed to the right thing needs no reach for the mouse. */
                  if (e.key === 'Enter' && rows[0]) {
                    e.preventDefault()
                    pickOne(rows[0])
                  }
                }}
              />
            </Field>
          </div>

          <Field label="Department" className="mb-0 w-52">
            <Select
              value={departmentId ?? ''}
              aria-label="Filter products by department"
              onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">All departments</option>
              {(lookups?.departments ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Type" className="mb-0 w-44">
            <Select
              value={productType ?? ''}
              aria-label="Filter products by type"
              onChange={(e) => setProductType(e.target.value || null)}
            >
              <option value="">All types</option>
              {(lookups?.productTypes ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sort" className="mb-0 w-48">
            <Select
              value={`${sort.key}:${sort.direction}`}
              aria-label="Sort products"
              onChange={(e) => {
                const [key, direction] = e.target.value.split(':')
                setSort({ key, direction: direction === 'desc' ? 'desc' : 'asc' })
              }}
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>

          {/* Everything the toolbar cannot express, behind one button. Sits
              after the built-in pickers because it is the escape hatch from
              them, not a peer. Applying sets STATE here rather than
              navigating — see the note at the top of this file. */}
          {/* The kit's own offset, not a hand-typed margin: the Filter button
              carries no label, so in a row of labelled Fields it would sit a
              label's height too high. */}
          <div className={FIELD_CONTROL_OFFSET}>
            <AdvancedFilter
              fields={filterFields}
              value={conditions}
              onApply={(next) => setConditions(next)}
            />
          </div>
        </TableToolbar>

        {/* The grid's pane: a bounded flex child, and nothing more.
            No overflow rule of its own — DataTable is told to FILL this box
            (`fillHeight`), so its own scroll box is the only thing that
            scrolls. Wrapping it in a second scroller here nests two capped
            boxes that disagree; measured, that clipped the last row and a half
            with no scrollbar reaching them.

            `min-h-0` is load-bearing: a flex child will not shrink below its
            content without it, so the grid would push the pager and the footer
            off the panel. */}
        <div className="flex min-h-0 flex-1 flex-col">
          {loading && rows.length === 0 ? (
            /* A skeleton at the grid's real row height rather than a spinner:
               a spinner collapses the pane and then shoves it back down when
               the rows land, which on a dialog is the whole layout jumping. */
            <ProductGridSkeleton columns={columns.length} />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              getRowKey={(p) => p.id}
              /* Fit the PANE, not the window. The dialog body is a layout with
                 a pinned toolbar above and a pager below, so the room left on
                 screen is the wrong measurement — see the prop's own note. */
              fillHeight
              sort={sort as { key: string; direction: 'asc' | 'desc' }}
              onSortChange={(next) => setSort(next)}
              empty={empty}
              /* Only when the caller can USE a selection. A picker offering
                 tick boxes it will then ignore is worse than one that never
                 offered them. */
              selectedKeys={onPickMany ? selected : undefined}
              onSelectionChange={onPickMany ? changeSelection : undefined}
            />
          )}
        </div>

        {/* Stays put under the scrolling grid, so "of 3,214" is readable
            without scrolling to the bottom of the page you are on. */}
        <div className="shrink-0">
          <Pagination
            page={page}
            pageCount={pageCount}
            total={total}
            pageSize={PAGE_SIZE}
            onPage={setPage}
          />
        </div>
      </div>
    </Modal>
  )
}

/* ── Bits and pieces ─────────────────────────────────────────────────────── */

/** The columns `products.cost` gates. Never offered to a role without it. */
const COST_COLUMNS = new Set(['cost', 'costIncl', 'gpValue', 'gp'])

/**
 * The orderings, and the direction each should START in.
 *
 * The useful end of a column differs: a name is read A to Z, but "date created"
 * is asked to answer "what is new", which is the newest first. Only the four
 * the query can actually order by — a picker whose choice the SQL ignores is
 * worse than none.
 */
const SORT_OPTIONS = [
  { value: 'description:asc', label: 'Description (A–Z)' },
  { value: 'description:desc', label: 'Description (Z–A)' },
  { value: 'code:asc', label: 'Product code' },
  { value: 'created:desc', label: 'Newest first' },
  { value: 'edited:desc', label: 'Recently changed' },
]

/** A money cell: null is "not applicable", not zero. See ProductSearchRow. */
function money(value: number | null, format: (n: number) => string) {
  return value === null ? (
    <span className="text-faint">—</span>
  ) : (
    <span className="text-muted">{format(value)}</span>
  )
}

function qty(value: number | null) {
  return value === null ? (
    <span className="text-faint">—</span>
  ) : (
    <span className="text-muted">{formatQty(value)}</span>
  )
}

function date(value: string) {
  return value ? (
    <span className="text-muted">{value}</span>
  ) : (
    <span className="text-faint">—</span>
  )
}

/**
 * The grid's shape while the first page loads.
 *
 * At the table's real row height, so the pane does not collapse and then shove
 * itself back down when the rows arrive — which inside a dialog is the entire
 * layout jumping under the cursor.
 */
function ProductGridSkeleton({ columns }: { columns: number }) {
  return (
    <div className="px-4 py-3" aria-hidden>
      {Array.from({ length: 12 }).map((_, row) => (
        <div key={row} className="flex items-center gap-4 py-1.5">
          {Array.from({ length: Math.max(columns, 1) }).map((_, col) => (
            <div
              key={col}
              className="h-4 flex-1 animate-pulse rounded-control bg-surface-2"
              style={{ opacity: 1 - row * 0.06 }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
