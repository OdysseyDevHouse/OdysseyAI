/**
 * Floor plan geometry — the maths a design tool needs, in room units.
 *
 * Client-safe: no server imports, so the designer and the till can both read it.
 * The database side stays in `posFloor.ts`, which is server-only.
 *
 * ── WHY UNITS AND NOT PIXELS ──────────────────────────────────────────────
 *
 * Everything here works in ROOM UNITS, the same `DECIMAL(7,2)` the schema stores.
 * The legacy designer worked in raw pixels, which reads as "pixel by pixel" but bakes
 * one monitor's size into the data — a plan drawn on a laptop then renders wrong on the
 * counter screen. Units with two decimals are FINER than pixels at any realistic room
 * size (a 100-unit room on a 1400px canvas puts one unit at 14px, so 0.01 units is a
 * seventh of a pixel), so nothing is lost by keeping them and the layout stays portable.
 *
 * ── TIDINESS COMES FROM GUIDES, NOT FROM A GRID ───────────────────────────
 *
 * The previous canvas rounded every drag to a whole unit, which is a ~1% lattice — that
 * is the coarseness that made it feel unlike a drawing tool. Free placement plus
 * alignment guides is the replacement: drag near another table's edge or centre and it
 * snaps, drawing the line that explains why. A grid enforces neatness everywhere; guides
 * offer it exactly where the user was already aiming.
 */

/** Smallest a table may be dragged, in room units. Below this the code won't fit. */
export const MIN_TABLE_SIZE = 3

/* ── What kind of table, and how many chairs ──────────────────────────────────
   A restaurant thinks in "a four-seater", not in width and height. Presets turn that
   into a sensible footprint so a table never needs reshaping by hand to look right —
   and it stays freely resizable afterwards, because a six-top against a wall wants to
   be long and narrow. */

export const TABLE_SHAPES = ['rect', 'round', 'oval', 'counter'] as const
export type TableShape = (typeof TABLE_SHAPES)[number]

/** Narrow an untrusted value to a shape. Anything unrecognised reads as a rectangle. */
export function cleanShape(raw: unknown): TableShape {
  const v = String(raw ?? '').trim().toLowerCase()
  return (TABLE_SHAPES as readonly string[]).includes(v) ? (v as TableShape) : 'rect'
}

export type SeatPreset = {
  seats: number
  label: string
  /** Default footprint in ROOM UNITS — the schema's default table is 8×8. */
  w: number
  h: number
  /** What a table this size usually is, so the picker can suggest a shape. */
  shape: TableShape
}

/**
 * The sizes a user picks from.
 *
 * In ROOM UNITS, unlike the pixel presets this was ported from: a room is 100 units
 * wide by default, so an 8-unit two-top is 8% of the floor and the same plan reads
 * correctly on a laptop and on a counter screen. Pixel presets would bake one monitor
 * into the data — the mistake `086_pos_floor_plan.sql` exists to avoid.
 */
export const SEAT_PRESETS: readonly SeatPreset[] = [
  { seats: 2, label: '2 seater', w: 8, h: 8, shape: 'round' },
  { seats: 4, label: '4 seater', w: 12, h: 8, shape: 'rect' },
  { seats: 6, label: '6 seater', w: 16, h: 8, shape: 'rect' },
  { seats: 8, label: '8 seater', w: 20, h: 12, shape: 'rect' },
]

export function presetForSeats(seats: number): SeatPreset {
  /* A four-top is the sane default for a count nobody drew a preset for. */
  return SEAT_PRESETS.find((p) => p.seats === seats) ?? SEAT_PRESETS[1]
}

/**
 * Where the chairs go for a table of `seats` at `w`×`h`.
 *
 * A table reads as a four-seater because you can SEE four chairs, not because it says
 * "4" underneath — that is the whole reason to draw a floor plan instead of listing
 * tables. Wide tables seat along the long edges, tall ones along the sides, and the
 * split favours top/bottom because that is how restaurant tables actually sit.
 *
 * Returns the count per edge; the renderer spaces them evenly.
 */
export function seatLayout(
  seats: number,
  w: number,
  h: number,
): { top: number; bottom: number; left: number; right: number } {
  const n = Math.max(0, Math.round(seats) || 0)
  if (n === 0) return { top: 0, bottom: 0, left: 0, right: 0 }

  /* A tall narrow table seats along its sides; anything else along top and bottom. */
  if (h > w) {
    const left = Math.ceil(n / 2)
    return { top: 0, bottom: 0, left, right: n - left }
  }
  /* Two seats on a roughly square table read better as one per side than two crammed
     onto one edge. */
  if (n === 2 && w < h * 1.4) return { top: 0, bottom: 0, left: 1, right: 1 }

  const top = Math.ceil(n / 2)
  return { top, bottom: n - top, left: 0, right: 0 }
}

/**
 * How close (in FRACTION OF THE ROOM) an edge must come before it snaps.
 *
 * Expressed as a fraction rather than in units so the snap feels the same on a 40-unit
 * cupboard of a room and a 400-unit hall — a fixed unit threshold would be an
 * unmissable magnet on the small one and imperceptible on the large one.
 */
export const SNAP_FRACTION = 0.006

/** Rotation detents, in degrees. Shift bypasses them for an arbitrary angle. */
export const ROTATE_DETENT = 15

export type Rect = { x: number; y: number; w: number; h: number }

/** A line to draw while dragging, in room units. */
export type Guide = {
  /** "v" = a vertical line at x; "h" = a horizontal line at y. */
  axis: 'v' | 'h'
  at: number
  /** Extent of the line, so it spans only the tables it relates. */
  from: number
  to: number
}

/** Geometry keyed by id — what align / match / distribute take and return. */
export type Placed = { id: string; x: number; y: number; w: number; h: number }

/** Round to 2dp, which is exactly what the DECIMAL(7,2) column stores. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Keep a rect inside the room and above a usable minimum size.
 *
 * The far edge is clamped, not just the origin — a table at x=98 in a 100-wide room
 * would otherwise hang off the canvas with only its left edge visible. Mirrors
 * `savePlacements`, so what the canvas draws is what the server will store.
 */
export function clampRect(r: Rect, roomW: number, roomH: number): Rect {
  const w = Math.min(Math.max(MIN_TABLE_SIZE, r.w), roomW)
  const h = Math.min(Math.max(MIN_TABLE_SIZE, r.h), roomH)
  return {
    x: round2(Math.min(Math.max(0, r.x), roomW - w)),
    y: round2(Math.min(Math.max(0, r.y), roomH - h)),
    w: round2(w),
    h: round2(h),
  }
}

/** Degrees, normalised to 0–359 — same rule the server applies on save. */
export function cleanRotation(raw: number): number {
  const n = Math.round(Number(raw) || 0)
  return ((n % 360) + 360) % 360
}

/* ── Alignment guides ─────────────────────────────────────────────────────── */

type Snap = {
  /** How far the rect must move along this axis to land on the guide. */
  shift: number
  /** Where the guide line sits, in room units. */
  at: number
  /** The rect it aligned to — the guide spans both. */
  other: Rect
}

/**
 * Best snap along one axis, or null when nothing is within reach.
 *
 * Considers leading edge, centre and trailing edge on both the moving rect and each
 * candidate — nine alignments per axis — and takes the closest inside the threshold.
 */
function bestSnap(
  movingEdges: readonly number[],
  movingOrigin: number,
  size: number,
  others: readonly Rect[],
  edgesOf: (r: Rect) => number[],
  tolerance: number,
): Snap | null {
  let best: Snap | null = null
  for (const other of others) {
    for (const target of edgesOf(other)) {
      movingEdges.forEach((edge, index) => {
        if (Math.abs(target - edge) > tolerance) return
        /* Which of the three edges snapped decides how the origin moves:
           0 = leading edge, 1 = centre, 2 = trailing edge. */
        const originShift = index === 0 ? 0 : index === 1 ? size / 2 : size
        const shift = target - originShift - movingOrigin
        if (!best || Math.abs(shift) < Math.abs(best.shift)) {
          best = { shift, at: target, other }
        }
      })
    }
  }
  return best
}

/**
 * Snap `moving` against `others` and the room's own edges and centrelines, returning
 * the adjusted position plus the guides to draw.
 *
 * The ROOM is included as a snap target because "flush against the wall" and "centred in
 * the room" are the two things a manager most often means, and neither is expressible by
 * snapping to another table.
 */
export function alignmentFor(
  moving: Rect,
  others: readonly Rect[],
  roomW: number,
  roomH: number,
  /**
   * How close an edge must come, in the same units as the rects.
   *
   * Defaults to a fraction of the room, which is right for a floor plan. The
   * stationery designer passes its own: its "room" is 100 percent wide either
   * way, so the fraction would give one fixed tolerance regardless of how large
   * the page is drawn on screen, and on a page a percent of width is only a few
   * pixels — tight enough to feel fussy rather than helpful.
   */
  tolerance = Math.max(roomW, roomH) * SNAP_FRACTION,
): { x: number; y: number; guides: Guide[] } {
  const xEdges = (r: Rect) => [r.x, r.x + r.w / 2, r.x + r.w]
  const yEdges = (r: Rect) => [r.y, r.y + r.h / 2, r.y + r.h]

  /* The room as a zero-thickness rect gives left/centre/right and top/middle/bottom for
     free, using the very same edge functions. */
  const room: Rect = { x: 0, y: 0, w: roomW, h: roomH }
  const targets = [...others, room]

  const sx = bestSnap(xEdges(moving), moving.x, moving.w, targets, xEdges, tolerance)
  const sy = bestSnap(yEdges(moving), moving.y, moving.h, targets, yEdges, tolerance)

  const x = round2(moving.x + (sx?.shift ?? 0))
  const y = round2(moving.y + (sy?.shift ?? 0))

  /* A guide spans both rects, so it reads as "these two line up" rather than as a rule
     drawn across the whole floor. */
  const guides: Guide[] = []
  if (sx) {
    guides.push({
      axis: 'v',
      at: sx.at,
      from: Math.min(y, sx.other.y),
      to: Math.max(y + moving.h, sx.other.y + sx.other.h),
    })
  }
  if (sy) {
    guides.push({
      axis: 'h',
      at: sy.at,
      from: Math.min(x, sy.other.x),
      to: Math.max(x + moving.w, sy.other.x + sy.other.w),
    })
  }
  return { x, y, guides }
}

/* ── Align, match and distribute ──────────────────────────────────────────────
   The design-tool toolkit, and the reason multi-select earns its keep: laying out a bank
   of six tables by eye is fiddly and never quite lands, whereas "make these the same
   size, align their tops, space them evenly" is three clicks and exact.

   THE REFERENCE IS THE FIRST-SELECTED ITEM, not the largest or the leftmost. That is
   what Figma, Keynote and PowerPoint all do, and it is the only rule that lets the user
   DECIDE the outcome rather than have it inferred: click the table you want everything
   to match, then add the others. */

export type AlignMode = 'left' | 'hcentre' | 'right' | 'top' | 'vmiddle' | 'bottom'
export type MatchMode = 'width' | 'height'
export type DistributeMode = 'horizontal' | 'vertical'

/**
 * Align `items` to the first one.
 *
 * Only x/y move; sizes are untouched, because an "align" that also resized would
 * surprise anyone who has used another design tool.
 */
export function alignTo(items: readonly Placed[], mode: AlignMode): Placed[] {
  if (items.length < 2) return items.map((i) => ({ ...i }))
  const ref = items[0]
  return items.map((it, index) => {
    if (index === 0) return { ...it }
    switch (mode) {
      case 'left':
        return { ...it, x: ref.x }
      case 'right':
        return { ...it, x: round2(ref.x + ref.w - it.w) }
      case 'hcentre':
        return { ...it, x: round2(ref.x + ref.w / 2 - it.w / 2) }
      case 'top':
        return { ...it, y: ref.y }
      case 'bottom':
        return { ...it, y: round2(ref.y + ref.h - it.h) }
      case 'vmiddle':
        return { ...it, y: round2(ref.y + ref.h / 2 - it.h / 2) }
    }
  })
}

/**
 * Resize `items` to match the first one.
 *
 * Grows from the top-left (x/y stay put) rather than from the centre. Tables are placed
 * by their corner against walls and neighbours, so keeping that corner fixed is the
 * behaviour that does not disturb a layout already arranged.
 */
export function matchSize(items: readonly Placed[], mode: MatchMode): Placed[] {
  if (items.length < 2) return items.map((i) => ({ ...i }))
  const ref = items[0]
  return items.map((it, index) => {
    if (index === 0) return { ...it }
    return {
      ...it,
      w: mode === 'width' ? ref.w : it.w,
      h: mode === 'height' ? ref.h : it.h,
    }
  })
}

/**
 * Space `items` evenly between the two outermost ones.
 *
 * The ends stay put and everything between is spread at equal GAPS — equal edge-to-edge
 * space, not equal centre-to-centre. With mixed table sizes those differ, and equal gaps
 * is what actually looks right in a room: a walkway between tables should be the same
 * width whether the tables either side are two-tops or six-tops.
 *
 * Unlike align and match this ignores the reference: "evenly spaced" is a property of
 * the whole set, so picking one member to measure from would mean nothing.
 */
export function distribute(items: readonly Placed[], mode: DistributeMode): Placed[] {
  if (items.length < 3) return items.map((i) => ({ ...i }))
  const horizontal = mode === 'horizontal'
  const size = (p: Placed) => (horizontal ? p.w : p.h)
  const pos = (p: Placed) => (horizontal ? p.x : p.y)

  /* Worked in visual order, then written back onto the caller's list so their ordering
     (and therefore the reference) survives. */
  const order = [...items].sort((a, b) => pos(a) - pos(b))
  const first = order[0]
  const last = order[order.length - 1]
  const span = pos(last) + size(last) - pos(first)
  const used = order.reduce((sum, p) => sum + size(p), 0)
  /* A negative gap means the tables already overlap more than the span allows; clamping
     at 0 stacks them edge to edge rather than inverting the order. */
  const gap = Math.max(0, (span - used) / (order.length - 1))

  const moved = new Map<string, number>()
  let cursor = pos(first)
  for (const p of order) {
    moved.set(p.id, round2(cursor))
    cursor += size(p) + gap
  }
  return items.map((it) => {
    const at = moved.get(it.id)
    if (at === undefined) return { ...it }
    return horizontal ? { ...it, x: at } : { ...it, y: at }
  })
}

/**
 * Somewhere to drop a new table that is not on top of an existing one.
 *
 * Steps in coarse strides rather than unit-by-unit — this only needs somewhere sensible,
 * and the user drags it where they actually want it. Dropping every new table at the
 * same spot and leaving them to untangle the pile is the kind of thing that makes a tool
 * feel unfinished.
 */
export function firstFreeSlot(
  taken: readonly Rect[],
  w: number,
  h: number,
  roomW: number,
  roomH: number,
): { x: number; y: number } {
  const gap = Math.max(1, Math.min(roomW, roomH) * 0.02)
  const step = Math.max(1, Math.min(roomW, roomH) * 0.04)
  const hits = (x: number, y: number) =>
    taken.some(
      (t) =>
        x < t.x + t.w + gap && x + w + gap > t.x && y < t.y + t.h + gap && y + h + gap > t.y,
    )
  for (let y = gap; y + h <= roomH - gap; y += step) {
    for (let x = gap; x + w <= roomW - gap; x += step) {
      if (!hits(x, y)) return { x: round2(x), y: round2(y) }
    }
  }
  return { x: round2(gap), y: round2(gap) }
}
