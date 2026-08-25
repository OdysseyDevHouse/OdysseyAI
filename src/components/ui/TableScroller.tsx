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
    /* Gutter on the static frame, scrolling on the box inside it. Keeping the
       two apart is what lets a sticky header sit flush at `top-0` — see
       TABLE_FRAME. `className` lands on the frame so a caller adjusting the
       gutter does not accidentally start the scroll box scrolling its padding. */
    <div className={`${TABLE_FRAME} ${className}`}>
      <div ref={ref} className={TABLE_SCROLLER} style={{ maxHeight: cap }}>
        {children}
      </div>
    </div>
  )
}
