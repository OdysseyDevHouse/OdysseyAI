'use client'

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { FeatureGlyph, TableGlyph } from '@/components/ui'
import type { FloorRoom, FloorFeature } from '@/lib/site/posFloor'
import type { PosTable } from '@/lib/site/posTables'
import {
  MIN_TABLE_SIZE,
  ROTATE_DETENT,
  alignmentFor,
  clampRect,
  cleanRotation,
  round2,
  seatLayout,
  type Guide,
  type Rect,
  type TableShape,
} from '@/lib/site/floorGeometry'
import { useFloorViewport } from '@/lib/site/useFloorViewport'
import type { Geometry, GeometryChange } from './useFloorHistory'

/**
 * The floor-plan canvas: free placement, drag-resize, drag-rotate, multi-select.
 *
 * ── WHY NOT dnd-kit, WHICH THIS REPLACED ──────────────────────────────────
 *
 * dnd-kit is built to answer "what did you drop this ON" — it tracks droppables, computes
 * collisions and hands back a pixel delta at the end of a gesture. A floor plan asks none
 * of that: there is no drop target, only x and y, and what the tool needs is CONTINUOUS
 * geometry while the pointer moves so a table can snap to its neighbour and draw the line
 * explaining why. Getting that out of dnd-kit meant reading `delta` on every move and
 * re-deriving position anyway, and it still could not express resize or rotate — those
 * were reduced to +/- stepper buttons, which is what made this screen feel like a form
 * for entering coordinates rather than a tool for drawing a room.
 *
 * Its drag threshold and touch handling came free, so this file is the cost of dropping
 * it — paid deliberately, and paid once.
 *
 * ── POINTER EVENTS, NOT MOUSE ─────────────────────────────────────────────
 *
 * Tills are touchscreens. Pointer events cover finger, stylus and the resistive panels
 * whose drivers only emulate a mouse, in one set of handlers. Capture lives on the
 * CANVAS, never on a tile or a handle: a rotating tile carries its handles around with
 * it, so a handle would spin out from under the pointer and the gesture would die
 * halfway through.
 *
 * ── UNITS IN, PERCENTAGES OUT ─────────────────────────────────────────────
 *
 * Everything stored is in room units; everything rendered is a percentage of the canvas.
 * That one conversion is why a layout built on a laptop reads on a counter screen — and
 * it is why the canvas measures itself rather than assuming a size: a pointer delta
 * arrives in PIXELS and has to be divided by the live pixel width to become units.
 * Hard-coding a scale is how a plan ends up correct on exactly one monitor.
 *
 * ── NOTHING SAVES UNTIL SAVE ──────────────────────────────────────────────
 *
 * Every gesture edits local state. A manager rearranging a room is exploring, and a
 * canvas that wrote each nudge to the database would turn one reorganisation into forty
 * round trips and leave a half-moved floor behind if the tab closed.
 */

/** Everything the canvas can move, table or feature, in one shape. */
type Item = {
  /** `t12` for a table, `f3` for a feature — one selection across both. */
  key: string
  kind: 'table' | 'feature'
  label: string
  /** Seats, for a table; the feature kind, for furniture. */
  sub: string
  /** How many chairs to draw. Absent on furniture, which seats nobody. */
  seats?: number
  geo: Geometry
  featureKind?: FloorFeature['kind']
}

type Mode = 'move' | 'resize' | 'rotate' | 'marquee'

type DragState = {
  mode: Mode
  /** Every item this gesture moves — one, or the whole selection. */
  keys: string[]
  pointerId: number
  /** Pointer origin in CANVAS UNITS, so a scroll mid-drag cannot skew the delta. */
  startX: number
  startY: number
  /** Geometry of each dragged item when the gesture began. */
  origin: Map<string, Geometry>
  /** Rotation pivot and starting angle (single-item gestures only). */
  cx: number
  cy: number
  startAngle: number
  moved: boolean
}

export type Placement = Pick<
  PosTable,
  'id' | 'roomId' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'shape'
>

export function placementOf(table: PosTable): Placement {
  return {
    id: table.id,
    roomId: table.roomId,
    x: table.x,
    y: table.y,
    width: table.width,
    height: table.height,
    rotation: table.rotation,
    shape: table.shape,
  }
}

export function FloorCanvas({
  room,
  tables,
  placements,
  features,
  editing,
  selectedKeys,
  onSelectionChange,
  onCommit,
  onOpenItem,
  tall = false,
}: {
  room: FloorRoom
  tables: PosTable[]
  placements: Map<number, Placement>
  features: FloorFeature[]
  /** Out of edit mode nothing drags — see FloorDesigner's note on the toggle. */
  editing: boolean
  selectedKeys: string[]
  onSelectionChange: (keys: string[]) => void
  /** Called once, on release, with every item the gesture changed. */
  onCommit: (changes: GeometryChange[]) => void
  /** A click on an item while NOT editing. */
  onOpenItem: (key: string) => void
  /** Give the canvas more height — set by the full-screen shell. */
  tall?: boolean
}) {
  /*
   * Pan and pinch — the same hook the till uses, so the gesture is identical on both.
   *
   * DISABLED IN EDIT MODE. There, a drag on the floor draws a marquee and a drag on a
   * tile moves it; letting the viewport also claim the gesture is how a canvas ends up
   * fighting the user. Out of edit mode nothing else wants a drag, so panning is free.
   * The zoom buttons work in both.
   */
  const viewport = useFloorViewport({
    enabled: !editing,
    /*
     * Ctrl (or Cmd) + drag pans while EDITING.
     *
     * Without it, working zoomed in meant leaving edit mode to move the floor and coming
     * back — for every corner of a big room. The modifier is what separates the two
     * gestures: plain drag still moves a table or draws a marquee, and holding Ctrl says
     * "move the floor instead".
     *
     * Ctrl+click on a TILE still adds to the selection — see `begin`, which runs first
     * and does not let the press reach here.
     */
    panWith: (e) => editing && (e.ctrlKey || e.metaKey),
  })

  /* SVG ids are document-global, and the till renders a canvas of its own — two grids
     sharing one id means the second points at whichever pattern rendered last. */
  const gridId = useId().replace(/:/g, '')

  const surfaceRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)
  const [preview, setPreview] = useState<Record<string, Geometry>>({})
  const [guides, setGuides] = useState<Guide[]>([])
  const [marquee, setMarquee] = useState<Rect | null>(null)

  const selected = useMemo(() => new Set(selectedKeys), [selectedKeys])

  /** Every draggable thing in this room, tables and furniture alike. */
  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const feature of features) {
      if (feature.roomId !== room.id) continue
      out.push({
        key: `f${feature.id}`,
        kind: 'feature',
        label: feature.label,
        sub: feature.kind,
        featureKind: feature.kind,
        geo: {
          x: feature.x,
          y: feature.y,
          w: feature.width,
          h: feature.height,
          rotation: feature.rotation,
        },
      })
    }
    for (const table of tables) {
      const placement = placements.get(table.id)
      if (!placement || placement.roomId !== room.id || placement.x === null) continue
      out.push({
        key: `t${table.id}`,
        kind: 'table',
        label: table.code,
        /* The seat count is DRAWN as chairs now, so repeating it as text under the code
           would say the same thing twice on a tile with very little room. */
        sub: '',
        seats: table.seats,
        geo: {
          x: placement.x ?? 0,
          y: placement.y ?? 0,
          w: placement.width,
          h: placement.height,
          rotation: placement.rotation,
          shape: placement.shape,
        },
      })
    }
    return out
  }, [tables, placements, features, room.id])

  /** What an item looks like right now — its preview mid-gesture, else its real geometry. */
  const shown = useCallback(
    (item: Item): Geometry => preview[item.key] ?? item.geo,
    [preview],
  )

  /**
   * Pointer position in ROOM UNITS.
   *
   * Measured off the live bounding box every time rather than cached on drag start: a
   * canvas that reflows mid-gesture (the toolbar appearing when a second table joins the
   * selection is exactly this) would otherwise apply a stale scale and the table would
   * jump away from the finger.
   *
   * This is also what makes dragging correct while ZOOMED, for free:
   * `getBoundingClientRect` reports the box AFTER the viewport's transform, so a room
   * scaled to 2× measures twice as wide and the division lands on the same room unit.
   * Anything that cached the untransformed size, or computed units from `room.width`
   * alone, would send tables flying at any zoom but 1.
   */
  const toUnits = useCallback(
    (e: { clientX: number; clientY: number }) => {
      const box = surfaceRef.current?.getBoundingClientRect()
      if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 }
      return {
        x: ((e.clientX - box.left) / box.width) * room.width,
        y: ((e.clientY - box.top) / box.height) * room.height,
      }
    },
    [room.width, room.height],
  )

  /** How many units one pixel is worth — the drag threshold works in pixels. */
  const unitsPerPixel = useCallback(() => {
    const box = surfaceRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return { x: 1, y: 1 }
    return { x: room.width / box.width, y: room.height / box.height }
  }, [room.width, room.height])

  const begin = useCallback(
    (e: React.PointerEvent, item: Item, mode: Exclude<Mode, 'marquee'>) => {
      if (!editing || e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()

      /*
       * Clicking an unselected item selects it. Shift OR Ctrl/Cmd adds to the selection —
       * both, because different people reach for different ones and there is no reason to
       * be strict here. Clicking something ALREADY selected keeps the whole group, so a
       * bank of tables can be dragged without the press collapsing it to one.
       *
       * ORDER MATTERS: the array is append-only, so selectedKeys[0] stays the first thing
       * clicked. That is the reference the align and match tools measure against.
       *
       * Ctrl here still means "add to selection" and NOT "pan", even though Ctrl-drag on
       * the empty floor pans: the `stopPropagation` above keeps this press from ever
       * reaching the viewport. Ctrl on a tile adds it; Ctrl on the floor moves the floor.
       */
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        onSelectionChange(
          selected.has(item.key)
            ? selectedKeys.filter((k) => k !== item.key)
            : [...selectedKeys, item.key],
        )
        /* An additive click is a selection change, not the start of a drag. */
        return
      }

      const keys = selected.has(item.key) ? selectedKeys : [item.key]
      if (!selected.has(item.key)) onSelectionChange(keys)

      /* Resize and rotate act on ONE item even when several are selected: resizing a
         group means deciding whether the members scale or spread apart, and both answers
         are wrong half the time. */
      const acting = mode === 'move' ? keys : [item.key]
      const origin = new Map<string, Geometry>()
      for (const key of acting) {
        const source = items.find((i) => i.key === key)
        if (source) origin.set(key, shown(source))
      }

      const geo = shown(item)
      const point = toUnits(e)
      const cx = geo.x + geo.w / 2
      const cy = geo.y + geo.h / 2
      drag.current = {
        mode,
        keys: acting,
        pointerId: e.pointerId,
        startX: point.x,
        startY: point.y,
        origin,
        cx,
        cy,
        startAngle: Math.atan2(point.y - cy, point.x - cx),
        moved: false,
      }
      surfaceRef.current?.setPointerCapture?.(e.pointerId)
    },
    [editing, selected, selectedKeys, onSelectionChange, items, shown, toUnits],
  )

  /** Press on empty floor: start a marquee, or clear the selection. */
  const beginMarquee = useCallback(
    (e: React.PointerEvent) => {
      if (!editing || e.button !== 0) return
      /* Ctrl-drag on the floor PANS rather than selecting — the viewport claims it. This
         handler sits on the room and the viewport's on its parent, so the room sees the
         press first and has to stand down explicitly. */
      if (e.ctrlKey || e.metaKey) return
      const point = toUnits(e)
      drag.current = {
        mode: 'marquee',
        keys: [],
        pointerId: e.pointerId,
        startX: point.x,
        startY: point.y,
        origin: new Map(),
        cx: point.x,
        cy: point.y,
        startAngle: 0,
        moved: false,
      }
      surfaceRef.current?.setPointerCapture?.(e.pointerId)
      if (!e.shiftKey) onSelectionChange([])
    },
    [editing, toUnits, onSelectionChange],
  )

  const move = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointerId) return

      const point = toUnits(e)
      const dx = point.x - d.startX
      const dy = point.y - d.startY

      /* Ignore a shaky tap — 5px, measured in pixels rather than units so the threshold
         feels identical whatever the room's scale. */
      const perPixel = unitsPerPixel()
      if (!d.moved && Math.hypot(dx / perPixel.x, dy / perPixel.y) < 5) return
      d.moved = true

      if (d.mode === 'marquee') {
        const box: Rect = {
          x: Math.min(d.startX, point.x),
          y: Math.min(d.startY, point.y),
          w: Math.abs(point.x - d.startX),
          h: Math.abs(point.y - d.startY),
        }
        setMarquee(box)
        /* Live selection: anything the box overlaps, so the user can see what they are
           catching rather than finding out on release. Ordered top-left first, which
           makes the align/match reference the visually-first item — the only sensible
           answer when nothing was clicked individually. */
        onSelectionChange(
          items
            .filter((i) => {
              const g = i.geo
              return (
                g.x < box.x + box.w &&
                g.x + g.w > box.x &&
                g.y < box.y + box.h &&
                g.y + g.h > box.y
              )
            })
            .sort((a, b) => a.geo.y - b.geo.y || a.geo.x - b.geo.x)
            .map((i) => i.key),
        )
        return
      }

      const next: Record<string, Geometry> = {}
      let nextGuides: Guide[] = []

      if (d.mode === 'move') {
        /* Guides come from the PRIMARY item (the one under the pointer); the rest of the
           selection rides along by the same delta, so the group keeps its internal
           spacing rather than each member snapping to something different. */
        const primaryKey = d.keys[0]
        const primary = d.origin.get(primaryKey)
        let snapDx = dx
        let snapDy = dy

        if (primary) {
          const others = items
            .filter((i) => !d.origin.has(i.key))
            .map((i) => {
              const g = shown(i)
              return { x: g.x, y: g.y, w: g.w, h: g.h }
            })
          const snapped = alignmentFor(
            { x: primary.x + dx, y: primary.y + dy, w: primary.w, h: primary.h },
            others,
            room.width,
            room.height,
          )
          snapDx = snapped.x - primary.x
          snapDy = snapped.y - primary.y
          nextGuides = snapped.guides
        }

        for (const [key, o] of d.origin) {
          const rect = clampRect(
            { x: o.x + snapDx, y: o.y + snapDy, w: o.w, h: o.h },
            room.width,
            room.height,
          )
          next[key] = { ...o, ...rect }
        }
      } else if (d.mode === 'resize') {
        const key = d.keys[0]
        const o = d.origin.get(key)
        if (o) {
          const rect = clampRect(
            {
              x: o.x,
              y: o.y,
              w: Math.max(MIN_TABLE_SIZE, o.w + dx),
              h: Math.max(MIN_TABLE_SIZE, o.h + dy),
            },
            room.width,
            room.height,
          )
          next[key] = { ...o, ...rect }
        }
      } else {
        const key = d.keys[0]
        const o = d.origin.get(key)
        if (o) {
          const angle = Math.atan2(point.y - d.cy, point.x - d.cx)
          let deg = o.rotation + ((angle - d.startAngle) * 180) / Math.PI
          /* Shift bypasses the detents for a genuinely arbitrary angle. */
          if (!e.shiftKey) deg = Math.round(deg / ROTATE_DETENT) * ROTATE_DETENT
          next[key] = { ...o, rotation: cleanRotation(deg) }
        }
      }

      setPreview((p) => ({ ...p, ...next }))
      setGuides(nextGuides)
    },
    [items, shown, toUnits, unitsPerPixel, onSelectionChange, room.width, room.height],
  )

  const end = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointerId) return
      drag.current = null
      setGuides([])
      setMarquee(null)

      if (d.mode !== 'marquee' && d.moved) {
        const changes: GeometryChange[] = []
        for (const [key, before] of d.origin) {
          const after = preview[key]
          if (after) changes.push({ id: key, before, after })
        }
        if (changes.length > 0) onCommit(changes)
      }
      setPreview({})
    },
    [preview, onCommit],
  )

  /*
   * The canvas's rendered size, watched.
   *
   * Only used to work out how much a room unit is stretched on screen (see `unitAspect`),
   * which is a RATIO of the two axes — so the viewport's uniform `scale()` cancels out of
   * it and zooming cannot skew the rim. (`ResizeObserver` reports the untransformed
   * content box in any case; the ratio would hold either way.)
   * Observed rather than read once, because the pane resizes with the window and with the
   * toolbar appearing — and a stale measurement would draw the rim correctly at one width
   * and wrongly at every other.
   */
  const [canvasBox, setCanvasBox] = useState<{ width: number; height: number } | null>(null)
  useEffect(() => {
    const node = surfaceRef.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect
      if (box.width > 0 && box.height > 0) {
        setCanvasBox({ width: box.width, height: box.height })
      }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  /* A pointer lost to a system gesture or an alt-tab must not leave the canvas thinking a
     drag is still running — the preview would stick at an offset nothing would reset. */
  useEffect(() => {
    const cancel = () => {
      if (!drag.current) return
      drag.current = null
      setGuides([])
      setMarquee(null)
      setPreview({})
    }
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
    }
  }, [])

  const pct = (value: number, of: number) => `${(value / of) * 100}%`

  /*
   * How much height is actually left below the pane, in the full-screen shell.
   *
   * Re-measured on resize AND whenever the toolbar above changes size — the align tools
   * appear when a second table is selected, the unsaved-changes callout appears on the
   * first drag, and both push the canvas down. A height fixed at mount would leave the
   * pane overflowing by exactly the height of whatever appeared.
   *
   * `undefined` until measured, so the first paint has no height rather than a wrong one
   * that visibly snaps.
   */
  const [availableHeight, setAvailableHeight] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!tall) return
    const node = viewport.surfaceRef.current
    if (!node) return

    /*
     * Measured against the SCROLLING CONTAINER, not the window.
     *
     * `window.innerHeight` looked equivalent — the overlay is `fixed inset-0` — but it is
     * not: it ignores the overlay's own padding and every ancestor's, and it cannot see a
     * container that is shorter than the window for any other reason. Walking up to the
     * nearest element that actually bounds the height is the honest question, and it is
     * the one that holds if this is ever embedded somewhere else.
     */
    const container = node.closest('.flex.min-h-0.flex-1') ?? node.parentElement
    if (!container) return

    const measure = () => {
      const top = node.getBoundingClientRect().top
      const bottom = container.getBoundingClientRect().bottom
      /* A floor plan below ~240px is unusable; better to overflow slightly and be told
         about it than to render a sliver. */
      setAvailableHeight(`${Math.round(Math.max(240, bottom - top))}px`)
    }
    measure()

    /*
     * Watched on BOTH, and for different reasons: the container changes with the window,
     * and the toolbar above the pane changes height on its own — the align tools appear
     * when a second table is selected, the unsaved-changes callout on the first drag.
     * Either one moves the pane's top without the other moving at all.
     */
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    if (node.parentElement) observer.observe(node.parentElement)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [tall, viewport.surfaceRef])

  /*
   * How wide one room unit is on screen, relative to how tall — the canvas's own stretch.
   *
   * Every tile is positioned and sized in PERCENTAGES of the room, so if the canvas
   * element is not laid out at exactly the room's aspect ratio, a square table renders
   * as a rectangle. `TableGlyph` needs this to draw an even rim: without it a 10×10 table
   * looks square to the glyph, no correction is applied, and the band comes out visibly
   * thicker on the left and right. Measured rather than assumed, because `maxWidth` and
   * the surrounding layout can both stop the box reaching its nominal ratio.
   */
  const unitAspect = useMemo(() => {
    if (!canvasBox) return 1
    const byUnit = canvasBox.width / room.width / (canvasBox.height / room.height)
    return Number.isFinite(byUnit) && byUnit > 0 ? byUnit : 1
  }, [canvasBox, room.width, room.height])

  return (
    <div
      /* ── The VIEWPORT ─────────────────────────────────────────────────────
         Pan and pinch out of edit mode, exactly as the till does. In edit mode the
         viewport is disabled and this is an inert frame: a drag there moves a TABLE, and
         two things claiming one gesture is how a canvas ends up fighting the user. The
         zoom BUTTONS stay live in both, so a manager can still work in close. */
      ref={viewport.surfaceRef}
      {...viewport.handlers}
      /*
       * The height is MEASURED, not assumed.
       *
       * It used to be a hard `74vh` in full screen, which ignored its container entirely:
       * on any window shorter than that assumed, the pane overflowed and put a horizontal
       * scrollbar under the plan. `availableHeight` instead measures from the pane's own
       * top to the bottom of the window, so it shrinks and grows with the browser.
       *
       * Measured rather than `flex-1`, because the wrapper chain above is a plain block
       * holding toolbars, callouts and the tray — making every one of those a flex child
       * to pass a height down would be a lot of `shrink-0` in places that have no other
       * reason for it, and one missing would collapse the canvas silently.
       *
       * In the PAGE it stays 58vh: a card in a scrolling column genuinely has no
       * container height to fill, and a viewport-relative size is the right answer there.
       */
      className="relative w-full overflow-hidden"
      style={{
        height: tall ? availableHeight : '58vh',
        touchAction: 'none',
        /* Grabbing whenever a pan is actually running, in EITHER mode — a Ctrl-drag in
           edit mode should feel like the pan it is. Out of edit mode the open hand also
           shows at rest, because everything there is pannable. */
        cursor: viewport.panning ? 'grabbing' : editing ? undefined : 'grab',
      }}
    >
      <div
        ref={surfaceRef}
        /* `till-surface` matches what the POS floor view wears, so the designer and the
           screen it designs read as the same room. */
        className={`till-surface absolute left-1/2 top-1/2 overflow-hidden rounded-card border-2 ${
          editing ? 'border-brand/40 bg-surface-2' : 'border-border bg-surface-2'
        }`}
        style={{
          transform: `translate(${viewport.view.x}px, ${viewport.view.y}px) translate(-50%, -50%) scale(${viewport.view.scale})`,
          transformOrigin: 'center center',
          transition: viewport.panning ? undefined : 'transform 140ms ease-out',
          /*
           * The room's own aspect ratio, sized to FIT the viewport at scale 1 — so
           * "zoomed all the way out" is the whole room on screen, which is where both
           * screens start and what Reset returns to. Everything past that is the
           * transform's job now, not the layout's.
           */
          aspectRatio: `${room.width} / ${room.height}`,
          height: '100%',
          maxWidth: '100%',
        }}
        /* move/up live HERE rather than on each tile, because the canvas holds pointer
           capture — see the header note. */
        onPointerDown={beginMarquee}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
      {/*
        A DASHED grid, so a manager can line things up by eye even before a guide appears.
        Dashed rather than solid because a solid lattice competes with the furniture drawn
        on top of it — the eye reads continuous lines as part of the plan, where a broken
        one stays background. Same reason graph paper and design tools use it.

        An SVG pattern rather than the two CSS gradients this replaced: a gradient can
        draw a line but not break it, so dashes were not expressible at all. The pattern
        is sized in ROOM UNITS (10 per cell), so the grid stays square and matches the
        snapping regardless of the room's proportions.
      */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full text-border-strong opacity-90"
        preserveAspectRatio="none"
        viewBox={`0 0 ${room.width} ${room.height}`}
      >
        <defs>
          <pattern id={`${gridId}-cell`} width={10} height={10} patternUnits="userSpaceOnUse">
            {/* Only the top and left edge of each cell — drawing all four would double
                every interior line and read twice as heavy. */}
            <path
              d="M 10 0 L 0 0 0 10"
              fill="none"
              stroke="currentColor"
              /* A hairline at any zoom — `non-scaling-stroke` means this is PIXELS, not
                 room units, so the grid stays one pixel whether zoomed in or out. */
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          </pattern>
        </defs>
        <rect width={room.width} height={room.height} fill={`url(#${gridId}-cell)`} />
      </svg>

      {/* Guides sit above the floor but below the items, so nothing hides the line
          explaining where it snapped. */}
      {guides.map((g, i) => (
        <div
          key={i}
          aria-hidden
          className="pointer-events-none absolute z-10 bg-brand"
          style={
            g.axis === 'v'
              ? {
                  left: pct(g.at, room.width),
                  top: pct(g.from, room.height),
                  width: 1,
                  height: pct(g.to - g.from, room.height),
                }
              : {
                  top: pct(g.at, room.height),
                  left: pct(g.from, room.width),
                  height: 1,
                  width: pct(g.to - g.from, room.width),
                }
          }
        />
      ))}

      {marquee && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 rounded-control border border-brand bg-brand/10"
          style={{
            left: pct(marquee.x, room.width),
            top: pct(marquee.y, room.height),
            width: pct(marquee.w, room.width),
            height: pct(marquee.h, room.height),
          }}
        />
      )}

      {items.map((item) => {
        const geo = shown(item)
        const isSelected = selected.has(item.key)
        /* Handles show on a single selection only: on a group they would imply the whole
           group resizes, which it deliberately does not. */
        const showHandles = editing && isSelected && selectedKeys.length === 1
        /* The first-selected item is what align and match measure against, so it has to be
           visible — otherwise "same width" looks arbitrary. */
        const isReference = editing && selectedKeys.length > 1 && selectedKeys[0] === item.key

        return (
          <div
            key={item.key}
            className="absolute"
            style={{
              left: pct(geo.x, room.width),
              top: pct(geo.y, room.height),
              width: pct(geo.w, room.width),
              height: pct(geo.h, room.height),
              transform: geo.rotation ? `rotate(${geo.rotation}deg)` : undefined,
              /* Rotating about the centre keeps x/y meaning "top-left of the unrotated
                 box", which is exactly what the stored coordinates are. */
              transformOrigin: 'center center',
              zIndex: isSelected ? 20 : item.kind === 'feature' ? 1 : 2,
              cursor: editing ? 'grab' : 'pointer',
            }}
            onPointerDown={(e) => begin(e, item, 'move')}
            onClick={() => {
              if (!editing) onOpenItem(item.key)
            }}
          >
            {item.kind === 'table' ? (
              <TableFace
                label={item.label}
                sub={item.sub}
                seats={item.seats ?? 0}
                shape={geo.shape ?? 'rect'}
                rotation={geo.rotation}
                selected={isSelected}
                geo={geo}
                unitAspect={unitAspect}
              />
            ) : (
              <FeatureFace
                kind={item.featureKind ?? 'wall'}
                label={item.label}
                rotation={geo.rotation}
                selected={isSelected}
              />
            )}

            {isReference && (
              <span
                className="pointer-events-none absolute -left-1 -top-2 z-30 rounded-pill bg-brand px-1.5 text-[10px] font-bold leading-tight text-surface shadow-card"
                title="Everything else will match this one"
              >
                REF
              </span>
            )}

            {showHandles && (
              <>
                {/* Not kit Buttons: these are drag HANDLES, not things you click — a
                    Button would bring its own pointer semantics and a focus ring that
                    fights the gesture. */}
                <span
                  data-kit-ok
                  role="button"
                  aria-label={`Resize ${item.label || item.sub}`}
                  onPointerDown={(e) => begin(e, item, 'resize')}
                  className="absolute -bottom-2 -right-2 z-30 h-4 w-4 cursor-nwse-resize rounded-pill border-2 border-brand bg-surface shadow-card"
                />
                <span
                  data-kit-ok
                  role="button"
                  aria-label={`Rotate ${item.label || item.sub}`}
                  onPointerDown={(e) => begin(e, item, 'rotate')}
                  className="absolute -top-6 left-1/2 z-30 flex h-4 w-4 -translate-x-1/2 cursor-grab items-center justify-center rounded-pill border-2 border-brand bg-surface text-[10px] leading-none text-brand shadow-card"
                >
                  ⟳
                </span>
              </>
            )}
          </div>
        )
      })}
      </div>

      {/* ── Zoom controls ────────────────────────────────────────────────────
          Live in BOTH modes, unlike the pan gesture: a manager arranging a crowded
          corner needs to zoom in and then keep dragging tables, and taking the buttons
          away in edit mode would make close work impossible on a big floor. */}
      <div className="absolute bottom-3 right-3 z-30 flex flex-col gap-1">
        <button
          type="button"
          data-kit-ok
          aria-label="Zoom in"
          onClick={() => viewport.zoomBy(1.3)}
          className="flex h-8 w-8 items-center justify-center rounded-control border border-border bg-surface text-ink shadow-card transition hover:bg-surface-2"
        >
          +
        </button>
        <button
          type="button"
          data-kit-ok
          aria-label="Zoom out"
          onClick={() => viewport.zoomBy(1 / 1.3)}
          className="flex h-8 w-8 items-center justify-center rounded-control border border-border bg-surface text-ink shadow-card transition hover:bg-surface-2"
        >
          −
        </button>
        {viewport.moved && (
          <button
            type="button"
            data-kit-ok
            aria-label="Fit the whole room"
            title="Fit the whole room"
            onClick={viewport.reset}
            className="flex h-8 w-8 items-center justify-center rounded-control border border-border bg-surface text-[10px] font-semibold text-ink shadow-card transition hover:bg-surface-2"
          >
            FIT
          </button>
        )}
      </div>
    </div>
  )
}

/* ── How one table draws ──────────────────────────────────────────────────── */

function TableFace({
  label,
  sub,
  seats,
  shape,
  rotation,
  selected,
  geo,
  unitAspect,
}: {
  label: string
  sub: string
  seats: number
  shape: TableShape
  rotation: number
  selected: boolean
  geo: Geometry
  /** How wide a room unit renders relative to its height — see the canvas's note. */
  unitAspect: number
}) {
  /* Laid out from the DRAWN size, not the preset's: a six-top dragged long and narrow
     should move its chairs to the long edges, which is the whole reason seatLayout takes
     w and h rather than just a count. */
  const chairs = seatLayout(seats, geo.w, geo.h)

  return (
    /* One text colour drives the whole drawing — TableGlyph fills and strokes with
       currentColor, so selection is a colour change and not a second set of classes. */
    <div
      data-kit-ok
      /* `text-ink-2`, not `text-border-strong`: a hairline token carries a 1px rule but
         not a filled shape, and at 28% fill it left the table looking like a ghost of
         itself. Same colour the till's `free` state uses, which is the point. */
      className={`relative h-full w-full select-none ${
        selected ? 'text-brand' : 'text-ink-2'
      }`}
    >
      <TableGlyph
        shape={shape}
        seats={chairs}
        /* The drawn size in SCREEN proportions, not room units: the canvas maps the room
           onto a box that need not share its aspect ratio, so a 10×10-unit table is not
           square on screen. Passing raw units left the rim uncorrected on exactly those
           tables — measurably 1.59× thicker on the sides here. */
        footprint={{ width: geo.w * unitAspect, height: geo.h }}
        className="absolute inset-0 h-full w-full"
      />

      {/* The BOX rotates but the LABEL does not — a table turned 90° against a diagonal
          wall should still have a code you can read without tilting your head. Same rule
          the till's floor view follows. */}
      <span
        className="absolute inset-0 flex flex-col items-center justify-center leading-none"
        style={{ transform: rotation ? `rotate(${-rotation}deg)` : undefined }}
      >
        <span className={`text-sm font-bold ${selected ? 'text-brand' : 'text-ink'}`}>
          {label}
        </span>
        {sub && <span className="text-[10px] text-muted">{sub}</span>}
      </span>
    </div>
  )
}

/* ── How one wall / bar / door draws ──────────────────────────────────────── */

/**
 * What colour each fixture reads as.
 *
 * TEXT tokens, not surfaces: `FeatureGlyph` fills and strokes with `currentColor`, so one
 * class here colours the whole drawing and its label together. The assignments carry the
 * same meaning they did as backgrounds — a bar is warm, greenery is green, structure is
 * neutral — because that reading was right; only the shapes were missing.
 *
 * Deliberately the same skins the till's floor view uses.
 */
const FEATURE_TONE: Record<FloorFeature['kind'], string> = {
  wall: 'text-ink-2',
  bar: 'text-warning-ink',
  pass: 'text-success',
  door: 'text-border-strong',
  plant: 'text-success',
  text: 'text-muted',
}

function FeatureFace({
  kind,
  label,
  rotation,
  selected,
}: {
  kind: FloorFeature['kind']
  label: string
  rotation: number
  selected: boolean
}) {
  return (
    <div
      data-kit-ok
      className={`relative h-full w-full select-none ${
        selected ? 'text-brand' : FEATURE_TONE[kind]
      }`}
    >
      <FeatureGlyph kind={kind} className="absolute inset-0 h-full w-full" />
      {/* A ring rather than a border, so selection never changes the drawing's own
          outline — a selected wall must still look like a wall. */}
      {selected && (
        <span
          aria-hidden
          data-kit-ok
          className="pointer-events-none absolute -inset-1 rounded-card ring-2 ring-brand"
        />
      )}
      {label && (
        <span
          className="absolute inset-0 flex items-center justify-center text-center text-[10px] font-medium leading-none"
          style={{ transform: rotation ? `rotate(${-rotation}deg)` : undefined }}
        >
          {label}
        </span>
      )}
    </div>
  )
}

/** Shared by the designer's nudge keys and its tool buttons. */
export function nudged(geo: Geometry, dx: number, dy: number, room: FloorRoom): Geometry {
  const rect = clampRect(
    { x: geo.x + dx, y: geo.y + dy, w: geo.w, h: geo.h },
    room.width,
    room.height,
  )
  return { ...geo, ...rect }
}

export { round2 }
