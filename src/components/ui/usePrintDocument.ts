'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Printing one of the app's print routes without showing it to anybody.
 *
 * ── WHY NOT window.open ───────────────────────────────────────────────────
 *
 * The obvious way to print a document from a dialog is to open its print route
 * in a tab and let `?auto=1` fire the print dialog there. It works, but the
 * reader gets a tab of rendered HTML thrown at them on the way, and is left
 * holding it afterwards — which for somebody who only wanted a copy of the
 * invoice they were reading is two extra actions and a lost place.
 *
 * ── WHY NOT window.print ──────────────────────────────────────────────────
 *
 * And it cannot simply be `window.print()` on the current page: the caller is
 * a dialog over a report, so what would go to paper is the REPORT, with the
 * dialog stamped across it.
 *
 * ── SO: AN IFRAME ─────────────────────────────────────────────────────────
 *
 * The print route is loaded into a hidden iframe instead. An iframe is its own
 * document, so it loads the (print) group's stylesheets in their own cascade —
 * which is what makes the A4 `@page` beat the group's 80mm default exactly as
 * it does in a tab. Nothing else on the page is involved, and the toolbar the
 * route renders is `print-hidden` and never reaches paper.
 *
 * `?auto=1` is passed through so the route prints ITSELF once it has laid out,
 * using the same 150ms beat it already uses for a tab. That deliberately keeps
 * one answer to "when is this page ready to print" rather than inventing a
 * second one out here, where nothing can see the fonts load.
 *
 * ── THE FRAME IS HIDDEN, NOT ABSENT ───────────────────────────────────────
 *
 * It is positioned off-screen at a real A4-ish size rather than given
 * `display:none` or zero dimensions: a frame with no box does not lay out, and
 * a document that has not laid out prints blank. This is the one thing about
 * this approach that silently produces an empty sheet if got wrong.
 */
export function usePrintDocument() {
  /* Reused across calls so a reader printing several documents in a row does
     not accumulate a frame per print. */
  const frameRef = useRef<HTMLIFrameElement | null>(null)

  /* Torn down with the component that owns it. A dialog that is closed mid
     print has no business leaving a frame behind in the document. */
  useEffect(() => {
    return () => {
      frameRef.current?.remove()
      frameRef.current = null
    }
  }, [])

  return useCallback((href: string) => {
    let frame = frameRef.current
    if (!frame) {
      frame = document.createElement('iframe')
      /* Off-screen rather than hidden — see the note above on why a frame
         with no box prints a blank sheet. */
      frame.setAttribute(
        'style',
        'position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;',
      )
      frame.setAttribute('aria-hidden', 'true')
      /* Kept out of the tab order: it is machinery, not content. */
      frame.setAttribute('tabindex', '-1')
      document.body.appendChild(frame)
      frameRef.current = frame
    }

    /* `auto=1` on the route itself does the printing — this only says which
       document, and re-assigning src re-runs it for the next print. */
    const url = new URL(href, window.location.origin)
    url.searchParams.set('auto', '1')
    frame.src = url.pathname + url.search
  }, [])
}
