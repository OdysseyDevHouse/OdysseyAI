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
  toneForTileToken,
  departmentGlyph,
  productGlyph,
} from '@/components/ui'
import { formatMoney } from '@/lib/decimals'
import { stockNote } from '@/lib/tillProductNotes'
import type { TillProduct } from '@/lib/site/tillSearch'
import type { CatalogView } from './useSaleState'
import type { Department } from './types'
import {
  childDepartments,
  departmentTrail,
  departmentTallyNote,
  type DepartmentTally,
} from './saleSelectors'
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
  tallies,
  results,
  searching,
  onQuery,
  onScan,
  onDrill,
  onDrillTo,
  onShowKeys,
  onPick,
  onSizeTiles,
  priceFor,
  browse,
  quickKeys,
}: {
  view: CatalogView
  query: string
  departments: Department[]
  /**
   * What is behind each department — its sections and the products beneath
   * them — keyed by department id. Built once by the shell (departmentTallies)
   * and shared with the rail, so a tile and the row that opens it cannot show
   * different numbers.
   */
  tallies: Map<number, DepartmentTally>
  /** Search results, when the view is `search`. */
  results: TillProduct[]
  searching: boolean
  onQuery: (value: string) => void
  onScan: (code: string) => void
  onDrill: (departmentId: number) => void
  onDrillTo: (path: number[]) => void
  onShowKeys: () => void
  onPick: (product: TillProduct) => void
  /** Opens the tile-size dialog. Omitted where there is nothing to size. */
  onSizeTiles?: () => void
  /** What a product costs right now, scheduled changes included. See the tile. */
  priceFor: (product: TillProduct) => number
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
      {/* FLOATING, not a bordered strip. The catalogue column is the one that is
          not itself a card — its children are — so the search row lifts off the
          canvas on its own, the same way the grid below it does. */}
      <form
        className="flex shrink-0 items-center gap-2 pb-3"
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
          /* This field HOLDS focus by design (see the effect above), so the
             standard focus edge would glow all shift long — the quiet line keeps
             "scans land here" visible without out-shouting the basket. */
          quietFocus
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
            keyboard-driven cashier reaches for instead of Enter.

            PRIMARY, not ghost: it is the only filled control in this column, and
            a scanner-less till uses it on every line. */}
        <Button variant="primary" size="touch" type="submit" disabled={!query.trim()}>
          <Icons.Plus size={18} />
          Add
        </Button>

        {/* TILE SIZE, beside the grid it sizes.
            It used to live up in the status bar, a whole screen away from the
            tiles it changes — so setting it meant looking at one corner while the
            effect happened in another. Here it is the last control on the row
            above the grid, which is where the thing it affects begins. */}
        {onSizeTiles && (
          <Button
            variant="secondary"
            size="touch"
            iconOnly
            type="button"
            onClick={onSizeTiles}
            aria-label="Tile size"
            title="Tile size"
          >
            <Icons.SlidersHorizontal size={18} />
          </Button>
        )}
      </form>

      {/* ── Breadcrumb ───────────────────────────────────────────────────── */}
      {/* The way out USED to sit here as a small ghost button, above the grid.
          It now lives in the grid itself as the first tile, where the eye and
          the thumb already are — so the trail starts at the left edge of this
          row rather than after a control.

          Search keeps its button: those results are a flat list with no trail
          to walk and no Back tile in the grid, so removing it there would leave
          a cashier with no way back but the rail. */}
      {view.kind !== 'keys' && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">
          {view.kind === 'search' ? (
            <>
              <Button variant="ghost" size="sm" onClick={onShowKeys}>
                <Icons.ChevronLeft size={16} />
                Back to quick keys
              </Button>
              <span className="text-[13px] text-muted">
                Results for <span className="font-semibold text-ink">{view.term}</span>
              </span>
            </>
          ) : (
            <Trail departments={departments} path={view.path} onDrillTo={onDrillTo} />
          )}
        </div>
      )}

      {/* ── The grid ─────────────────────────────────────────────────────── */}
      {/* No left/top padding: the column is already inset by the shell's own p-4,
          and padding it again would step the tiles in from the search row above
          them. The right gutter is for the scrollbar. */}
      <div className="till-pane flex-1 overflow-y-auto pb-5 pr-1">
        {view.kind === 'keys' && quickKeys}

        {view.kind === 'departments' && (
          <DepartmentLevel
            departments={departments}
            tallies={tallies}
            path={view.path}
            browse={browse}
            onDrill={onDrill}
            onDrillTo={onDrillTo}
            onShowKeys={onShowKeys}
            onPick={onPick}
            priceFor={priceFor}
          />
        )}

        {view.kind === 'search' && (
          <Results products={results} searching={searching} onPick={onPick} priceFor={priceFor} />
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
  tallies,
  path,
  browse,
  onDrill,
  onDrillTo,
  onShowKeys,
  onPick,
  priceFor,
}: {
  departments: Department[]
  tallies: Map<number, DepartmentTally>
  path: number[]
  browse: { loading: boolean; products: TillProduct[] }
  onDrill: (id: number) => void
  onDrillTo: (path: number[]) => void
  onShowKeys: () => void
  onPick: (product: TillProduct) => void
  priceFor: (product: TillProduct) => number
}) {
  const current = path[path.length - 1] ?? null
  const tiles = useTileSizeValue()
  const children = childDepartments(departments, current)

  /*
   * The way out, as the first TILE in the grid — the only way out, now that the
   * ghost button above the grid is gone. It is always present, and where it goes
   * depends on how deep the cashier is:
   *
   *   INSIDE a sub-department  → the top department of the trail, in one tap
   *   AT the top of one        → out of the drill entirely, to the quick keys
   *
   * Returning to the MAJOR department rather than stepping up one level is the
   * deliberate part: a menu is walked downwards in one direction, and what a
   * cashier wants after finishing with a sub-department is the rest of that
   * department, not the intermediate level they passed through. The breadcrumb
   * still offers every intermediate level for the rarer case where one of them is
   * genuinely the target.
   *
   * Read off the TRAIL rather than the raw path: departmentTrail drops any id it
   * cannot resolve, so a path of two whose first department has since been deleted
   * is a trail of one — and taking path[0] there would point the tile at a
   * department that is no longer in the tree.
   */
  const trail = departmentTrail(departments, path)
  const root = trail.length > 1 ? trail[0] : null
  const back = root
    ? { title: 'Back', subtitle: root.name, onClick: () => onDrillTo([root.id]) }
    : /* No subtitle: the caption already names where it goes, and "Back / Quick
         keys" would say it twice. */
      { title: 'Back to quick keys', subtitle: undefined, onClick: onShowKeys }

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
    /* The Back tile comes WITH the empty state rather than instead of it. An
       empty department is the one screen where the way out matters most, and
       now that the ghost button above the grid is gone this tile is the only
       one — without it the cashier's sole escape is the rail. */
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={<Icons.Package size={28} />}
          title="Nothing in here yet"
          hint="This department has no products of its own."
        />
        <TileGrid tileWidth={tiles.width} tileHeight={tiles.height}>
          <BackTile back={back} tiles={tiles} />
        </TileGrid>
      </div>
    )
  }

  return (
    <TileGrid tileWidth={tiles.width} tileHeight={tiles.height}>
      {/* FIRST cell, so it holds the same corner of the grid at every depth —
          a cashier finds it by position rather than by reading it each time. */}
      <BackTile back={back} tiles={tiles} />
      {children.map((d) => (
        <ProductTile
          key={`d${d.id}`}
          title={d.name}
          /* What is in there — "54 products", or "2 sections · 306 products"
             where it has sub-departments. A cashier deciding whether a
             department is worth a tap can see the answer before spending it,
             and a department that has emptied out no longer looks identical to
             one holding three hundred lines.

             Empty string for a department with nothing in it, which
             ProductTile treats as no subtitle at all — a tile reading
             "0 products" states twice over what the empty grid behind it
             already says. Note that a SHORT tile drops the subtitle entirely
             (see isShortTile): at that height there is one line of room and
             the department's name has the better claim on it. */
          subtitle={departmentTallyNote(tallies.get(d.id))}
          /* The shop's own picture where it has set one, otherwise the tag glyph
             — the SAME call the rail makes for this department, so the row on the
             left and the tile here cannot show different things. */
          icon={departmentGlyph(d.id, d.posImageId, 20)}
          tone={toneForId(d.id)}
          /* The same tone the rail gives this department, so a sub-department tile
             and its row on the left are recognisably the same thing. */
          edge={toneForId(d.id)}
          /*
           * EVERY department tile, not only the ones with sub-departments.
           *
           * This used to be `hasChildren`, on the reasoning that a chevron on a
           * leaf promises a screen that never arrives. That was true when a tile
           * said nothing about itself — a leaf and a branch were the same button
           * and only the chevron distinguished them, so it had to carry that
           * meaning alone.
           *
           * The count beneath the name carries it now: "2 sections · 306
           * products" and "54 products" already say which kind of screen is
           * behind the tile, and say it more precisely than a chevron can. What
           * is left for the chevron is the thing that IS true of every one of
           * these tiles and not of the product tiles beside them in the same
           * grid: tapping it opens something rather than adding a line to the
           * basket. Half the department tiles wearing one made that read as an
           * inconsistency instead of a distinction.
           */
          chevron
          onClick={() => onDrill(d.id)}
        />
      ))}
      {showProducts &&
        browse.products.map((p) => (
          <ProductTileFor key={`p${p.id}`} product={p} onPick={onPick} priceFor={priceFor} />
        ))}
    </TileGrid>
  )
}

/**
 * The way out of the drill — the first cell of every department grid.
 *
 * Where it goes is decided by the caller (see `back` in DepartmentLevel): out to
 * the quick keys at the top of a department, back to the major department from
 * anywhere below it. One tile in one place doing whichever of those applies,
 * rather than a tile that appears at one depth and a button that appears at
 * another — a cashier learns the corner, not the rule.
 *
 * A ProductTile rather than a hand-rolled button: it sits in the same grid as the
 * departments and products around it, and anything else would be a differently
 * shaped card among them. DASHED, with a brand disc, matching the new-table
 * opener on the tables screen — the shared idiom for a tile that is a way out
 * rather than a thing to sell.
 */
function BackTile({
  back,
  tiles,
}: {
  back: { title: string; subtitle?: string; onClick: () => void }
  tiles: { width: number; height: number }
}) {
  return (
    <ProductTile
      title={back.title}
      /* Present only when it adds something: the department being returned to.
         At the top of a department the caption already names the destination. */
      subtitle={back.subtitle}
      icon={<Icons.Reverse size={20} />}
      dashed
      tileHeight={tiles.height}
      onClick={back.onClick}
    />
  )
}

/* ── Search results ──────────────────────────────────────────────────────── */

function Results({
  products,
  searching,
  onPick,
  priceFor,
}: {
  products: TillProduct[]
  searching: boolean
  onPick: (product: TillProduct) => void
  priceFor: (product: TillProduct) => number
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
        <ProductTileFor key={p.id} product={p} onPick={onPick} priceFor={priceFor} />
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
  priceFor,
}: {
  product: TillProduct
  onPick: (product: TillProduct) => void
  /**
   * The price after any scheduled change that is due.
   *
   * The tile must go through the same resolver the basket line does. Reading
   * product.priceIncl straight would show a tile at R10 that adds a line at
   * R12 the moment it is tapped, and the cashier has no way to tell which is
   * the real one.
   */
  priceFor: (product: TillProduct) => number
}) {
  const note = stockNote(product).replace(/^ · /, '')
  /*
   * The colour a manager PICKED for this product wins; otherwise the tile takes its
   * department's, derived.
   *
   * Stored colour is set on a handful of products out of tens of thousands, so using
   * it alone would leave a grid of grey-edged tiles with one coloured outlier — the
   * colour would read as "this one is special" rather than as a code. Falling back to
   * the department keeps the grid legible while still letting a shop override any
   * single product, which is what the picker is for.
   */
  const tone = toneForTileToken(product.imageColor) ?? toneForId(product.departmentId ?? product.id)
  return (
    <ProductTile
      title={product.description}
      subtitle={note || product.code}
      price={formatMoney(priceFor(product))}
      /* The product's own icon when a manager has uploaded one — the tile a
         cashier presses is then exactly what the menu designer previewed. It sits
         ON the tone rather than replacing it, so a transparent glyph keeps its
         background and the colour still codes the department. */
      icon={productGlyph(product.id, product.imageIcon)}
      tone={tone}
      edge={tone}
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
