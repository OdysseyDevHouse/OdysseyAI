'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Field, Input, Icons } from '@/components/ui'
import { MAX_SECTION_ITEMS } from '@/lib/storefrontModel'
import type { StorefrontProduct } from '@/lib/site/storefront'
import { searchProductsAction } from './actions'

/**
 * Choosing the exact products in a hand-picked row.
 *
 * ── WHY ORDER IS PART OF THE VALUE ───────────────────────────────────────
 *
 * The list is stored as an ordered array, not a set. An owner building a
 * "This week's specials" row is merchandising: the thing they most want sold
 * goes first. Sorting these by name on the way out would throw away the only
 * decision the owner actually made here.
 *
 * ── WHY IT SEARCHES THE SHOP, NOT THE PRODUCT TABLE ──────────────────────
 *
 * `searchProductsAction` runs the storefront's own query, so the picker can
 * only offer what a shopper could buy. Offering the whole product table would
 * let an owner pick a discontinued line and discover it was missing only by
 * looking at the live shop.
 */

export default function ProductPicker({
  value,
  onChange,
  onResolve,
}: {
  value: number[]
  onChange: (ids: number[]) => void
  /**
   * The picked products, in order, whenever we can name them all.
   *
   * Lets the canvas draw the row immediately instead of waiting for the
   * autosave and a server revalidate — the products are already here.
   */
  onResolve?: (products: StorefrontProduct[]) => void
}) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<StorefrontProduct[]>([])
  const [searching, setSearching] = useState(false)
  /**
   * Names for the picked ids.
   *
   * The layout stores ids only, so on first open we know WHAT is picked but
   * not what any of it is called. Kept as a map that only ever grows, so a
   * picked product's name survives the search results changing underneath it.
   */
  const [names, setNames] = useState<Map<number, StorefrontProduct>>(new Map())

  const learn = (products: StorefrontProduct[]) =>
    setNames((prev) => {
      const next = new Map(prev)
      for (const p of products) next.set(p.id, p)
      return next
    })

  /*
   * Resolve names for anything picked we cannot name yet.
   *
   * Runs on `value` rather than once on mount because selecting a different
   * section swaps the whole list out under us.
   */
  useEffect(() => {
    const unknown = value.filter((id) => !names.has(id))
    if (unknown.length === 0) return
    let live = true
    searchProductsAction('', unknown).then((products) => {
      if (live) learn(products)
    })
    return () => {
      live = false
    }
    // `names` is deliberately not a dependency: learn() writes to it, so
    // including it would re-run this effect with every resolution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  /*
   * Search as you type, debounced.
   *
   * The guard is a request SEQUENCE, not a boolean: server actions can settle
   * out of order, and without it a slow "co" landing after a fast "coffee"
   * would replace the right results with stale ones.
   */
  const seq = useRef(0)
  useEffect(() => {
    const query = term.trim()
    if (query.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    const mine = ++seq.current
    const timer = setTimeout(() => {
      searchProductsAction(query).then((products) => {
        if (mine !== seq.current) return
        learn(products)
        setResults(products)
        setSearching(false)
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [term])

  /*
   * Hand the resolved products up, in the owner's order.
   *
   * Only when EVERY pick is named. A partial list would flash a half-empty row
   * while the names for the rest were still in flight — the canvas already has
   * the server's copy to show until then, which is better than a flicker.
   */
  useEffect(() => {
    if (!onResolve) return
    const resolved = value.map((id) => names.get(id)).filter(Boolean) as StorefrontProduct[]
    if (resolved.length === value.length) onResolve(resolved)
  }, [value, names, onResolve])

  const full = value.length >= MAX_SECTION_ITEMS

  function add(product: StorefrontProduct) {
    if (value.includes(product.id) || full) return
    onChange([...value, product.id])
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index))
  }

  /** Move a pick one place. A splice, so the neighbour takes its old slot. */
  function move(index: number, direction: -1 | 1) {
    const to = index + direction
    if (to < 0 || to >= value.length) return
    const next = [...value]
    const [moved] = next.splice(index, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-3" data-product-picker>
      <Field
        label="Find products"
        hint={
          full
            ? `That is the most a row can hold (${MAX_SECTION_ITEMS}).`
            : 'Search by name or code, then click to add.'
        }
      >
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search products…"
          icon={<Icons.Search size={15} />}
          disabled={full}
        />
      </Field>

      {term.trim().length >= 2 && (
        <div className="rounded-card border border-border overflow-hidden">
          {searching ? (
            <p className="px-3 py-2.5 text-sm text-muted">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2.5 text-sm text-muted">
              Nothing published matching “{term.trim()}”.
            </p>
          ) : (
            <ul className="max-h-56 overflow-y-auto divide-y divide-border">
              {results.map((product) => {
                const already = value.includes(product.id)
                return (
                  <li key={product.id}>
                    {/* Not a kit Button: this is a full-width result row with
                        two stacked lines and a right-aligned price, which no
                        button variant expresses. */}
                    <button
                      type="button"
                      data-kit-ok
                      onClick={() => add(product)}
                      disabled={already || full}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-ink">
                          {product.description}
                        </span>
                        <span className="block truncate text-xs text-muted">{product.code}</span>
                      </span>
                      <span className="numeric text-sm text-ink-2">
                        {product.priceIncl.toFixed(2)}
                      </span>
                      <span className="text-xs text-muted">{already ? 'Added' : '+'}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {value.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing picked yet — this row will not show on your page until you add something.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {value.map((id, index) => {
            const product = names.get(id)
            return (
              <li
                key={id}
                className="flex items-center gap-2 rounded-control border border-border bg-surface px-2.5 py-1.5"
              >
                <span className="numeric w-5 shrink-0 text-xs text-muted">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {/* A pick whose product we cannot resolve is one that has
                      stopped being published. Say so — it is silently absent
                      from the shop, and this is the only place that shows it. */}
                  {product ? product.description : <span className="text-muted">No longer published</span>}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Move up"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <Icons.ChevronUp size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  iconOnly
                  aria-label="Move down"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <Icons.ChevronDown size={15} />
                </Button>
                <Button
                  variant="danger-ghost"
                  size="sm"
                  iconOnly
                  aria-label={`Remove ${product?.description ?? 'product'}`}
                  onClick={() => removeAt(index)}
                >
                  <Icons.Close size={15} />
                </Button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
