'use client'

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'

/**
 * Lands somebody ON the setting they searched for, not merely on its screen.
 *
 * The global search indexes individual settings (lib/settingSearch.ts) and a hit
 * navigates to `/setup/terminals#idle-logout`. This mounts once in the app shell
 * and does the far half: find the card with that id, scroll it into view, and
 * flash it so the answer to "which one of these ten panels" is visible rather
 * than left as an exercise.
 *
 * ── WHY NOT JUST LET THE BROWSER DO IT ────────────────────────────────────
 *
 * Native hash scrolling is unreliable here for two separate reasons, and both
 * had to be handled rather than hoped past:
 *
 *   The target may not exist yet. A setup screen is a server component behind a
 *   Suspense boundary, so at the moment the URL changes the card is often still
 *   a skeleton — the browser looks for the id, finds nothing, and gives up
 *   silently. Hence the retry below rather than a single lookup.
 *
 *   The app does not scroll the document. The layout is `h-screen
 *   overflow-hidden` with the scrolling done by an inner `<main>`, so the
 *   browser's own "scroll the page to the anchor" has nothing to scroll.
 *   scrollIntoView on the element works because it walks up to whatever
 *   ancestor actually scrolls.
 */
/**
 * Fired by the search palette when it sends somebody to a setting.
 *
 * Needed because `router.push` to the URL somebody is ALREADY on does nothing —
 * no navigation, no re-render, no effect. Searching for the same setting twice
 * in a row is an ordinary thing to do (you found it, you scrolled away, you
 * looked again), and without this the second search silently does nothing at
 * all, which reads as the palette being broken.
 */
export const SETTING_ANCHOR_EVENT = 'odyssey:setting-anchor'

export default function SettingAnchor() {
  const pathname = usePathname()

  useEffect(() => {
    let cancelled = false
    /* Every pending timer, so a route change mid-retry cannot leave a loop
       running against a screen that is no longer mounted — or strip the ring
       off a panel the NEXT search just put it on. */
    const timers = new Set<number>()

    const wait = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id)
        fn()
      }, ms)
      timers.add(id)
    }

    const reveal = (id: string, tries = 0) => {
      if (cancelled || !id) return
      const target = document.getElementById(id)

      /* Retried rather than read once: the card is usually still suspended when
         the route changes. Ten tries at 100ms covers a slow first render of a
         setup screen without spinning for a hash that names nothing — a mistyped
         or stale anchor simply stops after a second, silently, which is the
         right failure for something nobody asked for explicitly. */
      if (!target) {
        if (tries < 10) wait(() => reveal(id, tries + 1), 100)
        return
      }

      /* 'center' rather than 'start': a panel pinned to the top edge of the
         scroller reads as the top of the page rather than as the thing that was
         singled out, and loses the heading above it that says what it belongs
         to. */
      target.scrollIntoView({ behavior: 'smooth', block: 'center' })

      /* Any OTHER panel still ringed, put out now.
         The mark means "this is the one you asked for", so two at once is a
         contradiction — and at a ten-second hold that is no longer a rare race
         but the ordinary result of searching twice on the same screen, which is
         exactly what somebody does when the first result was not what they
         meant. Each reveal owns its own removal timer, but that timer fires on
         its own schedule; this is what makes the newest ring the only one. */
      for (const lit of document.querySelectorAll('.setting-found')) {
        if (lit !== target) lit.classList.remove('setting-found')
      }

      /* Removed and re-added so searching the same setting twice flashes twice —
         re-adding a class the element already carries restarts nothing. */
      target.classList.remove('setting-found')
      /* Reading offsetWidth forces the style flush that makes the removal above
         take effect before the class goes back on. Without it the two changes
         batch into no change at all and the animation never replays. */
      void target.offsetWidth
      target.classList.add('setting-found')

      /* Must OUTLAST the animation, which runs for 10s — see `.setting-found`
         in globals.css. Removing the class early cuts the ring off mid-hold, so
         this number and that duration are one decision in two files: raise both
         or neither. The extra 200ms is slack so the removal cannot land in the
         same frame the fade finishes and clip its last step. */
      wait(() => target.classList.remove('setting-found'), 10_200)
    }

    /* The hash as it stands, for an ordinary navigation or a pasted link. */
    reveal(window.location.hash.slice(1))

    /* And the palette's own signal, for the case a navigation cannot cover:
       choosing the setting you are already looking at. */
    const onAsk = (event: Event) => {
      const anchor = (event as CustomEvent<string>).detail
      if (typeof anchor === 'string') reveal(anchor)
    }
    window.addEventListener(SETTING_ANCHOR_EVENT, onAsk)

    return () => {
      cancelled = true
      for (const id of timers) window.clearTimeout(id)
      window.removeEventListener(SETTING_ANCHOR_EVENT, onAsk)
    }
    /* Keyed on the path so navigating from one setting to another re-runs the
       hash read above. A repeat of the SAME setting changes no path and no hash,
       and arrives on the event instead. */
  }, [pathname])

  return null
}
