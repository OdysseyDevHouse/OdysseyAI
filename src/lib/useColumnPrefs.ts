'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Which columns a table shows, remembered per device.
 *
 * A device preference in localStorage rather than a site setting, for the same
 * reason the till's tile size is one (see posOffline/useTileSize.ts): how many
 * columns fit usefully is a property of THIS screen and the person at it. A
 * buyer on a 27" monitor wants cost, markup, GP and selling price at once; a
 * receiver on a laptop at the delivery door wants quantity and nothing else.
 * Neither wants the other's layout, and neither should have to set it for the
 * other.
 *
 * ── WHY THE DEFAULT IS READ AFTER MOUNT ───────────────────────────────────
 *
 * localStorage does not exist on the server. Reading it during the first render
 * gives the server one set of columns and the client another, and React reports
 * a hydration mismatch and discards the tree. So the first render always uses
 * the default set and the stored one is applied in an effect — one reflow of a
 * table that is waiting on a product search anyway.
 *
 * `ready` is exposed for the caller that needs to know the difference between
 * "the default" and "what this user chose", so a table can avoid animating
 * columns in on load.
 *
 * ── A STORE DEFAULT SITS UNDER THIS, NOT BESIDE IT ────────────────────────
 *
 * Some lists also let the STORE decide which columns belong — see
 * lib/site/listColumns.ts and 109_list_columns.sql. That is not a competing
 * mechanism and this hook needs no knowledge of it: the caller passes the
 * store's set as `defaultVisible`, and everything below already does the right
 * thing. The device layer becomes an override, and reset() lands on the
 * store's choice rather than a hardcoded one.
 *
 * The two answer different questions and both are worth having. The store says
 * which columns this business uses at all; the device says how many of them fit
 * on the screen in front of you.
 */

export type ColumnPrefs = {
  /** The ids currently shown. Locked columns are not in here. */
  visible: Set<string>
  setVisible: (next: Set<string>) => void
  reset: () => void
  /**
   * Drop the STORED override without changing what is on screen.
   *
   * For the one caller that has just made this device's set the store's set:
   * `reset()` would snap the table back to `defaultVisible`, which is a prop
   * that has not been refreshed yet, so the change would flicker off and on
   * again. Forgetting keeps the live set and lets the next load read the
   * store's copy.
   */
  forget: () => void
  /** False until the stored preference has been read. */
  ready: boolean
}

export function useColumnPrefs(
  /** Unique per table. Namespaced by the caller — 'odyssey.purchasing.grid'. */
  storageKey: string,
  defaultVisible: readonly string[],
  /** Every id the table knows about. A stored id not in here is dropped. */
  known: readonly string[],
): ColumnPrefs {
  // Memoised on the joined ids rather than the array identity: callers build
  // these inline, so a fresh array every render would reset the state on every
  // render and make the table uncontrollable.
  const defaultKey = defaultVisible.join(',')
  const knownKey = known.join(',')

  const fallback = useMemo(
    () => new Set(defaultVisible),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [defaultKey],
  )

  const [visible, setVisibleState] = useState<Set<string>>(fallback)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed)) {
          // Filtered against `known`: a stored layout may predate a column
          // being renamed or removed, and carrying a dead id forward would
          // quietly widen the set every time the table changed.
          const allowed = new Set(known)
          setVisibleState(new Set(parsed.filter((id): id is string => typeof id === 'string' && allowed.has(id))))
        }
      }
    } catch {
      /* Malformed JSON, or storage blocked (private mode, a locked-down
         profile). The default set is a working table, and a screen that cannot
         remember a layout must still show one. */
    } finally {
      setReady(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, knownKey])

  const setVisible = useCallback(
    (next: Set<string>) => {
      setVisibleState(next)
      try {
        window.localStorage.setItem(storageKey, JSON.stringify([...next]))
      } catch {
        /* As above — the choice still applies for this session. */
      }
    },
    [storageKey],
  )

  const reset = useCallback(() => {
    setVisibleState(fallback)
    try {
      window.localStorage.removeItem(storageKey)
    } catch {
      /* As above. */
    }
  }, [storageKey, fallback])

  const forget = useCallback(() => {
    try {
      window.localStorage.removeItem(storageKey)
    } catch {
      /* As above. */
    }
  }, [storageKey])

  return { visible, setVisible, reset, forget, ready }
}
