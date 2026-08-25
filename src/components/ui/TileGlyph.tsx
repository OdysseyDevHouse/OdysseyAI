'use client'

import type { ReactNode } from 'react'
import { Tag, Package } from './icons'

/**
 * The picture a shop uploaded for a tile, sized to sit in the tinted disc.
 *
 * ── WHY THIS IS A KIT COMPONENT AND NOT AN INLINE <img> ─────────────────
 *
 * Three screens draw the same tile and must agree about it: the till's
 * department rail, the till's catalogue grid, and the menu designer — which
 * promises "what a cashier sees" and is only telling the truth while it draws
 * what the till draws. Written inline, the three were already drifting: the
 * designer showed a product's uploaded icon and the till showed a box glyph for
 * the same product, so the preview and the counter disagreed about the thing the
 * preview exists to show.
 *
 * ── WHY NOT ProductTile's `image` PROP ──────────────────────────────────
 *
 * `image` draws a bordered, object-cover thumbnail. That is right for a product
 * PHOTOGRAPH — a picture OF a thing, which should fill its frame. These are
 * ICONS: usually a symbol on a transparent ground, chosen to read at 40px across
 * a counter. Cover-cropping one clips its edges, and the border draws a box
 * around a symbol meant to sit ON the disc.
 *
 * Passed as the `icon` instead, the picture lands inside CategoryTile's disc, so
 * a transparent glyph keeps the tone behind it — the colour still codes the
 * department — and an opaque one simply covers it.
 */
export function TileGlyph({
  /** Where the picture is served from. A 404 here is a normal state, not a fault. */
  src,
  /** Drawn when there is no picture, which is the case for most tiles. */
  fallback,
}: {
  src: string | null
  fallback: ReactNode
}) {
  if (!src) return <>{fallback}</>
  /* object-contain, not cover: an icon wider than it is tall must be shown whole.
     p-0.5 keeps a square picture off the disc's rounded corner.
     alt="" — the tile already carries the name as text beside the disc, and a
     filled alt would have a screen reader say it twice. */
  return <img src={src} alt="" className="size-full object-contain p-0.5" />
}

/**
 * The disc contents for a DEPARTMENT tile — its picture, or the tag glyph.
 *
 * Takes the id and a flag rather than a URL so every caller addresses the same
 * route; a URL built at each call site is a fourth place for the three screens to
 * disagree. `hasPicture` is `posImageId !== null` at every caller — passed as the
 * id itself where one is held, since the tile only ever reads it as yes or no.
 */
export function departmentGlyph(
  departmentId: number,
  posImageId: number | null,
  size = 18,
): ReactNode {
  return (
    <TileGlyph
      src={posImageId === null ? null : `/api/department-image/${departmentId}`}
      fallback={<Tag size={size} />}
    />
  )
}

/**
 * The disc contents for a PRODUCT tile — its uploaded icon, or the package glyph.
 *
 * Keyed by the product id because that is how the icon is served: there is
 * exactly one per product, stored as a name on the product row rather than as a
 * row in product_images. The stored name is only ever read as yes-or-no, so an
 * empty string counts as none — a cleared upload can leave one behind, and a tile
 * treating '' as "there is a picture" would draw a broken image on every product
 * that once had an icon.
 */
export function productGlyph(
  productId: number,
  imageIcon: string | null,
  size = 20,
): ReactNode {
  return (
    <TileGlyph
      src={imageIcon ? `/api/product-icon/${productId}` : null}
      fallback={<Package size={size} />}
    />
  )
}
