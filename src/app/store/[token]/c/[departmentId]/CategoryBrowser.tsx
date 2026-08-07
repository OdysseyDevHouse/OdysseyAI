'use client'

import { useMemo, useState } from 'react'
import { Button, EmptyState, Icons, Input } from '@/components/ui'
import type { StorefrontProduct } from '@/lib/site/storefront'
import ProductGrid, { type ProductListLayout } from '../../ProductGrid'

/**
 * Browsing one department.
 *
 * The page IS the filter, so there is no department picker here — only a
 * search box that narrows what is already on screen.
 *
 * Filtering happens in the browser over the products the server already sent,
 * with no debounce and no round trip. That is only honest because the whole
 * department is on the page: the moment this needed paging, a local filter
 * would start hiding matches that exist on a page nobody has loaded.
 */
export default function CategoryBrowser({
  token,
  departmentName,
  products,
  layout,
  showStock,
  showPhotos,
  showBrands,
}: {
  token: string
  departmentName: string
  products: StorefrontProduct[]
  layout: ProductListLayout
  showStock: boolean
  showPhotos: boolean
  showBrands: boolean
}) {
  const [query, setQuery] = useState('')

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return products
    // Name and code both: a shopper who knows what they want types the name,
    // and staff helping over the phone read out the code.
    return products.filter(
      (p) =>
        p.description.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.brand ?? '').toLowerCase().includes(q),
    )
  }, [products, query])

  return (
    <>
      <div className="mt-4">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search in ${departmentName}…`}
          aria-label={`Search in ${departmentName}`}
          icon={<Icons.Search size={15} />}
        />
      </div>

      <p className="mt-3 text-xs text-muted">
        {query.trim()
          ? `${visible.length} of ${products.length} products`
          : `${products.length} ${products.length === 1 ? 'product' : 'products'}`}
      </p>

      <div className="mt-3">
        {visible.length === 0 ? (
          <EmptyState
            icon={<Icons.Search size={22} />}
            title="Nothing matches that search"
            hint={`We couldn't find anything for “${query.trim()}” in ${departmentName}.`}
            action={
              <Button variant="secondary" onClick={() => setQuery('')}>
                Clear search
              </Button>
            }
          />
        ) : (
          <ProductGrid
            token={token}
            products={visible}
            layout={layout}
            showStock={showStock}
            showPhotos={showPhotos}
            showBrands={showBrands}
          />
        )}
      </div>
    </>
  )
}
