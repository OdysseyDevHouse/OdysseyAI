'use client'

import { useEffect, useState } from 'react'

/**
 * Registers the till's service worker.
 *
 * ── WHY IT CAN FAIL, AND WHY THAT IS FINE ─────────────────────────────────
 *
 * A service worker needs a SECURE CONTEXT. `localhost` counts, and so does the
 * Electron shell (which loads `http://localhost:4100`), but a till reached over a
 * shop LAN by plain-HTTP IP does not. That deployment is real, so registration
 * no-ops there rather than throwing — the till still works online, and the returned
 * state lets the UI say offline trading is unavailable rather than pretending.
 *
 * ── AND THE ELECTRON CAVEAT WORTH KNOWING ─────────────────────────────────
 *
 * In Electron, "offline" means the network is gone but the local Next server is
 * still serving. If that server dies, nothing serves the page at all and no cached
 * shell helps — the worker's origin is simply unreachable. `api/health` already
 * reports `database: 'down'` separately from `status: 'ok'` for exactly this
 * distinction. A server-down Electron till is out of scope.
 */

export type OfflineShellState = {
  /** The worker is controlling this page. Offline opening will work. */
  ready: boolean
  /**
   * Why not, when it is not ready.
   *
   * Held so the till can SAY it. A cashier told "offline is unavailable on this
   * machine" can ask for a fix; one shown nothing discovers it when the line drops.
   */
  reason: string | null
  /** A newer build is waiting. The till decides when to take it. */
  updateWaiting: boolean
}

/**
 * Which shell to register.
 *
 * ── WHY THIS IS A PARAMETER RATHER THAN A SECOND HOOK ─────────────────────
 *
 * The invoicing window needs exactly this, scoped to /invoicing instead of
 * /pos. Everything above — the secure-context check, the reason strings, the
 * race against `ready` that stopped the till reporting "Online only" while
 * offline worked perfectly — applies unchanged, and a copy would be 140 lines
 * of subtle reasoning maintained in two places until the day they disagreed.
 *
 * The DEFAULT is the till's, so every existing caller is untouched.
 */
export type ShellTarget = { script: string; scope: string }

export const POS_SHELL: ShellTarget = { script: '/pos-sw.js', scope: '/pos' }
export const INVOICING_SHELL: ShellTarget = {
  script: '/invoicing-sw.js',
  scope: '/invoicing',
}

export function useOfflineShell(enabled = true, target: ShellTarget = POS_SHELL): OfflineShellState {
  const [state, setState] = useState<OfflineShellState>({
    ready: false,
    reason: null,
    updateWaiting: false,
  })

  useEffect(() => {
    if (!enabled) return

    if (!('serviceWorker' in navigator)) {
      setState({ ready: false, reason: 'This browser cannot work offline.', updateWaiting: false })
      return
    }

    /*
     * NOT IN DEVELOPMENT — unless somebody deliberately asks for it.
     *
     * The worker serves /_next/static/* stale-while-revalidate (rule 2 in
     * pos-sw.js). In PRODUCTION that is safe: chunk URLs are content-hashed, so a
     * cached copy is always the copy that URL means. Turbopack's DEV chunk URLs
     * are not — the same path is rewritten on every edit, so the cache hands the
     * page a chunk from an earlier compile and the till dies on load with
     * "module factory is not available". No reload fixes it, because the worker
     * answers the reload too.
     *
     * UNREGISTERING rather than merely skipping registration is the point: a
     * worker installed by an earlier run keeps controlling this origin until
     * something removes it, so a guard alone would leave every machine that has
     * ever opened the till in dev broken until its owner cleared storage by hand.
     */
    if (process.env.NODE_ENV !== 'production' && !process.env.NEXT_PUBLIC_OFFLINE_SHELL_IN_DEV) {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((r) => r.unregister())))
        .then(() => ('caches' in window ? caches.keys() : []))
        /* Ours only, keyed on the prefix both workers share, so a dev server sharing
           localhost with another app does not have its caches deleted underneath it. */
        .then((keys) =>
          Promise.all(keys.filter((k) => k.startsWith('odyssey-')).map((k) => caches.delete(k))),
        )
        .catch(() => {})
      setState({
        ready: false,
        reason:
          'Offline mode is off in development. Set NEXT_PUBLIC_OFFLINE_SHELL_IN_DEV=1 to test it.',
        updateWaiting: false,
      })
      return
    }

    if (!window.isSecureContext) {
      setState({
        ready: false,
        // Named precisely, because the fix is a deployment change and somebody has
        // to know which one.
        /* "This machine", not "this till" — the invoicing window registers
           through here too, and a counter told their TILL is on plain HTTP
           would go looking at the wrong screen. */
        reason: 'Offline needs HTTPS or localhost. This machine is on plain HTTP.',
        updateWaiting: false,
      })
      return
    }

    let cancelled = false

    navigator.serviceWorker
      /* SCOPED, so it never intercepts the back office. Registering at the root
         would put a cache in front of every screen in the app — and the till and
         the invoicing window each own their own scope, so neither can serve the
         other's shell. */
      .register(target.script, { scope: target.scope })
      .then(async (registration) => {
        if (cancelled) return

        /*
         * WAIT for control, rather than reading `controller` once.
         *
         * A freshly-registered worker does not control the page that registered it
         * until it activates — but pos-sw.js calls `skipWaiting()` and
         * `clients.claim()`, so that happens within a tick or two rather than on the
         * next load. Measured: `controller` is already set by the time the till has
         * finished mounting.
         *
         * Reading it once and reporting "reload to finish" was therefore WRONG in
         * the common case — the header said "Online only" while offline was working
         * perfectly. Racing `ready` against a short timeout reports what is actually
         * true: controlled, or genuinely not yet.
         */
        const controlled = await Promise.race([
          navigator.serviceWorker.ready.then(() => Boolean(navigator.serviceWorker.controller)),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ])
        if (cancelled) return

        setState({
          ready: controlled,
          reason: controlled ? null : 'Setting up offline mode — reload once to finish.',
          updateWaiting: Boolean(registration.waiting),
        })

        registration.addEventListener('updatefound', () => {
          if (!cancelled) setState((s) => ({ ...s, updateWaiting: true }))
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          ready: false,
          reason: error instanceof Error ? error.message : 'Offline mode could not start.',
          updateWaiting: false,
        })
      })

    return () => {
      cancelled = true
    }
  }, [enabled, target.script, target.scope])

  return state
}
