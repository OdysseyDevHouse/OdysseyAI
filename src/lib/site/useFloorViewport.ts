'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Pan and zoom for a floor plan — the Google Maps gesture set.
 *
 * ── WHY A TRANSFORM AND NOT A SCROLLING BOX ───────────────────────────────
 *
 * The obvious way to see a room bigger than the screen is `overflow: auto`, and it is
 * the wrong one on a till. Scrollbars are a miserable target for a finger, many of the
 * panels these shops run are resistive digitizers whose driver reports `pointerType:
 * "mouse"` so the browser's own touch scrolling never engages, and scrolling cannot zoom
 * at all. A waiter looking for "the big round one by the window" wants to grab the floor
 * and move it, then spread two fingers to read a crowded corner.
 *
 * So the room is drawn at a fixed size and a CSS transform moves it: `scale` for zoom,
 * `translate` for pan. One matrix, no scrollbars, and pinch falls out of the same maths
 * as drag.
 *
 * ── ONE HOOK, BOTH SCREENS ────────────────────────────────────────────────
 *
 * The designer and the till share this deliberately. A waiter who learns the gesture on
 * one must find it on the other, and two implementations of a pinch handler is two sets
 * of rounding bugs. It lives in `lib/site` rather than beside either screen for the same
 * reason `floorGeometry` does.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * No momentum fling. The legacy pan had one, and on a floor plan it is a liability: a
 * flick that coasts leaves the room somewhere nobody chose, and a manager mid-layout
 * wants the floor to stop where they let go. Maps apps get away with it because the
 * content is infinite; a room has edges.
 */

export type Viewport = {
  /** Zoom factor. 1 = the room fits its pane exactly. */
  scale: number
  /** Pan offset in PIXELS, applied after the scale. */
  x: number
  y: number
}

const IDENTITY: Viewport = { scale: 1, x: 0, y: 0 }

/** How far out and in a user may go. Below 1 the room is smaller than its pane. */
export const MIN_SCALE = 0.4
export const MAX_SCALE = 4

/** Pixels of travel before a press counts as a pan rather than a tap. */
const PAN_SLOP = 5

type Pointer = { x: number; y: number }

export function useFloorViewport({
  enabled = true,
  panWith,
  onTap,
}: {
  /**
   * Off while another gesture owns the surface — the designer turns it off in edit mode,
   * where a drag moves a TABLE and panning the floor at the same time would mean two
   * things claiming one gesture.
   */
  enabled?: boolean
  /**
   * A predicate that claims a press for panning even while `enabled` is false.
   *
   * This is how the designer keeps panning available in edit mode without the two
   * gestures fighting: a plain drag there moves a table or draws a marquee, and Ctrl-drag
   * pans. The modifier is what disambiguates, so the caller states the rule rather than
   * this hook guessing at one.
   *
   * PINCH IS NEVER GATED by this — two fingers on a touchscreen have no modifier key
   * available, and zooming while arranging a floor is exactly what a manager wants.
   */
  panWith?: (e: React.PointerEvent) => boolean
  /** A press that never became a pan. The caller decides what a tap means. */
  onTap?: (e: PointerEvent) => void
} = {}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<Viewport>(IDENTITY)
  const [panning, setPanning] = useState(false)

  /*
   * Live pointers, keyed by pointerId.
   *
   * A Map rather than two fields because a third finger landing mid-pinch must not be
   * mistaken for the second one moving — the two we pinch with are simply the first two
   * still down, and everything else is ignored until it lifts.
   */
  const pointers = useRef(new Map<number, Pointer>())
  const gesture = useRef<{
    mode: 'none' | 'maybe' | 'pan' | 'pinch'
    startX: number
    startY: number
    /** Viewport as it was when the gesture began — every delta is applied to this. */
    from: Viewport
    /** Distance between the two fingers when a pinch began. */
    startSpan: number
    /** Midpoint between them, in element coordinates. */
    startMidX: number
    startMidY: number
  }>({
    mode: 'none',
    startX: 0,
    startY: 0,
    from: IDENTITY,
    startSpan: 0,
    startMidX: 0,
    startMidY: 0,
  })

  const reset = useCallback(() => setView(IDENTITY), [])

  /** Clamp a scale into range. */
  const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

  /**
   * Zoom about a fixed point, so the pixel under the fingers stays under the fingers.
   *
   * This is the whole difference between a zoom that feels like a map and one that feels
   * like a slider: scaling about the origin makes the content slide out from under you,
   * and on a floor plan you are always zooming into something specific.
   */
  const zoomAt = useCallback((nextScale: number, px: number, py: number, from: Viewport) => {
    const scale = clampScale(nextScale)
    const ratio = scale / from.scale
    return {
      scale,
      x: px - (px - from.x) * ratio,
      y: py - (py - from.y) * ratio,
    }
  }, [])

  /** Pointer position in ELEMENT coordinates. */
  const local = useCallback((e: { clientX: number; clientY: number }) => {
    const box = surfaceRef.current?.getBoundingClientRect()
    if (!box) return { x: 0, y: 0 }
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }, [])

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      /*
       * EVERY touch is tracked, even one we will not act on.
       *
       * The gate is on what a gesture DOES, not on whether the pointer is recorded —
       * because a pinch is recognised from the second finger, and if the first was never
       * stored there is nothing to measure a span against. That is exactly what broke
       * pinch-to-zoom in the designer's edit mode: the first finger carried no Ctrl, was
       * discarded, and the second one arrived alone.
       */
      const p = local(e)
      pointers.current.set(e.pointerId, p)

      const live = [...pointers.current.values()]
      if (live.length === 1) {
        /* A single finger only pans when panning is on, or the caller's modifier claims
           it. Otherwise it is recorded and ignored — the host's own handler owns it. */
        if (!enabled && panWith?.(e) !== true) {
          gesture.current.mode = 'none'
          return
        }
        /* 'maybe', not 'pan': a press that never travels is a TAP, and committing to a
           pan here would swallow every click on the floor. */
        gesture.current = {
          ...gesture.current,
          mode: 'maybe',
          startX: p.x,
          startY: p.y,
          from: view,
        }
        surfaceRef.current?.setPointerCapture(e.pointerId)
      } else if (live.length === 2) {
        /* Two fingers ALWAYS pinch, in every mode. There is no modifier key on a
           touchscreen, and a manager arranging a floor needs to zoom as much as a waiter
           reading one. */
        const [a, b] = live
        gesture.current = {
          mode: 'pinch',
          startX: 0,
          startY: 0,
          from: view,
          startSpan: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          startMidX: (a.x + b.x) / 2,
          startMidY: (a.y + b.y) / 2,
        }
        setPanning(true)
      }
    },
    [enabled, panWith, local, view],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      /* Gated on whether WE started this gesture, not on `enabled` — a Ctrl-drag claimed
         in edit mode has to keep tracking even though panning is otherwise off. */
      if (!pointers.current.has(e.pointerId)) return
      pointers.current.set(e.pointerId, local(e))

      const g = gesture.current
      const live = [...pointers.current.values()]

      if (g.mode === 'pinch' && live.length >= 2) {
        const [a, b] = live
        const span = Math.hypot(a.x - b.x, a.y - b.y) || 1
        const midX = (a.x + b.x) / 2
        const midY = (a.y + b.y) / 2
        /* Zoom about the midpoint AND follow it, so a two-finger drag pans while it
           scales — which is what a map does and what fingers expect. */
        const zoomed = zoomAt(g.from.scale * (span / g.startSpan), g.startMidX, g.startMidY, g.from)
        setView({
          scale: zoomed.scale,
          x: zoomed.x + (midX - g.startMidX),
          y: zoomed.y + (midY - g.startMidY),
        })
        return
      }

      const p = local(e)
      const dx = p.x - g.startX
      const dy = p.y - g.startY

      if (g.mode === 'maybe') {
        if (Math.hypot(dx, dy) < PAN_SLOP) return
        gesture.current = { ...g, mode: 'pan' }
        setPanning(true)
      }
      if (gesture.current.mode !== 'pan') return

      setView({ scale: g.from.scale, x: g.from.x + dx, y: g.from.y + dy })
    },
    [local, zoomAt],
  )

  const endPointer = useCallback(
    (e: React.PointerEvent) => {
      const wasMaybe = gesture.current.mode === 'maybe'
      pointers.current.delete(e.pointerId)
      try {
        surfaceRef.current?.releasePointerCapture(e.pointerId)
      } catch {
        /* Already released, or never captured — nothing to undo. */
      }

      if (pointers.current.size === 0) {
        /* A press that never travelled far enough to become a pan is a tap. Reported
           here rather than via onClick because pointer capture eats the click. */
        if (wasMaybe) onTap?.(e.nativeEvent)
        gesture.current.mode = 'none'
        setPanning(false)
      } else if (pointers.current.size === 1) {
        /* One finger lifted out of a pinch. Re-seat the survivor as a pan origin so the
           floor does not jump when it keeps moving. */
        const [only] = [...pointers.current.values()]
        gesture.current = { ...gesture.current, mode: 'pan', startX: only.x, startY: only.y, from: view }
      }
    },
    [onTap, view],
  )

  /**
   * Wheel to zoom, with Ctrl or a trackpad pinch.
   *
   * Bound as a NON-PASSIVE native listener rather than through React, because React
   * attaches wheel passively and `preventDefault` in a passive listener is ignored —
   * the page would scroll behind the plan on every zoom.
   */
  useEffect(() => {
    /* Bound regardless of `enabled`: Ctrl+wheel zooms in edit mode too, for the same
       reason pinch does — a manager arranging a crowded corner needs to get close, and
       leaving Done as the only way to zoom is the round trip this all exists to remove. */
    const node = surfaceRef.current
    if (!node) return
    const onWheel = (e: WheelEvent) => {
      /* Plain wheel scrolls the page; Ctrl+wheel (and a trackpad pinch, which the
         browser reports as exactly that) zooms. Same rule as every map and editor. */
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const box = node.getBoundingClientRect()
      const px = e.clientX - box.left
      const py = e.clientY - box.top
      setView((current) => {
        const factor = Math.exp(-e.deltaY * 0.0015)
        const scale = clampScale(current.scale * factor)
        const ratio = scale / current.scale
        return { scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }
      })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  /** Step the zoom from a button, about the pane's centre. */
  const zoomBy = useCallback(
    (factor: number) => {
      const box = surfaceRef.current?.getBoundingClientRect()
      const px = (box?.width ?? 0) / 2
      const py = (box?.height ?? 0) / 2
      setView((current) => zoomAt(current.scale * factor, px, py, current))
    },
    [zoomAt],
  )

  return {
    surfaceRef,
    view,
    /** True while a pan or pinch is running — for the grabbing cursor. */
    panning,
    /** Spread onto the scrolling surface. */
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
    },
    reset,
    zoomBy,
    /** Whether the view has been moved at all — drives the "Reset view" button. */
    moved: view.scale !== 1 || view.x !== 0 || view.y !== 0,
  }
}
