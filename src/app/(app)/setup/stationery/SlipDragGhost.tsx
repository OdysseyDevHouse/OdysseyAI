'use client'

import { useEffect, useState } from 'react'

/**
 * The line you are carrying, under the cursor.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Picking a tile up out of the palette changed nothing on screen until the
 * pointer reached the paper and the landing strip appeared. Between those two
 * moments the gesture was invisible: the mouse was simply moving, and there was
 * no way to tell a drag in progress from a click that had not registered.
 *
 * So the carried line follows the pointer. It answers the only two questions a
 * drag raises — am I dragging, and what am I dragging — and it answers them
 * from the moment the tile leaves the palette rather than on arrival.
 *
 * ── A PORTAL-LESS FIXED LAYER ─────────────────────────────────────────────
 *
 * `position: fixed` against the viewport, so it is not clipped by the palette's
 * own `overflow-y-auto` — a ghost that vanished at the edge of the panel it
 * came from would be worse than none. No portal is needed for that; fixed
 * positioning already escapes the scroll box, and the ancestors here set no
 * transform or filter, which are the only things that would re-root it.
 *
 * ── IT NEVER TAKES THE POINTER ────────────────────────────────────────────
 *
 * `pointer-events-none`, because it sits directly under the cursor and would
 * otherwise swallow the pointerup that completes the drop, and every move
 * event the canvas needs to work out which gap it is over.
 */
export default function SlipDragGhost({ label }: { label: string }) {
  /*
   * Null until the pointer first moves, so the ghost does not flash at the
   * top-left corner before it knows where the cursor is. On a real drag the
   * first move follows the press within a few milliseconds.
   */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent) => setAt({ x: e.clientX, y: e.clientY })
    /*
     * On the WINDOW, in the capture phase. The pointer travels across the
     * palette, the gap between the panels and the paper, and a listener on any
     * one of those would go quiet over the others.
     */
    window.addEventListener('pointermove', onMove, true)
    return () => window.removeEventListener('pointermove', onMove, true)
  }, [])

  if (!at) return null

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-50 flex items-center gap-1.5 rounded-control border border-brand bg-surface px-2.5 py-1.5 text-sm text-ink shadow-pop"
      /*
       * Offset RIGHT of the cursor and centred on it vertically.
       *
       * Down-and-right is the usual place for a drag chip, but here the thing
       * the pointer is aiming at is a horizontal landing strip directly below
       * it — and the chip sat right on top of it, hiding the one piece of
       * feedback that says where the line will go. Clearing the vertical axis
       * keeps both readable at once.
       */
      style={{ left: at.x + 16, top: at.y, transform: 'translateY(-50%)' }}
    >
      <span className="size-1.5 rounded-pill bg-brand" />
      {label}
    </div>
  )
}
