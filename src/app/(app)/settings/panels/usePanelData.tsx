'use client'

import { useEffect, useState, type ReactElement } from 'react'
import { Callout, SettingRowsSkeleton } from '@/components/ui'

/**
 * Load one panel's settings when its tab is first opened.
 *
 * ── WHY A PANEL LOADS ITS OWN DATA ────────────────────────────────────────
 *
 * /settings is ONE route with a client-side tab control, so the page cannot
 * fetch every tab's settings up front: opening it would read the whole
 * configuration of the shop to render one panel, and every tab would pay for
 * the slowest. Each panel fetches when opened instead, through the load action
 * that already sits beside its save.
 *
 * The cost is a brief skeleton the first time a tab is opened. The alternative
 * was a screen whose time-to-first-paint grew with every tab added to the rail.
 *
 * ── WHY IT IS SHARED ──────────────────────────────────────────────────────
 *
 * Every panel needs the same four things — fetch once, show a skeleton, show
 * the error, guard against a resolve landing after the tab has been switched
 * away. Written out per panel, that is the same twenty lines eight times, and
 * the `live` guard is exactly the sort of detail the eighth copy forgets.
 *
 * Fetched once and kept: nothing else in the app writes these settings while
 * somebody sits on this screen, so switching away and back does not re-read.
 */
export function usePanelData<T>(
  load: () => Promise<{ ok: true } & T | { ok: false; error: string }>,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    load().then((result) => {
      /* Guards a state write after the tab has been switched away: React warns,
         and a slow answer would overwrite a fresher one. */
      if (!live) return
      if (result.ok) setData(result)
      else setError(result.error)
    })
    return () => {
      live = false
    }
    /* Once per mount. `load` is a server-action reference that is stable in
       practice, but listing it would re-fetch on any identity change and this
       hook's whole contract is "fetch once when the tab opens". */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { data, error }
}

/**
 * The waiting and failed states, so a panel body is only ever the real screen.
 *
 * `rows` sets the skeleton's height — pass roughly what the panel renders, so
 * the layout does not jump when the values land.
 */
export function PanelState({
  error,
  rows = 4,
}: {
  error: string | null
  rows?: number
}): ReactElement {
  if (error) {
    return (
      <Callout tone="danger" title="Could not load these settings">
        {error}
      </Callout>
    )
  }
  /* A skeleton at the real shape, not a spinner that collapses the panel and
     shoves it back down when the values arrive. */
  return <SettingRowsSkeleton rows={rows} />
}
