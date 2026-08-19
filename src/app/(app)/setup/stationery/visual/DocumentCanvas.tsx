'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BLOCK_STYLE } from '@/lib/stationery/compile'
import { conditionDef } from '@/lib/stationery/conditions'
import {
  BAND_INFO,
  BAND_KEYS,
  DOC_BLOCK_CATALOG,
  type BandKey,
  type DocBlock,
  type DocumentSpec,
} from '@/lib/stationery/blocks'
import {
  BAND_PX,
  MIN_BLOCK_W,
  clampBlock,
  gapsFor,
  snapBlock,
  type GapReading,
  type Guide,
  type Rect,
} from '@/lib/stationery/geometry'

/**
 * The page, as a canvas you drag things around on.
 *
 * ── WHAT THIS REPLACED, AND WHY ───────────────────────────────────────────
 *
 * An ordered list with drop-gaps between the items, and a `row` block that
 * split into cells. It worked, and the user's verdict on it was that it felt
 * buggy — specifically that two landing strips appeared under one pointer.
 *
 * That was not a bug to patch. In a list-with-gaps the page contributes gaps and
 * so does every cell, so a pointer between two blocks inside a cell is
 * legitimately over two targets and something has to arbitrate. Every fix made
 * the arbitration cleverer and none made it feel like a design tool.
 *
 * ── SO: POINTER EVENTS, NOT dnd-kit ───────────────────────────────────────
 *
 * FloorCanvas.tsx made this exact call for this exact reason, and says it best:
 * dnd-kit is built to answer "what did you drop this ON", and a canvas asks
 * nothing of the sort — there is no drop target, only x and y, and what the tool
 * needs is CONTINUOUS geometry while the pointer moves so a block can snap to
 * its neighbour and draw the line explaining why.
 *
 * dnd-kit stays in the project. The column editor still uses it, correctly: a
 * column list IS an ordered list, and "which column did you drop this before" is
 * exactly the question it answers well.
 *
 * ── HEIGHTS ARE MEASURED, NOT STORED ──────────────────────────────────────
 *
 * The one real difference from the floor plan. A table's height is a fact about
 * the table; a block's is whatever its content came to — a letterhead with four
 * contact lines is taller than one with two. So heights are read from the DOM
 * and fed back up, because snapping to a block's BOTTOM edge and refusing an
 * overlap both need a number nobody stored.
 *
 * That measurement is also the honest one: it is the height of the real compiled
 * markup, so what the guides promise is what the paper does.
 *
 * ── PERCENTAGES OUT, PIXELS IN — ON TWO DIFFERENT SCALES ──────────────────
 *
 * A pointer delta arrives in pixels and has to be converted, and the two axes do
 * NOT convert the same way. Across the page, a percent is a percent of the live
 * measured width. Down the page, a percent is a percent of the BAND, which is a
 * fixed number of pixels — `BAND_PX`, shared with the compiler so the screen and
 * the paper cannot disagree.
 *
 * Conflating them is not a subtle bug: it made vertical drags a hundred times
 * too large. See `toPercent`.
 *
 * The canvas measures itself rather than assuming a size, for the reason
 * floorGeometry gives: hard-coding a scale is how a layout ends up correct on
 * exactly one monitor.
 */

type Mode = 'move' | 'resize-l' | 'resize-r' | 'marquee'

type DragState = {
  mode: Mode
  band: BandKey
  ids: string[]
  pointerId: number
  /** Pointer origin in PERCENT, so a scroll mid-drag cannot skew the delta. */
  startX: number
  startY: number
  /** Where each dragged block was when the gesture began. */
  origin: Map<string, { x: number; y: number; w: number }>
  moved: boolean
}

export default function DocumentCanvas({
  spec,
  html,
  selectedIds,
  outlined,
  onSelectionChange,
  onCommit,
  onHeights,
}: {
  spec: DocumentSpec
  /** Each block's compiled, token-resolved markup, keyed by id. */
  html: Record<string, string>
  selectedIds: string[]
  /**
   * Show every block's outline, not only the one under the pointer.
   *
   * A device preference, because it is a working style rather than a property of
   * the document: laying a page out, seeing where each block ENDS is most of the
   * information, and hovering one at a time to find out is slow. Reading the
   * finished page, the same outlines are clutter over what is meant to look like
   * paper. Both are right, so it is a switch.
   */
  outlined: boolean
  onSelectionChange: (ids: string[]) => void
  /** Called once, on release, with every block the gesture moved. */
  onCommit: (changes: { id: string; x: number; y: number; w: number }[]) => void
  /** Measured heights in band percent, so the parent can refuse an overlap. */
  onHeights: (heights: Record<string, number>) => void
}) {
  /*
   * TWO refs, and the difference matters.
   *
   * `pageRef` is the paper — it carries the padding that makes a printed page's
   * margin. `sheetRef` is inside that padding and IS the coordinate space: a
   * block's `left: 40%` resolves against it, so the pointer must be measured
   * against it too.
   *
   * Measuring against the paper instead was an 8 percent error on this page's
   * geometry, and it read exactly as the thing the user complained about — the
   * block trailing behind the pointer instead of following it.
   */
  const pageRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef<DragState | null>(null)

  const [preview, setPreview] = useState<Record<string, { x: number; y: number; w: number }>>({})
  const [guides, setGuides] = useState<Guide[]>([])
  const [gaps, setGaps] = useState<GapReading[]>([])
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [dragBand, setDragBand] = useState<BandKey | null>(null)

  const selected = useMemo(() => new Set(selectedIds), [selectedIds])

  /* ── measuring ──────────────────────────────────────────────────────────
   *
   * One observer over every block box. A block's height changes when its own
   * content changes (a token added to a letterhead) AND when the page is
   * resized, so an effect that ran on spec changes alone would go stale on a
   * window resize and start snapping to edges that had moved.
   */
  const boxes = useRef(new Map<string, HTMLDivElement>())
  const [heights, setHeights] = useState<Record<string, number>>({})

  const measure = useCallback(() => {
    const next: Record<string, number> = {}
    for (const [id, el] of boxes.current) {
      const px = el.getBoundingClientRect().height
      if (px > 0) next[id] = Math.round((px / BAND_PX) * 100) / 100
    }
    setHeights((prev) => {
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.entries(next).every(([k, v]) => prev[k] === v)
      return same ? prev : next
    })
  }, [])

  useEffect(() => {
    measure()
    const ro = new ResizeObserver(measure)
    for (const el of boxes.current.values()) ro.observe(el)
    if (sheetRef.current) ro.observe(sheetRef.current)
    return () => ro.disconnect()
  }, [measure, spec, html])

  useEffect(() => {
    onHeights(heights)
  }, [heights, onHeights])

  /** A block's rect, taking a live drag into account. */
  const rectOf = useCallback(
    (b: DocBlock): Rect => {
      const p = preview[b.id]
      return {
        x: p?.x ?? b.x,
        y: p?.y ?? b.y,
        w: p?.w ?? b.w,
        // An unmeasured block is treated as one line tall rather than as zero:
        // zero height means nothing ever overlaps it and nothing snaps to its
        // bottom, so the guides would quietly stop working for it.
        h: heights[b.id] ?? 4,
      }
    },
    [preview, heights],
  )

  /** Percent per pixel, from the live width of the coordinate space. */
  const scale = useCallback(() => {
    const box = sheetRef.current?.getBoundingClientRect()
    return box && box.width > 0 ? 100 / box.width : 0.1
  }, [])

  /**
   * A pointer position in the units a block is stored in.
   *
   * THE TWO AXES ARE NOT THE SAME UNIT, which is the trap here. `x` is a percent
   * of the page's width, so it divides by the measured width and scales to 100.
   * `y` is a percent of the BAND, and `BAND_PX` is already the pixels in one of
   * those percent — so dividing by it IS the conversion. Scaling by 100 as well
   * made every vertical drag a hundred times too large; a nudge threw the block
   * to the top of the band, and it read as the canvas fighting the pointer.
   */
  const toPercent = useCallback((e: React.PointerEvent) => {
    const box = sheetRef.current?.getBoundingClientRect()
    if (!box || box.width === 0) return { x: 0, y: 0 }
    return {
      x: ((e.clientX - box.left) / box.width) * 100,
      y: (e.clientY - box.top) / BAND_PX,
    }
  }, [])

  /* ── gestures ───────────────────────────────────────────────────────────── */

  const begin = useCallback(
    (e: React.PointerEvent, block: DocBlock, mode: Exclude<Mode, 'marquee'>) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()

      /*
       * Shift or Ctrl/Cmd adds to the selection; both, because different people
       * reach for different ones. Pressing something ALREADY selected keeps the
       * group, so several blocks can be dragged together without the press
       * collapsing the selection to one.
       *
       * Order is append-only, so selectedIds[0] stays the first thing clicked —
       * that is the reference the align buttons measure against.
       */
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        onSelectionChange(
          selected.has(block.id)
            ? selectedIds.filter((k) => k !== block.id)
            : [...selectedIds, block.id],
        )
        return
      }

      const ids = selected.has(block.id) ? selectedIds : [block.id]
      if (!selected.has(block.id)) onSelectionChange(ids)

      /*
       * A group MOVES together but resizes one at a time. Resizing a selection
       * means deciding whether the members scale or spread, and both answers are
       * wrong half the time — the floor planner reached the same conclusion.
       *
       * And only blocks in the SAME band come along: a drag is measured in that
       * band's coordinates, so carrying a footer block through a header drag
       * would move it by a distance that means something else there.
       */
      const acting =
        mode === 'move'
          ? ids.filter((id) => spec.blocks.find((b) => b.id === id)?.band === block.band)
          : [block.id]

      const origin = new Map<string, { x: number; y: number; w: number }>()
      for (const id of acting) {
        const b = spec.blocks.find((x) => x.id === id)
        if (b) origin.set(id, { x: b.x, y: b.y, w: b.w })
      }

      const point = toPercent(e)
      drag.current = {
        mode,
        band: block.band,
        ids: acting,
        pointerId: e.pointerId,
        startX: point.x,
        startY: point.y,
        origin,
        moved: false,
      }
      setDragBand(block.band)
      pageRef.current?.setPointerCapture?.(e.pointerId)
    },
    [selected, selectedIds, onSelectionChange, spec.blocks, toPercent],
  )

  /** Press on empty page: draw a marquee, or clear the selection. */
  const beginMarquee = useCallback(
    (e: React.PointerEvent, band: BandKey) => {
      if (e.button !== 0) return
      const point = toPercent(e)
      drag.current = {
        mode: 'marquee',
        band,
        ids: [],
        pointerId: e.pointerId,
        startX: point.x,
        startY: point.y,
        origin: new Map(),
        moved: false,
      }
      pageRef.current?.setPointerCapture?.(e.pointerId)
      if (!e.shiftKey) onSelectionChange([])
    },
    [toPercent, onSelectionChange],
  )

  const move = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointerId) return

      const point = toPercent(e)
      const dx = point.x - d.startX
      const dy = point.y - d.startY

      /* Ignore a shaky tap. Back in PIXELS on both axes so the threshold feels
         the same however wide the page is drawn — and the two axes convert
         differently, so each is undone with its own scale rather than one. */
      if (!d.moved && Math.hypot(dx / scale(), dy * BAND_PX) < 5) return
      d.moved = true

      if (d.mode === 'marquee') {
        const box: Rect = {
          x: Math.min(d.startX, point.x),
          y: Math.min(d.startY, point.y),
          w: Math.abs(point.x - d.startX),
          h: Math.abs(point.y - d.startY),
        }
        setMarquee(box)
        /* Live selection, so the user sees what they are catching rather than
           finding out on release. Ordered top-left first, which makes the align
           reference the visually-first block. */
        onSelectionChange(
          spec.blocks
            .filter((b) => b.band === d.band)
            .filter((b) => {
              const r = rectOf(b)
              return (
                r.x < box.x + box.w && r.x + r.w > box.x && r.y < box.y + box.h && r.y + r.h > box.y
              )
            })
            .sort((a, b) => a.y - b.y || a.x - b.x)
            .map((b) => b.id),
        )
        return
      }

      const next: Record<string, { x: number; y: number; w: number }> = {}
      let nextGuides: Guide[] = []
      let nextGaps: GapReading[] = []

      /* Everything in this band that is NOT being dragged is a snap target. */
      const others = spec.blocks
        .filter((b) => b.band === d.band && !d.origin.has(b.id))
        .map(rectOf)

      const bandH = spec.blocks
        .filter((b) => b.band === d.band)
        .reduce((max, b) => Math.max(max, rectOf(b).y + rectOf(b).h), 0)

      if (d.mode === 'move') {
        /*
         * Guides come from the PRIMARY block — the one under the pointer. The
         * rest of the selection rides along by the same delta, so a group keeps
         * its internal spacing instead of each member snapping to something
         * different and the arrangement quietly rearranging itself.
         */
        const primaryId = d.ids[0]
        const primary = d.origin.get(primaryId)
        let snapDx = dx
        let snapDy = dy

        if (primary) {
          const h = heights[primaryId] ?? 4
          const moving = { x: primary.x + dx, y: primary.y + dy, w: primary.w, h }
          const snapped = snapBlock(moving, others, bandH)
          snapDx = snapped.x - primary.x
          snapDy = snapped.y - primary.y
          nextGuides = snapped.guides
          nextGaps = gapsFor({ ...moving, x: snapped.x, y: snapped.y }, others)
        }

        for (const [id, o] of d.origin) {
          next[id] = clampBlock({ x: o.x + snapDx, y: o.y + snapDy, w: o.w })
        }
      } else {
        /*
         * Resize from the sides only — width is the one dimension a block has.
         * Height belongs to the content, and a handle offering to set it would
         * be offering something the printed page then ignores.
         *
         * Dragging the LEFT edge moves x and w together, so the right edge stays
         * put. That is what makes "widen this to reach the block beside it" one
         * gesture rather than a move and a resize.
         */
        const id = d.ids[0]
        const o = d.origin.get(id)
        if (o) {
          const raw =
            d.mode === 'resize-r'
              ? { x: o.x, y: o.y, w: o.w + dx }
              : { x: o.x + dx, y: o.y, w: o.w - dx }

          // A left-edge drag past the far side would invert the block; stop at
          // the minimum with the right edge where it was.
          const right = o.x + o.w
          const fixed =
            d.mode === 'resize-l' && raw.w < MIN_BLOCK_W
              ? { x: right - MIN_BLOCK_W, y: o.y, w: MIN_BLOCK_W }
              : raw

          const clamped = clampBlock(fixed)
          const h = heights[id] ?? 4
          // Snap the edge being dragged, so a block can be widened to line up
          // with its neighbour exactly.
          const snapped = snapBlock({ ...clamped, h }, others, bandH)
          nextGuides = snapped.guides
          next[id] =
            d.mode === 'resize-r'
              ? clampBlock({ x: clamped.x, y: clamped.y, w: snapped.x + clamped.w - clamped.x })
              : clampBlock({ x: snapped.x, y: clamped.y, w: right - snapped.x })
        }
      }

      setPreview((p) => ({ ...p, ...next }))
      setGuides(nextGuides)
      setGaps(nextGaps)
    },
    [spec.blocks, rectOf, heights, toPercent, scale, onSelectionChange],
  )

  const end = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current
      if (!d || e.pointerId !== d.pointerId) return
      drag.current = null
      setGuides([])
      setGaps([])
      setMarquee(null)
      setDragBand(null)
      pageRef.current?.releasePointerCapture?.(e.pointerId)

      /* A press that never moved is a click: it selected something, and there is
         nothing to commit. Committing anyway would put an identical geometry on
         the undo stack, so every click would cost an undo press. */
      if (!d.moved || d.mode === 'marquee') {
        setPreview({})
        return
      }

      const changes = [...d.origin.keys()]
        .map((id) => ({ id, ...(preview[id] ?? d.origin.get(id)!) }))
        .filter((c) => {
          const o = d.origin.get(c.id)!
          return c.x !== o.x || c.y !== o.y || c.w !== o.w
        })

      setPreview({})
      if (changes.length > 0) onCommit(changes)
    },
    [preview, onCommit],
  )

  /* ── keyboard ───────────────────────────────────────────────────────────
   *
   * Arrow keys nudge the selection. This is what replaced the up/down buttons
   * the gap model needed: with free placement, a keyboard user wants the same
   * thing as a pointer user — to move a block a little — and arrows say that
   * without a scheme for "which gap comes next".
   *
   * Shift for a coarse step, because a page is 100 wide and 0.5 at a time is a
   * lot of presses.
   */
  useEffect(() => {
    if (selectedIds.length === 0) return

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      // Never steal an arrow from a field someone is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return

      const step = e.shiftKey ? 5 : 0.5
      const d =
        e.key === 'ArrowLeft'
          ? { x: -step, y: 0 }
          : e.key === 'ArrowRight'
            ? { x: step, y: 0 }
            : e.key === 'ArrowUp'
              ? { x: 0, y: -step }
              : e.key === 'ArrowDown'
                ? { x: 0, y: step }
                : null
      if (!d) return
      e.preventDefault()

      const changes = selectedIds
        .map((id) => spec.blocks.find((b) => b.id === id))
        .filter((b): b is DocBlock => !!b)
        .map((b) => ({ id: b.id, ...clampBlock({ x: b.x + d.x, y: b.y + d.y, w: b.w }) }))
      if (changes.length > 0) onCommit(changes)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, spec.blocks, onCommit])

  /* ── drawing ────────────────────────────────────────────────────────────── */

  return (
    <div
      ref={pageRef}
      className="mx-auto w-full max-w-[52rem] select-none bg-surface p-8 text-ink shadow-pop"
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      {/*
        The compiler's own hide-when-empty rules, so a block that prints nothing
        shows nothing here either. Without them the canvas kept a "NOTES" caption
        over an empty value that the printed page correctly dropped.
      */}
      <style>{BLOCK_STYLE}</style>

      {/* The coordinate space. Percentages resolve against THIS, so the pointer
          is measured against it too — see the note on the two refs. */}
      <div ref={sheetRef} className="relative">
      {BAND_KEYS.map((band) => {
        const blocks = spec.blocks.filter((b) => b.band === band)
        const extent = blocks.reduce((max, b) => {
          const r = rectOf(b)
          return Math.max(max, r.y + r.h)
        }, 0)

        return (
          <Band
            key={band}
            band={band}
            active={dragBand === band}
            /* The items band is as tall as its table; the others reserve room for
               the lowest block plus a little, so a block at the bottom is not
               hanging over the band below it. */
            minPx={band === 'body' ? 0 : (extent + 4) * BAND_PX}
            onPointerDown={(e) => beginMarquee(e, band)}
          >
            {blocks.map((b) => {
              const r = rectOf(b)
              return (
                <BlockBox
                  key={b.id}
                  block={b}
                  rect={r}
                  html={html[b.id] ?? ''}
                  selected={selected.has(b.id)}
                  outlined={outlined}
                  register={(el) => {
                    if (el) boxes.current.set(b.id, el)
                    else boxes.current.delete(b.id)
                  }}
                  onBegin={begin}
                />
              )
            })}

            {dragBand === band &&
              guides.map((g, i) => <GuideLine key={i} guide={g} />)}

            {dragBand === band && gaps.map((g, i) => <GapLabel key={i} gap={g} />)}

            {marquee && drag.current?.band === band && (
              <div
                className="pointer-events-none absolute rounded-sm border border-brand bg-brand/10"
                style={{
                  left: `${marquee.x}%`,
                  top: `${marquee.y * BAND_PX}px`,
                  width: `${marquee.w}%`,
                  height: `${marquee.h * BAND_PX}px`,
                }}
              />
            )}
          </Band>
        )
      })}
      </div>
    </div>
  )
}

/**
 * One band.
 *
 * Its outline shows only while something is being dragged in it. Visible all the
 * time, the page would read as three boxes rather than as a page — and the bands
 * are a printing constraint, not a thing the designer is meant to think about.
 */
function Band({
  band,
  active,
  minPx,
  onPointerDown,
  children,
}: {
  band: BandKey
  active: boolean
  minPx: number
  onPointerDown: (e: React.PointerEvent) => void
  children: React.ReactNode
}) {
  const info = BAND_INFO[band]
  return (
    <section
      className={`relative ${band === 'body' ? 'py-2' : 'py-1'} ${
        active ? 'rounded-card outline-dashed outline-1 outline-offset-4 outline-brand/40' : ''
      }`}
      style={band === 'body' ? undefined : { minHeight: `${minPx}px` }}
      onPointerDown={onPointerDown}
      aria-label={info.label}
    >
      {active && (
        <span className="pointer-events-none absolute -top-2 right-0 z-20 rounded-badge bg-brand px-1.5 py-0.5 text-[10px] font-medium text-on-brand">
          {info.label}
        </span>
      )}
      {children}
    </section>
  )
}

/**
 * One block, in its box, showing its real compiled markup.
 *
 * Not a stand-in labelled "Letterhead". The whole design exists so the canvas
 * and the printer share one compiler, and the moment the canvas draws a mock the
 * preview can lie — which is the failure this replaces a much simpler
 * implementation to avoid.
 */
function BlockBox({
  block,
  rect,
  html,
  selected,
  outlined,
  register,
  onBegin,
}: {
  block: DocBlock
  rect: Rect
  html: string
  selected: boolean
  outlined: boolean
  register: (el: HTMLDivElement | null) => void
  onBegin: (e: React.PointerEvent, b: DocBlock, mode: 'move' | 'resize-l' | 'resize-r') => void
}) {
  const def = DOC_BLOCK_CATALOG[block.kind]
  const flow = block.band === 'body'

  /*
   * No alignment class on the box: `blockMarkup` carries it, so the canvas and
   * the printed page take it from one place rather than each applying their own.
   * The divergence that captioned an empty notes block on screen and left it
   * blank on paper started exactly that way.
   */
  return (
    <div
      ref={register}
      className={`group cursor-move rounded-sm ring-offset-2 ${
        selected
          ? 'ring-2 ring-brand'
          : outlined
            ? 'ring-1 ring-border-strong'
            : 'hover:ring-1 hover:ring-border-strong'
      }`}
      style={
        flow
          ? { width: `${rect.w}%` }
          : {
              position: 'absolute',
              left: `${rect.x}%`,
              top: `${rect.y * BAND_PX}px`,
              width: `${rect.w}%`,
            }
      }
      onPointerDown={(e) => onBegin(e, block, 'move')}
      aria-label={def.label}
    >
      {/*
        The name — when selected, when the outlines are on, or on hover. A block
        showing its real content is readable but not always identifiable: an
        empty notes block is a heading over nothing, and a rule is a line.

        It follows the outline switch deliberately. While laying a page out,
        "where does this block end" and "what is it" are one question, so a
        labelled outline answers both at a glance; turning the outlines off is
        asking to see the paper, and a row of captions over it is not that.
      */}
      <span
        className={`pointer-events-none absolute -top-4 left-0 z-10 rounded-badge px-1 text-[10px] font-medium ${
          selected
            ? 'bg-brand text-on-brand'
            : outlined
              ? 'bg-surface-2 text-muted'
              : 'bg-surface-2 text-muted opacity-0 group-hover:opacity-100'
        }`}
      >
        {def.label}
        {/*
          A conditional block says so ON the page, not only in the inspector.
          "Why is this paragraph missing from my printed invoice" is answered by
          looking at the design, and a block that prints only sometimes is
          indistinguishable from one that always does until you click it.

          It rides the existing caption rather than adding a second marker: the
          caption already appears exactly when a designer is looking at
          structure — selected, hovered, or outlines on.
        */}
        {block.showWhen && (
          <span className="opacity-80"> · {conditionDef(block.showWhen)?.label}</span>
        )}
      </span>

      <div
        className="pointer-events-none min-h-[1rem]"
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {/* Side handles only, and only when selected. Width is the one dimension a
          block has; its height is whatever its content came to. */}
      {selected && !flow && (
        <>
          <Handle side="l" onPointerDown={(e) => onBegin(e, block, 'resize-l')} />
          <Handle side="r" onPointerDown={(e) => onBegin(e, block, 'resize-r')} />
        </>
      )}
    </div>
  )
}

function Handle({
  side,
  onPointerDown,
}: {
  side: 'l' | 'r'
  onPointerDown: (e: React.PointerEvent) => void
}) {
  return (
    <button
      type="button"
      aria-label={side === 'l' ? 'Widen from the left' : 'Widen from the right'}
      onPointerDown={onPointerDown}
      className={`absolute top-1/2 z-10 h-6 w-2 -translate-y-1/2 cursor-ew-resize rounded-sm bg-brand ${
        side === 'l' ? '-left-1' : '-right-1'
      }`}
    />
  )
}

/** The line that says why a block stopped where it did. */
function GuideLine({ guide }: { guide: Guide }) {
  /*
   * The span is clamped to the page.
   *
   * `alignmentFor` measures from the block's snapped position, which during a
   * drag is where the pointer put it and not yet where `clampBlock` will allow —
   * so a block dragged towards the left edge produces a guide starting at a
   * negative percent, drawn out over the chrome beside the paper. The guide is
   * telling the truth about the gesture; it just has no business leaving the
   * page to do it.
   */
  const from = Math.max(0, Math.min(guide.from, 100))
  const to = Math.max(0, Math.min(guide.to, 100))
  const span = Math.max(to - from, 0)

  const style =
    guide.axis === 'v'
      ? {
          left: `${Math.max(0, Math.min(guide.at, 100))}%`,
          // Vertical extent is a band position, so only the start is clamped:
          // a band has no top edge to run past and grows to fit.
          top: `${Math.max(0, guide.from) * BAND_PX}px`,
          height: `${Math.max(guide.to - Math.max(0, guide.from), 0) * BAND_PX}px`,
          width: '1px',
        }
      : {
          top: `${Math.max(0, guide.at) * BAND_PX}px`,
          left: `${from}%`,
          width: `${span}%`,
          height: '1px',
        }
  return <div className="pointer-events-none absolute z-20 bg-brand" style={style} />
}

/**
 * How far the block is from its nearest neighbour.
 *
 * A number, because "how much space is between these" is the question a designer
 * is actually asking when they nudge something, and eyeballing two rectangles
 * answers it badly.
 */
function GapLabel({ gap }: { gap: GapReading }) {
  const mid = (gap.from + gap.to) / 2
  return (
    <span
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-1/2 rounded-badge bg-ink px-1 text-[10px] font-medium text-surface"
      style={
        gap.axis === 'x'
          ? { left: `${mid}%`, top: '50%' }
          : { left: '50%', top: `${mid * BAND_PX}px` }
      }
    >
      {gap.distance.toFixed(1)}
    </span>
  )
}
