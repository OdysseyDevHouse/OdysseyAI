'use client'

import { useRef, type ReactNode } from 'react'
import { TABLE_FRAME, TABLE_SCROLLER } from './styles'
import { useFitViewport } from './useFitViewport'

/**
 * The scroll box a wide table sits in, capped to the room left below it.
 *
 * This exists as its own client component so a SERVER component can use it.
 * StoreColumnTable — every multi-store report — is rendered straight from
 * server pages, so it cannot call a hook itself; wrapping the box here keeps
 * the measuring on the client and leaves the table a server component.
 *
 * See `useFitViewport` for why the cap is measured rather than a constant.
 */
export function TableScroller({
  children,
  className = '',
}: {
  children: ReactNode
  /** Extra classes for the box — padding, mostly. */
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const cap = useFitViewport(ref)

  return (
    /* Static frame outside, scrolling box inside. Keeping the two apart is what
       lets a sticky header sit flush at `top-0` — see TABLE_FRAME. `className`
       lands on the frame so a caller adding padding does not accidentally start
       the scroll box scrolling it.

       TABLE_FRAME, so a report sits flush to its card exactly like every list
       in the app. These tables scroll sideways and the scrollbar is an overlay,
       so while it is being dragged it covers the last column — the same trade
       DataTable makes, and taken here for the same reason: one edge everywhere
       beats a gutter on the one screen that looks different because of it. */
    <div className={`${TABLE_FRAME} ${className}`}>
      <div ref={ref} className={TABLE_SCROLLER} style={{ maxHeight: cap }}>
        {children}
      </div>
    </div>
  )
}
