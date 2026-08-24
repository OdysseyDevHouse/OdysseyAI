'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Cap an element to the room actually left below it on screen.
 *
 * The problem this solves is the horizontal scrollbar on a wide table. A table
 * wrapped in a bare `overflow-x-auto` grows to its full height, so its
 * horizontal scrollbar sits at the BOTTOM OF THE DATA — on a 300-row report
 * that means scrolling to the end of the report to reach the scrollbar,
 * dragging it, then scrolling all the way back up to read the columns you just
 * revealed. Capping the height moves that scrollbar to the bottom of the
 * WINDOW, where it is always in reach.
 *
 * The cap has to be MEASURED rather than guessed. The chrome above a table —
 * app header, page header, toolbar, filter bar, stat strip, card border —
 * differs on every screen: 341px on the price list, less on a report with no
 * filters, more on one with a stat strip. A fixed `max-h-[calc(100dvh-16rem)]`
 * is right on exactly one screen and wrong everywhere else, either wasting
 * height or pushing the scrollbar back below the fold. So: read where the
 * element actually landed and give it what is left.
 *
 * Returns a max-height in px, or `undefined` before the first measurement and
 * whenever the element is short enough not to need capping — in which case the
 * caller must render NO cap at all, so a ten-row list looks exactly as it did
 * before this existed: no inner scrollbar, no fixed dead space beneath it.
 */
export function useFitViewport(
  ref: RefObject<HTMLElement | null>,
  /** Breathing room under the element, so it does not sit flush on the edge. */
  gutter = 16,
): number | undefined {
  const [cap, setCap] = useState<number | undefined>(undefined)
  /* The measured cap CHANGES the element's height, which the observer sees as a
     resize, which re-measures... Holding the last value and bailing when it has
     not really moved is what stops that loop. A ref, not state: it must not
     itself cause a render. */
  const last = useRef<number | undefined>(undefined)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    function measure() {
      const el = ref.current
      if (!el) return

      const top = el.getBoundingClientRect().top
      const room = Math.round(window.innerHeight - top - gutter)

      /* Off-screen, or squeezed to nothing: leave it uncapped rather than
         collapsing it to a sliver. A table inside a closed dialog or a
         non-active tab measures 0 here, and capping it to 0 would render an
         empty box the moment it opened. */
      if (room < MIN_ROOM) {
        if (last.current !== undefined) {
          last.current = undefined
          setCap(undefined)
        }
        return
      }

      /* scrollHeight is the UNCAPPED content height only while no cap is
         applied; once capped it reports the same thing, because the content
         still overflows. Either way, content that fits in the room available
         needs no cap — and must not get one, or it gains dead space under it. */
      const content = el.scrollHeight
      if (last.current === undefined && content <= room) return

      if (last.current !== undefined && Math.abs(room - last.current) < 2) return

      last.current = room
      setCap(room)
    }

    measure()

    /* Three things move the bottom edge: the window resizing, the element's own
       content changing (rows loading, a filter narrowing the list), and the
       chrome above it changing height (a toolbar wrapping to two lines, a
       filter bar opening). The observer on the element catches the second; the
       one on <body> catches the third. */
    const onResize = () => measure()
    window.addEventListener('resize', onResize)

    const observer = new ResizeObserver(measure)
    observer.observe(node)
    if (node.ownerDocument.body) observer.observe(node.ownerDocument.body)

    return () => {
      window.removeEventListener('resize', onResize)
      observer.disconnect()
    }
  }, [ref, gutter])

  return cap
}

/* Below this a capped pane shows a row and a half and reads as broken; better
   to leave it uncapped and let the page scroll. */
const MIN_ROOM = 180
