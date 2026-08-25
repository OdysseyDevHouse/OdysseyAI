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
  /**
   * Breathing room under everything, so the last row does not sit flush on the
   * screen's edge. This is IN ADDITION to the trailing chrome measured below —
   * it is the gap you want left over, not an allowance for the page's padding.
   */
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

      /* What sits BELOW this element still has to fit on the screen.
         Measuring only from the element's own top to the viewport's bottom
         ignores the frame's gutter, the card's border and PageBody's `pb-10`,
         so the element was capped to a height that made the PAGE overflow by
         exactly that trailing chrome — giving a screen two scrollbars, the
         outer one scrolling nothing but padding.

         `trailing` walks from the element out to the scrolling ancestor,
         adding each parent's bottom padding/border/margin plus the height of
         any later sibling, which is that chrome measured rather than assumed
         — a screen that adds a footnote under its table stays correct. */
      const scroller = scrollParent(el)
      const bottomLimit = scroller
        ? scroller.getBoundingClientRect().bottom
        : window.innerHeight
      const room = Math.round(bottomLimit - top - trailingSpace(el, scroller) - gutter)

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

/**
 * The nearest ancestor that actually scrolls, or null for the viewport.
 *
 * The app shell is `h-screen overflow-hidden` with the scrolling done by an
 * inner `<main class="overflow-y-auto">`, so the bottom edge a table has to fit
 * inside is that element's, not the window's. They usually coincide; they stop
 * coinciding the moment a table is rendered inside a drawer or a dialog.
 */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflowY = getComputedStyle(p).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') return p
  }
  return null
}

/**
 * How much space is committed BELOW `el` but still inside `scroller`.
 *
 * Walks outward, adding at each level the parent's own bottom padding, border
 * and margin, plus the full height of any sibling that comes after — the
 * gutter under a table, the card's border, PageBody's `pb-10`, a footnote.
 *
 * Measured rather than assumed: a caller that adds something under its table
 * gets a correct cap without teaching this hook about it.
 */
function trailingSpace(el: HTMLElement, scroller: HTMLElement | null): number {
  let total = 0
  let node: HTMLElement = el

  for (let p = node.parentElement; p; node = p, p = p.parentElement) {
    for (let sib = node.nextElementSibling; sib; sib = sib.nextElementSibling) {
      const rect = sib.getBoundingClientRect()
      const cs = getComputedStyle(sib)
      /* An absolutely positioned sibling is out of flow and takes no room. */
      if (cs.position === 'absolute' || cs.position === 'fixed') continue
      total += rect.height
    }

    const cs = getComputedStyle(p)
    total +=
      parseFloat(cs.paddingBottom || '0') +
      parseFloat(cs.borderBottomWidth || '0') +
      parseFloat(cs.marginBottom || '0')

    if (p === scroller) break
  }

  return Math.round(total)
}
