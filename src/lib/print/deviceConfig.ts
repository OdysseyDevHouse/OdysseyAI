'use client'

import type { ConfiguredPrinter, DevicePrintConfig, PrintPlan } from '@/lib/printing/resolve'
import { planFor } from '@/lib/printing/resolve'
import { deviceId } from '@/lib/deviceId'

/**
 * This machine's printing setup, held where a render can read it synchronously.
 *
 * ── WHY A MODULE CACHE AND NOT A HOOK ─────────────────────────────────────
 *
 * `hasSlipPrinter()` is called from render-time branches deep inside a
 * 7,900-line PosShell — it decides whether the Print button on the receipt
 * modal is even offered. It was synchronous because it read localStorage.
 *
 * The answer now lives on the server, which makes fetching it asynchronous, and
 * an async answer would turn every one of those branches into state. So the
 * config is fetched ONCE at mount and read synchronously thereafter. That is
 * the same shape `activeSlipDesign()` in (pos)/pos/printing.ts already uses,
 * and for the same reason.
 *
 * ── AND WHY null IS A REAL ANSWER ─────────────────────────────────────────
 *
 * Not-yet-loaded, a browser that cannot be identified, and a machine nobody has
 * set up all resolve to `browser` — which is exactly what every document did
 * before this feature existed. Nothing about a sale depends on this having
 * loaded, which is the property that keeps a printing change from ever being
 * able to stop a till trading.
 */

let cache: DevicePrintConfig | null = null
let loading: Promise<void> | null = null

/**
 * Fetches this machine's setup. Safe to call repeatedly; fetches once.
 *
 * Never throws and never rejects. A till that cannot read its printer setup
 * falls back to the browser's print dialog, which is a worse experience and not
 * a broken one.
 */
export function loadPrintConfig(): Promise<void> {
  if (loading) return loading
  loading = (async () => {
    const id = deviceId()
    if (!id) return
    try {
      const res = await fetch(`/api/pos/print-config?deviceId=${encodeURIComponent(id)}`)
      if (!res.ok) return
      cache = (await res.json()) as DevicePrintConfig
    } catch {
      /* Offline, or the server is unreachable. `printConfig()` keeps whatever
         the offline store handed us, and failing that the browser dialog. */
    }
  })()
  return loading
}

/**
 * Seeds the cache from the offline catalog, without a network call.
 *
 * The POS already syncs everything it needs to trade; printer setup rides that
 * feed, so a till that has been offline since this morning still knows where
 * its slips come out. Called by the offline shell as it applies a catalog.
 */
export function primePrintConfig(config: DevicePrintConfig | null): void {
  if (config) cache = config
}

/** What this machine knows right now. Null until something has loaded. */
export function printConfig(): DevicePrintConfig | null {
  return cache
}

/** What to do with one document. Synchronous, by design — see the docblock. */
export function planForDoc(docKey: string): PrintPlan {
  return planFor(docKey, cache)
}

/**
 * Whether a till slip has somewhere to go without a dialog.
 *
 * Read at render time to decide whether the receipt modal offers Print at all.
 * False on a browser, on an unconfigured machine, and before the config loads —
 * all of which fall through to the (print) route, which is what happened before
 * any of this existed.
 */
export function hasSlipPrinter(): boolean {
  const plan = planForDoc('slip')
  return plan.kind === 'printer'
}

/** The printer a document resolves to, or null. */
export function printerForDoc(docKey: string): ConfiguredPrinter | null {
  const plan = planForDoc(docKey)
  return plan.kind === 'printer' ? plan.printer : null
}

/** How wide the slip printer's paper is. 48 when nothing says otherwise. */
export function slipColumns(): number {
  return printerForDoc('slip')?.columns ?? 48
}

/** Forgets what was loaded. For tests, and for a machine that changes hands. */
export function resetPrintConfig(): void {
  cache = null
  loading = null
}
