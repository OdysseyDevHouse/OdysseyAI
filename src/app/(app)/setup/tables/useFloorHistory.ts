'use client'

import { useCallback, useRef, useState } from 'react'
import type { TableShape } from '@/lib/site/floorGeometry'

/**
 * Undo/redo for floor GEOMETRY — position, size, angle and shape.
 *
 * ── WHY GEOMETRY ONLY, AND NOT EVERY EDIT ─────────────────────────────────
 *
 * Undo has to be trustworthy: a stack that reverses some actions and silently ignores
 * others is worse than no undo, because the user stops being able to predict what Ctrl+Z
 * will do. Geometry is the thing you change constantly, by hand, and get wrong — a drag
 * that overshoots has no other way back, since the original position is gone the moment
 * you release. Creating a room, retiring one, or adding a feature is deliberate, is
 * confirmed, and has an obvious manual reversal; those stay out, and the button's
 * tooltip says so rather than leaving the user to find out.
 *
 * ── THE MODEL ─────────────────────────────────────────────────────────────
 *
 * Each entry records the BEFORE and AFTER geometry of everything one gesture touched.
 * Undo replays `before`, redo replays `after`. Storing both ends — rather than only
 * `before` and inferring the other — is what lets redo work after a chain of undos
 * without re-deriving state that may since have been clamped by the room.
 *
 * A new gesture after undoing truncates the redo tail: the standard model, and the one
 * users already expect from every other editor.
 */

/** Just the fields a gesture can change. Ids are `t12` / `f3`, so one stack covers both. */
export type Geometry = {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  shape?: TableShape
}

export type GeometryChange = {
  id: string
  before: Geometry
  after: Geometry
}

/** How many gestures back you can go. Enough for a whole layout session. */
const LIMIT = 50

function same(a: Geometry, b: Geometry): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.rotation === b.rotation &&
    a.shape === b.shape
  )
}

export function useFloorHistory(
  /** Applies a set of geometries — used by both undo and redo. */
  applyGeometries: (changes: { id: string; geo: Geometry }[]) => void,
) {
  const past = useRef<GeometryChange[][]>([])
  const future = useRef<GeometryChange[][]>([])
  /* Mirrored into state purely so the toolbar buttons can enable and disable; the refs
     stay the source of truth so a rapid Ctrl+Z chain cannot race a render. */
  const [depth, setDepth] = useState({ undo: 0, redo: 0 })

  const sync = useCallback(() => {
    setDepth({ undo: past.current.length, redo: future.current.length })
  }, [])

  /** Record one completed gesture. No-ops when nothing actually moved. */
  const record = useCallback(
    (changes: GeometryChange[]) => {
      const real = changes.filter((c) => !same(c.before, c.after))
      if (real.length === 0) return
      past.current.push(real)
      if (past.current.length > LIMIT) past.current.shift()
      /* Branching from a mid-history state discards the tail, as every editor does. */
      future.current = []
      sync()
    },
    [sync],
  )

  const undo = useCallback(() => {
    const entry = past.current.pop()
    if (!entry) return false
    future.current.push(entry)
    applyGeometries(entry.map((c) => ({ id: c.id, geo: c.before })))
    sync()
    return true
  }, [applyGeometries, sync])

  const redo = useCallback(() => {
    const entry = future.current.pop()
    if (!entry) return false
    past.current.push(entry)
    applyGeometries(entry.map((c) => ({ id: c.id, geo: c.after })))
    sync()
    return true
  }, [applyGeometries, sync])

  /**
   * Drop the history.
   *
   * Called when the floor changes underneath us in a way the stack cannot describe —
   * switching rooms, or a feature being added or deleted — because an entry naming
   * something that no longer exists, or something in another room, would undo into
   * nonsense.
   */
  const clear = useCallback(() => {
    past.current = []
    future.current = []
    sync()
  }, [sync])

  return { record, undo, redo, clear, canUndo: depth.undo > 0, canRedo: depth.redo > 0 }
}
