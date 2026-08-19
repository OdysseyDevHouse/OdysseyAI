'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * A yes/no view preference, remembered per device.
 *
 * The boolean sibling of `useColumnPrefs`, and a device preference for the same
 * reason: it answers "how do I like to work on THIS screen", not "how does this
 * business operate". Two people sharing one login want different answers, and
 * neither should have to set it for the other — so it does not belong in
 * settings, where a change is a change for everybody.
 *
 * ── THE STORED VALUE IS READ AFTER MOUNT ──────────────────────────────────
 *
 * localStorage does not exist on the server. Reading it during the first render
 * gives the server one answer and the client another, and React reports a
 * hydration mismatch and discards the tree. So the first render always uses the
 * default and the stored value lands in an effect.
 *
 * That is a visible flicker for anything that changes layout, which is why
 * `ready` is exposed — a caller that would flash can wait for it. For a hover
 * outline it does not matter enough to bother.
 */
export function useDeviceToggle(
  /** Namespaced by the caller — 'odyssey.stationery.outlines'. */
  storageKey: string,
  defaultOn = false,
): { on: boolean; setOn: (next: boolean) => void; toggle: () => void; ready: boolean } {
  const [on, setOnState] = useState(defaultOn)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      // Only the two strings this hook writes are honoured. Anything else is a
      // stale value from another feature that once used this key, and the
      // default is a working screen.
      if (raw === '1') setOnState(true)
      else if (raw === '0') setOnState(false)
    } catch {
      /* Storage blocked — private mode, a locked-down profile. The default is a
         working screen, and one that cannot remember a preference must still
         show something. */
    } finally {
      setReady(true)
    }
  }, [storageKey])

  const setOn = useCallback(
    (next: boolean) => {
      setOnState(next)
      try {
        window.localStorage.setItem(storageKey, next ? '1' : '0')
      } catch {
        /* As above — the choice still applies for this session. */
      }
    },
    [storageKey],
  )

  const toggle = useCallback(() => setOn(!on), [setOn, on])

  return { on, setOn, toggle, ready }
}
