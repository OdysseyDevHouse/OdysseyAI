'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  Icons,
  Input,
  TileGrid,
  ProductTile,
  EmptyState,
  Skeleton,
  toneForId,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { stockNote } from '@/lib/tillProductNotes'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { CatalogView } from './useSaleState'
import type { Department } from './types'
import { childDepartments, departmentTrail, hasChildren } from './saleSelectors'
import { useTileSizeValue } from '@/lib/posOffline/useTileSize'

/**
 * The right-hand pane: how a cashier finds a product that is not in their hand.
 *
 * Three states, one at a time — the quick keys (a later phase fills them), a
 * department drill, or search results. They share one grid recipe so the three
 * read as one surface rather than three screens that happen to be adjacent.
 *
 * ── WHY THE SEARCH BOX IS NOT A COMBOBOX ──────────────────────────────────
 *
 * The back office's Combobox drops a list over whatever is beneath it and needs a
 * second, precise tap to choose. On a till that list covers the basket, and the
 * second tap is the one that gets missed.
 *
 * So the field feeds the PANE instead of a dropdown. Results appear as you type,
 * in tiles big enough to hit, with the basket never covered. Enter (or Add) means
 * something different and more specific: resolve this as an exact code and put it
 * straight in the basket, which is what a scanner sends and what a cashier typing
 * a known PLU wants.
 */
export function CatalogPane({
  view,
  query,
  departments,
  results,
  searching,
  onQuery,
  onScan,
  onDrill,
  onDrillTo,
  onShowKeys,
  onPick,
  browse,
  quickKeys,
}: {
  view: CatalogView
  query: string
  departments: Department[]
  /** Search results, when the view is `search`. */
  results: TillProduct[]
  searching: boolean
  onQuery: (value: string) => void
  onScan: (code: string) => void
  onDrill: (departmentId: number) => void
  onDrillTo: (path: number[]) => void
  onShowKeys: () => void
  onPick: (product: TillProduct) => void
  /** Products directly in a department. Resolved by the shell. */
  browse: { loading: boolean; products: TillProduct[] }
  /**
   * The quick-key grid, already built.
   *
   * Passed as a NODE rather than as its data: the panel needs the runner, the operator
   * rights and half a dozen handlers, and threading all of that through this pane would
   * make it a conduit for state it has no use for. This pane owns the three-way switch
   * between keys, departments and results; what a key does is not its business.
   */
  quickKeys: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  // The scan field keeps focus so a scanner gun works with nobody touching the
  // screen. Re-focused whenever the view changes back to a browsing state, since
  // adding a product moves focus to the tile that was tapped.
  useEffect(() => {
    inputRef.current?.focus()
  }, [view.kind])

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {/* ── Scan / search ────────────────────────────────────────────────── */}
      <form
        className="flex shrink-0 items-center gap-2 border-b border-border bg-surface p-3"
        onSubmit={(e) => {
          e.preventDefault()
          const code = query.trim()
          if (!code) return
          // A barcode is resolved exactly and added straight to the basket; only
          // when nothing matches does it become a search. That ordering is what
          // makes a scanner feel instant.
          onScan(code)
        }}
      >
        <Input
          ref={inputRef}
          size="touch"
          className="flex-1"
          icon={<Icons.Search size={18} />}
          placeholder="Scan or search products"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          inputMode="search"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
        />
        {/* Results appear as you type, so this is not "search" — it is the
            explicit ADD for a code that is already exact, which is what a
            keyboard-driven cashier reaches for instead of Enter. */}
        <Button variant="ghost" size="touch" type="submit" disabled={!query.trim()}>
          <Icons.Plus size={18} />
          Add
        </Button>
      </form>

      {/* ── Breadcrumb ───────────────────────────────────────────────────── */}
      {view.kind !== 'keys' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3">
          <Button variant="ghost" size="sm" onClick={onShowKeys}>
            <Icons.ChevronLeft size={16} />
            Back
          </Button>
          {view.kind === 'search' ? (
            <span className="text-[13px] text-muted">
              Results for <span className="font-semibold text-ink">{view.term}</span>
            </span>
          ) : (
            <Trail departments={departments} path={view.path} onDrillTo={onDrillTo} />
          )}
        </div>
      )}

      {/* ── The grid ─────────────────────────────────────────────────────── */}
      <div className="till-pane flex-1 overflow-y-auto p-3">
        {view.kind === 'keys' && quickKeys}

        {view.kind === 'departments' && (
          <DepartmentLevel
            departments={departments}
            path={view.path}
            browse={browse}
            onDrill={onDrill}
            onPick={onPick}
          />
        )}

        {view.kind === 'search' && (
          <Results products={results} searching={searching} onPick={onPick} />
        )}
      </div>
    </section>
  )
}

/* ── Breadcrumb ──────────────────────────────────────────────────────────── */

function Trail({
  departments,
  path,
  onDrillTo,
}: {
  departments: Department[]
  path: number[]
  onDrillTo: (path: number[]) => void
}) {
  const trail = departmentTrail(departments, path)
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-[13px]">
      {trail.map((d, i) => {
        const last = i === trail.length - 1
        return (
          <span key={d.id} className="flex items-center gap-1">
            {i > 0 && <span className="text-faint">›</span>}
            {last ? (
              <span className="font-semibold text-ink">{d.name}</span>
            ) : (
              // Intermediate crumbs are tappable — walking back up one level is
              // far more common than starting over from the rail.
              <Button variant="bare" size="sm" onClick={() => onDrillTo(path.slice(0, i + 1))}>
                {d.name}
              </Button>
            )}
          </span>
        )
      })}
    </nav>
  )
}

/* ── One level of the department tree ────────────────────────────────────── */

function DepartmentLevel({
  departments,
  path,
  browse,
  onDrill,
  onPick,
}: {
  departments: Department[]
  path: number[]
  browse: { loading: boolean; products: TillProduct[] }
  onDrill: (id: number) => void
  onPick: (product: TillProduct) => void
}) {
  const current = path[path.length - 1] ?? null
  const tiles = useTileSizeValue()
  const children = childDepartments(departments, current)

  /*
   * A branch shows its SUB-DEPARTMENTS ONLY; a leaf shows products.
   *
   * browseProductsAction expands a department into its whole subtree, so showing
   * both here would put the sub-department tiles above every product beneath them
   * — the same item reachable two ways on one screen, which reads as duplication
   * and makes the tile grid enormous on a top-level department. Drilling to a leaf
   * is one extra tap and the grid stays comprehensible.
   */
  const showProducts = children.length === 0

  if (browse.loading && showProducts) return <TileSkeleton />

  if (showProducts && browse.products.length === 0 && !browse.loading) {
    return (
      <EmptyState
        icon={<Icons.Package size={28} />}
        title="Nothing in here yet"
        hint="This department has no products of its own."
      />
    )
  }

  return (
    <TileGrid tileWidth={tiles.width} tileHeight={tiles.height}>
      {children.map((d) => (
        <ProductTile
          key={`d${d.id}`}
          title={d.name}
          icon={<Icons.Tag size={20} />}
          tone={toneForId(d.id)}
          /* A chevron only where tapping really opens another level — on a leaf
             it promises a screen that never arrives. */
          chevron={hasChildren(departments, d.id)}
          onClick={() => onDrill(d.id)}
        />
      ))}
      {showProducts &&
        browse.products.map((p) => (
          <ProductTileFor key={`p${p.id}`} product={p} onPick={onPick} />
        ))}
    </TileGrid>
  )
}

/* ── Search results ──────────────────────────────────────────────────────── */

function Results({
  products,
  searching,
  onPick,
}: {
  products: TillProduct[]
  searching: boolean
  onPick: (product: TillProduct) => void
}) {
  const tiles = useTileSizeValue()
  if (searching && products.length === 0) return <TileSkeleton />
  if (products.length === 0) {
    return (
      <EmptyState
        icon={<Icons.Search size={28} />}
        title="Nothing found"
        hint="Check the spelling, or scan the barcode instead."
      />
    )
  }
  return (
    <TileGrid tileWidth={tiles.width} tileHeight={tiles.height}>
      {products.map((p) => (
        <ProductTileFor key={p.id} product={p} onPick={onPick} />
      ))}
    </TileGrid>
  )
}

/**
 * A product tile.
 *
 * The subtitle carries the STOCK note rather than the barcode, and that is a
 * deliberate swap from the reference POS: a cashier cannot do anything with a
 * barcode they can already scan, but "none on hand" is the thing they need to
 * know before promising it to a customer. `stockNote` is the same helper the
 * back-office till uses, so both screens phrase it identically.
 */
function ProductTileFor({
  product,
  onPick,
}: {
  product: TillProduct
  onPick: (product: TillProduct) => void
}) {
  const note = stockNote(product).replace(/^ · /, '')
  return (
    <ProductTile
      title={product.description}
      subtitle={note || product.code}
      price={formatMoney(product.priceIncl)}
      icon={<Icons.Package size={20} />}
      tone={toneForId(product.departmentId ?? product.id)}
      onClick={() => onPick(product)}
    />
  )
}

function TileSkeleton() {
  /* The same size as the real grid, deliberately: a skeleton at a different tile
     size makes every tile visibly jump the moment the products arrive. */
  const tiles = useTileSizeValue()
  return (
    <TileGrid tileWidth={tiles.width} tileHeight={tiles.height}>
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-full w-full rounded-card" />
      ))}
    </TileGrid>
  )
}
