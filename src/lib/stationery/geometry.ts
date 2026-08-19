import { alignmentFor, round2, type Guide, type Rect } from '../site/floorGeometry'

/**
 * The geometry a page of freely-placed blocks needs.
 *
 * ── ALMOST ALL OF IT IS ALREADY WRITTEN ───────────────────────────────────
 *
 * `lib/site/floorGeometry.ts` solved this for the restaurant floor plan and is
 * client-safe, so the snapping, the guides and the align/distribute toolkit are
 * imported rather than rewritten. Its header states the doctrine this screen
 * now follows too: free placement plus alignment guides, because "a grid
 * enforces neatness everywhere; guides offer it exactly where the user was
 * already aiming."
 *
 * This module is the thin layer where a DOCUMENT differs from a room.
 *
 * ── PERCENTAGES, NOT PIXELS ───────────────────────────────────────────────
 *
 * Everything stored is a percentage of the page width, or of the band. The floor
 * planner makes the same call for the same reason: a pointer delta arrives in
 * pixels and has to be divided by the live canvas width, and hard-coding a scale
 * is how a layout ends up correct on exactly one monitor. A stationery design
 * laid out on a laptop has to print the same from the counter machine.
 *
 * ── HEIGHT IS NOT STORED ──────────────────────────────────────────────────
 *
 * A block is as tall as its content: a letterhead with four contact lines is
 * taller than one with two, and a notes block is empty on most orders. Storing a
 * height would be storing a guess that goes stale the moment a field is added.
 * So `w` is a real decision and `h` is measured from the DOM when snapping needs
 * it — which is also why the canvas hands rects in rather than deriving them.
 */

/** Which part of the page a block belongs to. */
export const BAND_KEYS = ['header', 'body', 'footer'] as const
export type BandKey = (typeof BAND_KEYS)[number]

export const BAND_INFO: Record<BandKey, { label: string; hint: string }> = {
  header: {
    label: 'Top of the page',
    hint: 'Letterhead, the document title, who it is to. Placed freely.',
  },
  body: {
    label: 'The items',
    hint: 'Grows with the order, so nothing here is placed by hand.',
  },
  footer: {
    label: 'Below the items',
    hint: 'Totals, banking, notes, terms. Placed freely.',
  },
}

/** A block's box, as percentages. `h` is measured, never stored. */
export type BlockRect = { x: number; y: number; w: number }

/** The narrowest a block may be dragged. Below this nothing legible fits. */
export const MIN_BLOCK_W = 8

/**
 * How close two edges must be, in percent of the page, before they snap.
 *
 * Its own number rather than floorGeometry's fraction-of-the-room: a page is 100
 * percent wide however large it is drawn, so the fraction would resolve to 0.6 —
 * about five pixels on a 52rem page, tight enough that a designer aiming for an
 * edge misses it more often than not. 1.2 percent is roughly ten pixels, which is
 * the distance a pointer actually lands within.
 */
export const SNAP_TOLERANCE = 1.2

/**
 * Keep a block on the page.
 *
 * Its own clamp rather than floorGeometry's, which enforces a minimum HEIGHT as
 * well — a floor plan's tables have one and a document's blocks do not, since
 * their height is whatever their content needs.
 *
 * `y` is not clamped to a maximum: a band is as tall as its contents, so a block
 * dragged low simply makes the band taller. Clamping it would fight the thing
 * that makes the layout print correctly.
 */
export function clampBlock(r: BlockRect): BlockRect {
  const w = Math.min(Math.max(MIN_BLOCK_W, r.w), 100)
  return {
    x: round2(Math.min(Math.max(0, r.x), 100 - w)),
    y: round2(Math.max(0, r.y)),
    w: round2(w),
  }
}

/**
 * Snap a moving block against its neighbours and the page itself.
 *
 * A thin wrapper over `alignmentFor`, which already does the interesting part:
 * it snaps LEADING EDGE, CENTRE and TRAILING EDGE on both axes, and returns a
 * guide spanning both rects so the line reads as "these two line up" rather than
 * as a rule drawn across the whole page.
 *
 * The page's own margins and centre come free — `alignmentFor` includes the
 * container as a zero-thickness rect for exactly that, which is why "flush left"
 * and "centred on the page" need no special case here.
 */
export function snapBlock(
  moving: Rect,
  others: readonly Rect[],
  bandHeight: number,
): { x: number; y: number; guides: Guide[] } {
  return alignmentFor(moving, others, 100, Math.max(bandHeight, 1), SNAP_TOLERANCE)
}

/**
 * The nearest neighbour on each axis, and how far away it is.
 *
 * Shown while dragging, because "how much space is between these" is the
 * question a designer is actually asking when they nudge something — and a
 * number answers it far better than eyeballing two rectangles.
 *
 * Gaps are measured between FACING edges only. The distance from a block's left
 * edge to something further left is not a gap, it is an overlap, and reporting
 * it as spacing would be a lie.
 */
export type GapReading = { axis: 'x' | 'y'; distance: number; from: number; to: number }

export function gapsFor(moving: Rect, others: readonly Rect[]): GapReading[] {
  const out: GapReading[] = []

  let bestX: GapReading | null = null
  let bestY: GapReading | null = null

  for (const o of others) {
    // Horizontal, but only where the two actually overlap vertically —
    // otherwise "the gap" is between things that never sit beside each other.
    const overlapsY = moving.y < o.y + o.h && o.y < moving.y + moving.h
    if (overlapsY) {
      const right = o.x - (moving.x + moving.w)
      const left = moving.x - (o.x + o.w)
      const d = right >= 0 ? right : left >= 0 ? left : null
      if (d !== null && (!bestX || d < bestX.distance)) {
        bestX = {
          axis: 'x',
          distance: round2(d),
          from: right >= 0 ? moving.x + moving.w : o.x + o.w,
          to: right >= 0 ? o.x : moving.x,
        }
      }
    }

    const overlapsX = moving.x < o.x + o.w && o.x < moving.x + moving.w
    if (overlapsX) {
      const below = o.y - (moving.y + moving.h)
      const above = moving.y - (o.y + o.h)
      const d = below >= 0 ? below : above >= 0 ? above : null
      if (d !== null && (!bestY || d < bestY.distance)) {
        bestY = {
          axis: 'y',
          distance: round2(d),
          from: below >= 0 ? moving.y + moving.h : o.y + o.h,
          to: below >= 0 ? o.y : moving.y,
        }
      }
    }
  }

  if (bestX) out.push(bestX)
  if (bestY) out.push(bestY)
  return out
}

/**
 * Whether two blocks sit on top of each other.
 *
 * A document where two blocks overlap is one nobody can read, and unlike a
 * printed page a canvas makes it easy to do by accident. The validator refuses
 * it; this is the test it uses.
 *
 * A hair of tolerance, because two blocks snapped flush against each other share
 * an edge exactly and that is the arrangement the guides were encouraging.
 */
export function overlaps(a: Rect, b: Rect): boolean {
  const e = 0.01
  return (
    a.x + a.w - e > b.x && b.x + b.w - e > a.x && a.y + a.h - e > b.y && b.y + b.h - e > a.y
  )
}

export { round2, type Guide, type Rect }
