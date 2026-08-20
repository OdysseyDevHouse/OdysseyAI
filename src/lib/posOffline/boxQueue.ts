'use client'

import type { OfflineSale } from './types'

/**
 * Handing a finalised sale to the shop's own box.
 *
 * ── WHY THIS IS NOT INSIDE queueSale ──────────────────────────────────────
 *
 * `sync.queueSale` writes the device's outbox, and its job is to be the DURABLE
 * LOCAL RECORD that a sale happened. That job must never depend on a network,
 * not even a LAN one — a queue that can fail is not a queue.
 *
 * So this is a separate step with a separate contract: try the box, and say
 * plainly whether it took the sale. `finaliseOffline` keeps its own record
 * either way, and the box being unreachable degrades a hybrid site to exactly
 * the behaviour every other site already has.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────────────
 *
 * A sale is recorded in EXACTLY ONE place, and the till must know which.
 *
 *   · The box took it  → the box owns the flush. The device must NOT also keep
 *     it pending, or the same takings reach the cloud from two queues; the
 *     cloud's claim table makes that harmless to the books, but the till's
 *     pending count would double-count money and a manager would cash up
 *     against a figure that is wrong.
 *   · The box refused, or could not be reached → the device keeps it, exactly
 *     as it does on any other site.
 *
 * That is why this returns a verdict rather than throwing: "recorded elsewhere"
 * and "still mine to deliver" are different states, and the caller must act on
 * the difference.
 */

/** How long to wait for a machine on the same LAN. */
const TIMEOUT_MS = 4000

export type BoxQueueResult =
  /** The box has it. The device must not keep it pending. */
  | { taken: true; duplicate: boolean; pending: number | null }
  /**
   * The device keeps it. `reason` is for the log, never for the cashier: there
   * is nothing they can do about it and the sale is safely recorded either way.
   */
  | { taken: false; reason: string }

/**
 * Offer a finalised sale to the box.
 *
 * Never throws. Every failure — no network, a timeout, a 500, HTML from a
 * captive portal — is the same outcome for the caller: the device keeps the
 * sale. Distinguishing them here would only invite a caller to treat one as
 * fatal, and none of them are.
 */
export async function offerToBox(sale: OfflineSale): Promise<BoxQueueResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const response = await fetch('/api/pos/box-queue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sale),
      signal: controller.signal,
    })

    if (!response.ok) {
      /*
       * Includes 401 and 409. A lapsed session is not the sale's fault, and a
       * site that turns out not to have a box is a configuration question — in
       * both cases the right answer is the same: the device keeps the sale and
       * flushes it the way every other till does.
       */
      return { taken: false, reason: `The box answered ${response.status}.` }
    }

    let payload: { ok?: boolean; duplicate?: boolean; pending?: number }
    try {
      payload = await response.json()
    } catch {
      /* A 200 that is not JSON is a proxy or a cached page, not an answer. */
      return { taken: false, reason: 'The box sent something that was not an answer.' }
    }

    if (!payload?.ok) return { taken: false, reason: 'The box did not accept the sale.' }

    /*
     * `duplicate` is SUCCESS. It means this uid is already queued there — a
     * retry after a timeout, which is the ordinary shape of a flaky LAN. The
     * box has the sale, so the device must still let go of it.
     */
    return {
      taken: true,
      duplicate: Boolean(payload.duplicate),
      pending: typeof payload.pending === 'number' ? payload.pending : null,
    }
  } catch (error) {
    /* Aborted, offline, DNS, a dead box. All the same to the caller. */
    return {
      taken: false,
      reason: error instanceof Error ? error.message : 'The box could not be reached.',
    }
  } finally {
    clearTimeout(timer)
  }
}
