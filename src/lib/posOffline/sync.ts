'use client'

import { posDb } from './db'
import type { OfflineSale, OutboxSale, PosSyncState, SyncResponse } from './types'

/**
 * The loop that gets a shift's takings onto the books.
 *
 * ── WHAT THIS IS ALLOWED TO DELETE: NOTHING PENDING ───────────────────────
 *
 * A `pending` outbox row is a sale that HAPPENED — the customer left with the
 * goods and the drawer holds the cash, and this row is the only record of it.
 * Nothing here deletes one. `synced` rows are pruned after a week (the server has
 * them); `failed` rows are kept until a human deals with them, because a sale that
 * quietly disappeared is worse than one sitting in a list marked "needs attention".
 *
 * ── OLDEST FIRST, ONE RUN AT A TIME ───────────────────────────────────────
 *
 * `takenAt` order, always. And a mutex — two runs would send the same batch twice.
 * That is survivable (the server's claim table makes a replay a no-op) but it
 * doubles the load on a shop's ADSL line at exactly the moment it is already
 * struggling, which is what caused the retry storm in the first place.
 *
 * ── A TRANSPORT FAILURE ABORTS; A RECORD REJECTION DOES NOT ───────────────
 *
 * The distinction is the whole retry policy. "The network is down" says nothing
 * about the sales in the batch, so the run stops and everything stays pending.
 * "This particular sale is malformed" is about one sale, so it is marked and the
 * rest continue. Conflating the two either drops good sales or retries a bad one
 * forever.
 */

/** Per request. 25 sales ≈ a small payload on a bad line; the server allows 50. */
const BATCH_SIZE = 25

/** Catches a server that came back up without any 'online' event firing. */
const POLL_MS = 30_000

/** How long a delivered sale is kept for reprints before pruning. */
const KEEP_SYNCED_DAYS = 7

/** A transport failure — about the connection, not about any sale in the batch. */
class TransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

/* ── Reading the queue ───────────────────────────────────────────────────── */

async function pendingSales(siteId: number, limit: number): Promise<OutboxSale[]> {
  return posDb(siteId)
    .outbox.where('status')
    .equals('pending')
    .sortBy('takenAt')
    .then((rows) => rows.slice(0, limit))
}

/** What the header chip reads. Cheap enough to call after every change. */
export async function syncCounts(siteId: number): Promise<{ pending: number; failed: number }> {
  const db = posDb(siteId)
  const [pending, failed] = await Promise.all([
    db.outbox.where('status').equals('pending').count(),
    db.outbox.where('status').equals('failed').count(),
  ])
  return { pending, failed }
}

/* ── Queueing ────────────────────────────────────────────────────────────── */

/**
 * Puts a completed sale in the outbox.
 *
 * Called the moment the sale is tendered, BEFORE the slip prints — if the print
 * fails the sale is still recorded, whereas the other order loses a sale whose
 * money is in the drawer.
 */
export async function queueSale(siteId: number, sale: OfflineSale): Promise<void> {
  const entry: OutboxSale = {
    ...sale,
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
  }
  // `put`, not `add`: re-queueing the same uid must overwrite rather than throw.
  // The uid is generated once per sale, so this only happens on a retry of the
  // queueing itself, and a throw there would lose the sale.
  await posDb(siteId).outbox.put(entry)
}

/* ── One flush ───────────────────────────────────────────────────────────── */

/**
 * Sends one batch and records what came back.
 *
 * Returns how many were accepted. Throws TransportError when the request itself
 * failed, which the caller reads as "stop, and try again on the next trigger".
 */
async function flushBatch(siteId: number): Promise<number> {
  const batch = await pendingSales(siteId, BATCH_SIZE)
  if (batch.length === 0) return 0

  let response: Response
  try {
    response = await fetch('/api/pos/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sales: batch.map(stripLocalFields) }),
    })
  } catch (error) {
    // The fetch itself failed: offline, DNS, a dead server. Nothing was sent.
    throw new TransportError(error instanceof Error ? error.message : 'No connection.', 0)
  }

  if (!response.ok) {
    /*
     * Every non-2xx is transport, INCLUDING 401. A lapsed session is not the
     * sales' fault — the fix is /pos-unlock, and marking twenty-five real sales
     * `failed` because a cookie expired overnight would be the worst possible
     * response to the most ordinary event in a shop's morning.
     */
    throw new TransportError(`The server answered ${response.status}.`, response.status)
  }

  let payload: SyncResponse
  try {
    payload = await response.json()
  } catch {
    // A 200 that is not JSON is a proxy or a cached login page, not a result.
    throw new TransportError('The server sent something that was not a result.', 200)
  }
  if (!Array.isArray(payload?.results)) {
    throw new TransportError('The server sent no results.', 200)
  }

  const db = posDb(siteId)
  let accepted = 0

  for (const result of payload.results) {
    const entry = batch.find((s) => s.saleUid === result.saleUid)
    if (!entry) continue

    if (result.ok) {
      accepted += 1
      await db.outbox.update(result.saleUid, {
        status: 'synced',
        syncedAt: new Date().toISOString(),
        lastError: null,
        // The number the server confirmed. Normally identical to the one printed;
        // kept because a reprint must show what the BOOKS say, not what the till
        // thought at the time.
        documentNumber: result.documentNumber ?? entry.documentNumber,
      })
      continue
    }

    /*
     * retryable === false means a human has to look at it: a malformed payload, or
     * a locked VAT period that quarantined the sale server-side. Anything else
     * stays pending and goes again — including an unexplained failure, because the
     * sale is real and the fault is more likely ours than the cashier's.
     */
    await db.outbox.update(result.saleUid, {
      status: result.retryable === false ? 'failed' : 'pending',
      attempts: entry.attempts + 1,
      lastError: result.error ?? 'The server would not accept this sale.',
    })
  }

  return accepted
}

/** The outbox row minus the fields that are local bookkeeping. */
function stripLocalFields(entry: OutboxSale): OfflineSale {
  const { status, attempts, lastError, syncedAt, ...sale } = entry
  return sale
}

/* ── Pruning ─────────────────────────────────────────────────────────────── */

/**
 * Deletes SYNCED entries older than a week.
 *
 * Explicitly `.equals('synced')` rather than "not pending": getting that predicate
 * backwards is exactly how the reference POS lost sales off the floor, and the
 * safe version of this query is the one that can only ever match rows the server
 * has already confirmed.
 */
export async function pruneSynced(siteId: number): Promise<void> {
  const cutoff = new Date(Date.now() - KEEP_SYNCED_DAYS * 86_400_000).toISOString()
  await posDb(siteId)
    .outbox.where('status')
    .equals('synced')
    .filter((row) => (row.syncedAt ?? '') < cutoff)
    .delete()
}

/* ── The engine ──────────────────────────────────────────────────────────── */

export type SyncHandle = {
  /** Flushes now — after a sale, or when a cashier presses "send". */
  run: () => Promise<void>
  /** Detaches every listener and timer. */
  stop: () => void
}

/**
 * Starts the loop and reports its state.
 *
 * `onChange` fires on every transition, so the status chip is driven by what the
 * queue actually holds rather than by a component's own guess. The pending count
 * is the number a cashier must see before going home: forty sales that never left
 * the building is a discovery for the next morning, not for month end.
 */
export function startPosSync(
  siteId: number,
  onChange: (state: PosSyncState) => void,
): SyncHandle {
  let running = false
  let stopped = false
  let lastSyncAt: string | null = null
  let lastError: string | null = null

  async function publish(syncing: boolean) {
    const { pending, failed } = await syncCounts(siteId)
    onChange({
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
      syncing,
      pending,
      failed,
      lastSyncAt,
      lastError,
    })
  }

  async function run() {
    // The mutex. A second concurrent run is not unsafe — the server's claim table
    // makes a replay a no-op — but it doubles the load on the line that is
    // already the reason sales are queued.
    if (running || stopped) return
    running = true
    await publish(true)

    try {
      /*
       * Loop until the queue is empty or a batch delivers nothing. The second
       * condition is what stops an infinite loop when every sale in a batch comes
       * back `pending` again: retrying immediately would hammer the server, so it
       * waits for the next trigger instead.
       */
      for (;;) {
        const accepted = await flushBatch(siteId)
        if (accepted === 0) break
        lastSyncAt = new Date().toISOString()
        lastError = null
        await publish(true)
      }
      await pruneSynced(siteId)
    } catch (error) {
      // A transport failure leaves everything pending, which is the point.
      lastError = error instanceof Error ? error.message : 'Sync failed.'
    } finally {
      running = false
      await publish(false)
    }
  }

  const onOnline = () => void run()
  const timer = setInterval(() => void run(), POLL_MS)

  if (typeof window !== 'undefined') {
    window.addEventListener('online', onOnline)
    // A till left on a locked screen overnight comes back to a full queue.
    window.addEventListener('focus', onOnline)
  }

  void run()

  return {
    run,
    stop: () => {
      stopped = true
      clearInterval(timer)
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline)
        window.removeEventListener('focus', onOnline)
      }
    },
  }
}
