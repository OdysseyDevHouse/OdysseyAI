'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { startPosSync, syncCounts, type SyncHandle } from './sync'
import { catalogAgeHours, catalogMeta, refreshCatalog, type CatalogMeta } from './catalog'
import { hasSequence } from './saleNumber'
import { offlineStorageWorks } from './db'
import type { PosSyncState } from './types'

/**
 * Everything the till needs to know about its own connection.
 *
 * ── ONE HOOK, BECAUSE THESE FACTS ARE ONE FACT ────────────────────────────
 *
 * "Am I online", "how many sales are queued", "how old are my prices" and "can I
 * even trade offline" get asked together and answered together. Split across four
 * hooks they would report inconsistent snapshots — a header saying "offline" beside
 * a queue count from before the line dropped, which is worse than either alone.
 *
 * ── `navigator.onLine` IS NOT ENOUGH, AND IS STILL USED ───────────────────
 *
 * It only knows whether a network interface exists. A till connected to a shop
 * router whose ADSL is down reports `true` and every request times out. So it is
 * treated as a HINT that triggers a check, while the authority on "online" is
 * whether the last real request to our own server succeeded. That is the only
 * definition that matters here — the question is never "is there a network", it is
 * "can I reach the place the sales have to go".
 */

const CATALOG_REFRESH_MS = 15 * 60_000

export type OfflineTillState = {
  /** Whether the last real attempt to reach our server succeeded. */
  online: boolean
  /** True while the catalog is loading, so the UI can say so on first run. */
  loadingCatalog: boolean
  /** Sales queued and not yet delivered. */
  pending: number
  /** Sales the server refused in a way that needs a person. */
  failed: number
  /**
   * Returns queued and not yet delivered — counted apart from `pending`.
   *
   * A queued refund is money that has ALREADY left the drawer, with the opposite sign
   * to a sale, so adding it to `pending` would net against the takings and understate
   * both figures. It cannot be omitted either: cashing up with a refund unrecorded
   * reports the drawer SHORT by its value, and recounting never finds it.
   */
  pendingReturns: number
  /** Returns the server refused in a way that needs a person. */
  failedReturns: number
  /** Hours since the catalog last refreshed. */
  catalogAgeHours: number | null
  productsHeld: number
  /**
   * Whether this till could complete a sale with the network gone.
   *
   * Needs BOTH a working IndexedDB and a local numbering sequence. Products alone
   * are useless — a sale with no number is a sale that cannot be receipted.
   */
  canSellOffline: boolean
  /** Why not, when it cannot. */
  offlineBlocker: string | null
}

export type OfflineTill = OfflineTillState & {
  /** Pull the catalog now. */
  refresh: () => Promise<void>
  /** Flush the queue now. */
  flush: () => Promise<void>
  /** Re-read the queue counts, after a sale is rung up. */
  recount: () => Promise<void>
}

export function useOfflineTill(siteId: number, enabled = true): OfflineTill {
  const [state, setState] = useState<OfflineTillState>({
    // Optimistic until proven otherwise: showing "offline" for the half-second
    // before the first request returns makes every page load look like a fault.
    online: true,
    loadingCatalog: false,
    pending: 0,
    failed: 0,
    pendingReturns: 0,
    failedReturns: 0,
    catalogAgeHours: null,
    productsHeld: 0,
    canSellOffline: false,
    offlineBlocker: null,
  })

  const sync = useRef<SyncHandle | null>(null)
  // Guards against two refreshes overlapping — the second would race the first's
  // bulkPut and could interleave a full load with a delta.
  const refreshing = useRef(false)

  const applyMeta = useCallback(async (meta: CatalogMeta | null) => {
    const [storageOk, sequenced] = await Promise.all([
      offlineStorageWorks(siteId),
      hasSequence(siteId),
    ])
    setState((s) => ({
      ...s,
      catalogAgeHours: catalogAgeHours(meta),
      productsHeld: meta?.productCount ?? 0,
      canSellOffline: storageOk && sequenced && (meta?.productCount ?? 0) > 0,
      offlineBlocker: !storageOk
        ? 'This machine cannot store anything locally, so it cannot trade offline.'
        : !sequenced
          ? 'This till has no numbering of its own yet. Connect once to pick it up.'
          : (meta?.productCount ?? 0) === 0
            ? 'No products are stored on this till yet.'
            : null,
    }))
  }, [siteId])

  const refresh = useCallback(async () => {
    if (!enabled || refreshing.current) return
    refreshing.current = true
    setState((s) => ({ ...s, loadingCatalog: true }))
    try {
      const result = await refreshCatalog(siteId)
      /*
       * A 401 is NOT "offline". The server answered — it just refused, and the fix
       * is /pos-unlock rather than waiting for a connection. Reporting it as offline
       * would tell a cashier to carry on queueing sales against a session that will
       * refuse every one of them.
       */
      setState((s) => ({ ...s, online: result.ok || result.status === 401 }))
      await applyMeta(await catalogMeta(siteId))
    } finally {
      refreshing.current = false
      setState((s) => ({ ...s, loadingCatalog: false }))
    }
  }, [siteId, enabled, applyMeta])

  const recount = useCallback(async () => {
    const counts = await syncCounts(siteId)
    setState((s) => ({
      ...s,
      pending: counts.pending,
      failed: counts.failed,
      /* Separate from `pending` on purpose — a queued refund is money that has already
         left the drawer, so netting it against the takings would understate both. It
         must still be SHOWN: cashing up with a refund unrecorded reports the drawer
         short by its value, and recounting never finds it. */
      pendingReturns: counts.pendingReturns,
      failedReturns: counts.failedReturns,
    }))
  }, [siteId])

  /* ── The sync engine, started once ────────────────────────────────────── */

  useEffect(() => {
    if (!enabled) return

    const handle = startPosSync(siteId, (next: PosSyncState) => {
      setState((s) => ({
        ...s,
        pending: next.pending,
        failed: next.failed,
        /*
         * The engine's own last attempt is the best available evidence. It reports
         * `online: navigator.onLine`, but a run that ended with a transport error is
         * proof of the stronger fact — so a failed flush wins over the flag.
         */
        online: next.lastError ? false : next.online,
      }))
    })
    sync.current = handle

    return () => {
      handle.stop()
      sync.current = null
    }
  }, [siteId, enabled])

  /* ── The catalog: once on mount, then on a slow timer ─────────────────── */

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    // Report what is already stored FIRST, so a till opening with no connection
    // shows its held catalog immediately rather than an empty screen while the
    // fetch times out.
    void catalogMeta(siteId).then((meta) => {
      if (!cancelled) void applyMeta(meta)
    })
    void refresh()

    const timer = setInterval(() => void refresh(), CATALOG_REFRESH_MS)
    const onOnline = () => void refresh()
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
    }
  }, [siteId, enabled, refresh, applyMeta])

  const flush = useCallback(async () => {
    await sync.current?.run()
    await recount()
  }, [recount])

  return { ...state, refresh, flush, recount }
}
