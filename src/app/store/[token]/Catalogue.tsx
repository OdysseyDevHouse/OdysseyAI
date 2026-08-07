'use client'

import { useMemo, useState } from 'react'
import { Button, Checkbox, EmptyState, Icons, Select } from '@/components/ui'
import type { StorefrontProduct } from '@/lib/site/storefront'
import ProductGrid, { type ProductListLayout } from './ProductGrid'

/**
 * The whole shop, with filters.
 *
 * ── FILTERS ARE LOCAL, THE SEARCH IS NOT ─────────────────────────────────
 *
 * The search term lives in the URL because it decides which products the
 * SERVER sends, and because a search is the thing a shopper shares or reloads.
 * Brand, specials, stock and sort narrow what is already here, so they stay in
 * component state — putting them in the URL would mean a navigation, a server
 * round trip and a scroll jump for a checkbox that filters rows already
 * rendered.
 *
 * ── FACET COUNTS ARE OF EVERYTHING, NOT OF WHAT SURVIVED ─────────────────
 *
 * Ticking "Ceres" must not make every other brand read "(0)". The counts
 * answer "what else could I look at", which is only useful if they ignore the
 * filter the shopper is currently applying.
 */

const PAGE_SIZE = 24

const SORTS = {
  popular: 'Featured',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  name: 'Name A–Z',
} as const

type SortKey = keyof typeof SORTS

export default function Catalogue({
  token,
  products,
  layout,
  showStock,
  showPhotos,
  showBrands,
  query,
}: {
  token: string
  products: StorefrontProduct[]
  layout: ProductListLayout
  showStock: boolean
  showPhotos: boolean
  showBrands: boolean
  /** Only for the empty state's wording — the filtering already happened. */
  query: string
}) {
  const [brands, setBrands] = useState<string[]>([])
  const [onSpecial, setOnSpecial] = useState(false)
  const [inStockOnly, setInStockOnly] = useState(false)
  const [sort, setSort] = useState<SortKey>('popular')
  const [shown, setShown] = useState(PAGE_SIZE)
  const [filtersOpen, setFiltersOpen] = useState(false)

  /* Counted over the FULL list — see the note at the top. */
  const brandFacets = useMemo(() => {
    if (!showBrands) return []
    const counts = new Map<string, number>()
    for (const p of products) {
      if (!p.brand) continue
      counts.set(p.brand, (counts.get(p.brand) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [products, showBrands])

  const specialCount = useMemo(
    () => products.filter((p) => p.wasPriceIncl !== null).length,
    [products],
  )
  // Zero when the shop does not publish stock, which removes the facet
  // entirely rather than offering a filter that cannot do anything.
  const inStockCount = useMemo(
    () => (showStock ? products.filter((p) => p.inStock).length : 0),
    [products, showStock],
  )

  const visible = useMemo(() => {
    let out = products
    if (brands.length > 0) out = out.filter((p) => p.brand && brands.includes(p.brand))
    if (onSpecial) out = out.filter((p) => p.wasPriceIncl !== null)
    if (inStockOnly) out = out.filter((p) => p.inStock)

    /*
     * Every sort copies the array first. `Array.prototype.sort` is in place and
     * would otherwise reorder the props — and it is stable, which is what lets
     * "Featured" float specials up while everything below keeps the
     * catalogue's own order.
     */
    if (sort === 'price_asc') out = [...out].sort((a, b) => a.priceIncl - b.priceIncl)
    else if (sort === 'price_desc') out = [...out].sort((a, b) => b.priceIncl - a.priceIncl)
    else if (sort === 'name') out = [...out].sort((a, b) => a.description.localeCompare(b.description))
    else if (sort === 'popular') {
      out = [...out].sort(
        (a, b) => Number(b.wasPriceIncl !== null) - Number(a.wasPriceIncl !== null),
      )
    }
    return out
  }, [products, brands, onSpecial, inStockOnly, sort])

  const filtered = brands.length > 0 || onSpecial || inStockOnly
  const showRail = brandFacets.length > 0 || specialCount > 0 || inStockCount > 0

  /** Any change to WHAT is shown starts again from the first page. */
  function narrow(fn: () => void) {
    fn()
    setShown(PAGE_SIZE)
  }

  function clearAll() {
    narrow(() => {
      setBrands([])
      setOnSpecial(false)
      setInStockOnly(false)
    })
  }

  const rail = (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold text-ink">Filters</span>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={clearAll}>
            Clear all
          </Button>
        )}
      </div>

      {brandFacets.length > 0 && (
        <FilterGroup title="Brand">
          {brandFacets.map((b) => (
            <Checkbox
              key={b.name}
              checked={brands.includes(b.name)}
              onChange={(e) => {
                const on = e.target.checked
                narrow(() =>
                  setBrands((prev) =>
                    on ? [...prev, b.name] : prev.filter((x) => x !== b.name),
                  ),
                )
              }}
              label={`${b.name} (${b.count})`}
            />
          ))}
        </FilterGroup>
      )}

      {specialCount > 0 && (
        <FilterGroup title="Specials">
          <Checkbox
            checked={onSpecial}
            onChange={(e) => narrow(() => setOnSpecial(e.target.checked))}
            label={`On special (${specialCount})`}
          />
        </FilterGroup>
      )}

      {inStockCount > 0 && (
        <FilterGroup title="Availability">
          <Checkbox
            checked={inStockOnly}
            onChange={(e) => narrow(() => setInStockOnly(e.target.checked))}
            label={`In stock only (${inStockCount})`}
          />
        </FilterGroup>
      )}
    </div>
  )

  return (
    <div className={showRail ? 'flex gap-6' : ''}>
      {showRail && (
        <aside className="hidden w-56 shrink-0 lg:block">
          <div className="sticky top-32 rounded-card border border-border bg-surface p-4">
            {rail}
          </div>
        </aside>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            {visible.length === 0
              ? 'No products'
              : `Showing ${Math.min(shown, visible.length)} of ${visible.length} products`}
          </p>

          <div className="flex items-center gap-2">
            {/* Only on small screens: the rail beside the results is always
                visible on a wide one, so a toggle there would be a button
                that appears to do nothing. */}
            {showRail && (
              <Button
                variant="ghost"
                size="sm"
                className="lg:hidden"
                onClick={() => setFiltersOpen((o) => !o)}
              >
                <Icons.Filter size={15} />
                {filtered ? 'Filters applied' : 'Filters'}
              </Button>
            )}
            <label className="flex items-center gap-2 text-sm text-muted">
              Sort by
              <Select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-control-sm w-auto"
                aria-label="Sort products"
              >
                {Object.entries(SORTS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </div>

        {/* An inline disclosure rather than a drawer: it keeps the results in
            view while the filter is being changed, so a shopper can see the
            list shrink as they tick. */}
        {showRail && filtersOpen && (
          <div className="mt-3 rounded-card border border-border bg-surface p-4 lg:hidden">
            {rail}
          </div>
        )}

        <div className="mt-4">
          {visible.length === 0 ? (
            <EmptyState
              icon={<Icons.Package size={22} />}
              title={filtered ? 'Nothing matches those filters' : 'Nothing here yet'}
              hint={
                query.trim()
                  ? `We couldn't find anything for “${query.trim()}”.`
                  : filtered
                    ? 'Try removing a filter to see more.'
                    : 'This shop has not published anything to order online yet.'
              }
              action={
                filtered ? (
                  <Button variant="secondary" onClick={clearAll}>
                    Clear all filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ProductGrid
              token={token}
              products={visible.slice(0, shown)}
              layout={layout}
              showStock={showStock}
              showPhotos={showPhotos}
              showBrands={showBrands}
            />
          )}
        </div>

        {/* A button rather than infinite scroll, so the footer stays reachable
            and coming back from a product page does not lose your place. */}
        {shown < visible.length && (
          <div className="mt-5 text-center">
            <Button variant="secondary" onClick={() => setShown((s) => s + PAGE_SIZE)}>
              Load more products ({visible.length - shown} left)
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-ink">{title}</p>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  )
}
