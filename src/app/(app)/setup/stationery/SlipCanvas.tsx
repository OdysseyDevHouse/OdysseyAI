'use client'

import { useCallback, useRef, useState } from 'react'
import { SLIP_BLOCK_INFO, type SlipBlock, type SlipSpec } from '@/lib/stationery/slip'

/**
 * The slip, as a thing you click on and drag.
 *
 * ── ONE COLUMN, AND THAT IS THE WHOLE GEOMETRY ────────────────────────────
 *
 * The A4 canvas gives a block an x and a y because a page has both. A slip has
 * neither: 80mm of paper goes through a thermal head one line at a time, so the
 * only question a designer can meaningfully answer is what comes before what.
 *
 * So this drags UP AND DOWN and nothing else. Not a reduced version of the A4
 * canvas — a different question with a smaller answer, and offering free
 * placement here would be offering control the printer cannot honour.
 *
 * ── CLICK THE SLIP, NOT A LIST BESIDE IT ──────────────────────────────────
 *
 * That is the part this exists for. Changing the business name to centred used
 * to mean finding "Business name" in a list of seventeen settings and reading
 * across to its controls. Now the business name on the slip IS the control: click
 * it, and its alignment, size and weight are right there.
 *
 * ── POINTER EVENTS, NOT dnd-kit ───────────────────────────────────────────
 *
 * Same call FloorCanvas and the A4 canvas made, and here it is even clearer: the
 * question is "which gap did this land in", the list is short, and a library
 * that tracks droppables and computes collisions is a large dependency for an
 * insertion index. A drag reports one number.
 */
export default function SlipCanvas({
  spec,
  html,
  selected,
  onSelect,
  onReorder,
}: {
  spec: SlipSpec
  /** Each block's rendered markup, by index. Empty where it prints nothing. */
  html: string[]
  selected: number | null
  onSelect: (index: number | null) => void
  /** Move the block at `from` so it sits at `to`. */
  onReorder: (from: number, to: number) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  /**
   * Which gap the pointer is nearest.
   *
   * Measured from the rendered rows rather than tracked with droppables: a gap
   * is a position in a list, and the row midpoints are all it takes to find one.
   */
  const gapAt = useCallback((clientY: number): number => {
    const rows = [...(listRef.current?.querySelectorAll('[data-slip-row]') ?? [])]
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect()
      if (clientY < r.top + r.height / 2) return i
    }
    return rows.length
  }, [])

  const onPointerDown = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    onSelect(index)
    setDragging(index)
    listRef.current?.setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragging === null) return
    setOver(gapAt(e.clientY))
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (dragging === null) return
    const to = gapAt(e.clientY)
    listRef.current?.releasePointerCapture?.(e.pointerId)

    /*
     * A gap counts positions in the list as it is NOW, so a block moving DOWN
     * passes its own slot on the way and lands one place short. The same
     * correction every sortable list needs.
     */
    const target = to > dragging ? to - 1 : to
    setDragging(null)
    setOver(null)
    if (target !== dragging) onReorder(dragging, target)
  }

  return (
    <div
      ref={listRef}
      className="mx-auto w-full max-w-[72mm] select-none bg-surface p-3 text-[12px] text-ink"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDragging(null)
        setOver(null)
      }}
    >
      {spec.blocks.map((b, i) => {
        const info = SLIP_BLOCK_INFO[b.kind]
        const isSelected = selected === i
        const isDragging = dragging === i
        const markup = html[i] ?? ''

        return (
          <div key={i}>
            {/* The landing strip, drawn only while something is being carried. */}
            {dragging !== null && over === i && (
              <div className="my-0.5 h-0.5 rounded-full bg-brand" />
            )}

            <div
              data-slip-row
              role="button"
              tabIndex={0}
              aria-label={info.label}
              aria-pressed={isSelected}
              onPointerDown={(e) => onPointerDown(e, i)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(i)
                }
                /*
                 * The keyboard path for reordering. A drag is a pointer gesture
                 * and a keyboard has none, so alt+arrow moves the selected block
                 * — which is what a design tool does, and far simpler than
                 * steering a drag library with coordinates.
                 */
                if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                  e.preventDefault()
                  const to = i + (e.key === 'ArrowUp' ? -1 : 1)
                  if (to >= 0 && to < spec.blocks.length) onReorder(i, to)
                }
              }}
              className={`relative cursor-grab rounded-sm px-1 py-0.5 ${
                isSelected ? 'bg-brand/10 ring-1 ring-brand' : 'hover:bg-surface-2'
              } ${isDragging ? 'opacity-40' : ''}`}
            >
              {markup ? (
                <div
                  className="pointer-events-none"
                  dangerouslySetInnerHTML={{ __html: markup }}
                />
              ) : (
                /*
                 * A block that prints nothing TODAY — a VAT number on a
                 * non-vendor, a customer on a cash sale. It stays on the canvas
                 * because it is part of the design and must be movable, but it
                 * says what it is rather than being an empty box nobody can
                 * account for.
                 */
                <p className="pointer-events-none text-[10px] italic text-faint opacity-60">
                  {info.label} · not on this sale
                </p>
              )}
            </div>
          </div>
        )
      })}

      {/* The gap after the last block. */}
      {dragging !== null && over === spec.blocks.length && (
        <div className="my-0.5 h-0.5 rounded-full bg-brand" />
      )}
    </div>
  )
}

export type { SlipBlock }
