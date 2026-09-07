'use client'

import { posStore } from './store'
import { pendingCancellations, markCancellationSynced } from './cancelOffline'
import type {
  OfflineMovement,
  OfflineReturn,
  OfflineSale,
  OfflineShift,
  OutboxMovement,
  OutboxReturn,
  OutboxSale,
  OutboxShift,
  PosSyncState,
  SyncResponse,
} from './types'
import { currentShift, setCurrentShift } from './shiftOffline'

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
  return posStore(siteId).outboxPending(limit)
}

/**
 * What the header chip reads. Cheap enough to call after every change.
 *
 * `pending` counts SALES only — it is the figure a cashier must not cash up against,
 * and it means "money not yet on the books". An undelivered cancellation is also
 * outstanding work, but folding it into the same number would overstate the takings
 * still to land and make the warning mean two different things.
 *
 * A pending RETURN is counted separately for the same reason, and it is not a nicety:
 * a queued refund is money that has ALREADY LEFT the drawer with the opposite sign to
 * a sale, so adding it to `pending` would net against the takings and understate both.
 * But it must not be omitted either — cashing up with a refund unrecorded reports the
 * drawer SHORT by its value, and no amount of recounting finds it. So: its own number,
 * and the same "not yet through" warning covers both.
 */
export async function syncCounts(
  siteId: number,
): Promise<{
  pending: number
  failed: number
  cancellations: number
  pendingReturns: number
  failedReturns: number
  pendingShifts: number
  pendingMovements: number
  failedMovements: number
}> {
  const store = posStore(siteId)
  const [pending, failed, cancelled, retPending, retFailed, shiftPending, movePending, moveFailed] =
    await Promise.all([
      store.outboxCount('pending'),
      store.outboxCount('failed'),
      store.outboxCancelledUnsyncedCount(),
      store.returnCount('pending'),
      store.returnCount('failed'),
      /*
       * Shifts and movements opened offline (252), each on its own number and
       * for the reason the header above gives about returns: these are not
       * takings and folding them into `pending` would make the one figure a
       * cashier must not cash up against mean three different things.
       *
       * A queued MOVEMENT is the one that changes a cash-up: it is money that has
       * already left the drawer, so an expected figure computed before it arrives
       * reports the drawer short by its value and no amount of recounting finds
       * it — exactly the argument for counting queued refunds separately.
       *
       * A failed SHIFT is deliberately not counted. Its consequence is real but
       * it is not outstanding WORK: the till has stopped trying, the sales that
       * named it have posted with no shift, and what is needed is somebody
       * looking at the outbox screen rather than a number on a chip.
       */
      store.shiftCount('pending').catch(() => 0),
      store.movementCount('pending').catch(() => 0),
      store.movementCount('failed').catch(() => 0),
    ])
  return {
    pending,
    failed,
    cancellations: cancelled,
    pendingReturns: retPending,
    failedReturns: retFailed,
    pendingShifts: shiftPending,
    pendingMovements: movePending,
    failedMovements: moveFailed,
  }
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
  await posStore(siteId).outboxPut(entry)
}

/**
 * Hands a sale over to the shop's box.
 *
 * ── THE ONE EXCEPTION TO "NOTHING DELETES A PENDING ROW" ──────────────────
 *
 * That rule exists because a pending row is usually the ONLY record that a sale
 * happened. Here it is not: the box has confirmed it holds this sale and owns
 * delivering it, so the record survives the deletion. The rule's purpose is
 * intact; only its literal wording would object.
 *
 * Getting the ORDER wrong is what would break it, which is why this is
 * deliberately not folded into the queue write. `finaliseOffline` writes the
 * local row first, offers the sale to the box second, and calls this only on a
 * confirmed acceptance. There is no instant at which the sale exists nowhere.
 *
 * ── AND WHY IT DELETES RATHER THAN MARKS SYNCED ───────────────────────────
 *
 * `synced` means "the cloud has it" — the state a reprint reads and the prune
 * timer acts on. The cloud does NOT have it yet; the box does. Marking it
 * synced would tell a truth-shaped lie to every reader of that column.
 *
 * Leaving it pending is worse still: this device will never deliver it, so the
 * till's pending count would report money that is not its to deliver, and a
 * manager would cash up against a figure that is wrong.
 *
 * Scoped to `pending` so a race cannot delete a row a flush has already
 * delivered — that one is genuinely `synced` and belongs to the prune timer.
 */
export async function dropQueuedSale(siteId: number, saleUid: string): Promise<boolean> {
  return posStore(siteId).outboxDropPending(saleUid)
}

/**
 * Puts a completed return in its outbox.
 *
 * Queued BEFORE the credit-note slip prints, for the same reason a sale is: a failed
 * print is a reprint, whereas a crash between printing and queueing leaves a customer
 * holding a credit note for a refund no system knows about — and with a refund the
 * money has already left the drawer, so that record is the only thing standing between
 * the shop and an unexplained shortage at cash-up.
 */
export async function queueReturn(siteId: number, ret: OfflineReturn): Promise<void> {
  const entry: OutboxReturn = {
    ...ret,
    status: 'pending',
    attempts: 0,
    lastError: null,
    syncedAt: null,
  }
  // `put`, not `add` — see queueSale. A throw here would lose the return.
  await posStore(siteId).returnPut(entry)
}

/** Pending returns, OLDEST FIRST — the same rule sales flush by. */
async function pendingReturns(siteId: number, limit: number): Promise<OutboxReturn[]> {
  return posStore(siteId).returnPending(limit)
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
  /* Cancelled sales ride the same request. They are not revenue, but they ARE the
     audit trail for a sale that vanished, so they are as important to deliver — and a
     till with nothing pending but cancellations still has work to do. */
  const cancellations = await pendingCancellations(siteId, BATCH_SIZE)
  /* Returns ride the same request, and the server posts them after the sales — see
     the ordering note in the sync route. A till with nothing but returns pending
     still has work to do. */
  const returns = await pendingReturns(siteId, BATCH_SIZE)
  /*
   * Shifts opened offline, and the drawer movements on them (252).
   *
   * Sent in the SAME request rather than one of their own, and that is the whole
   * design: a sale carries the uid of a shift that may not exist on the server
   * yet, so the two must be judged together or the sale banks nowhere. The route
   * sequences them — shifts, sales, returns, movements, cancellations — because
   * the order is a correctness requirement and a client's flush sequence is the
   * wrong place to keep one.
   *
   * A till with nothing but a queued shift still has work to do, which is why
   * both count towards the "anything to send" test below.
   */
  const shifts = await posStore(siteId).shiftPending(BATCH_SIZE)
  const movements = await posStore(siteId).movementPending(BATCH_SIZE)
  if (
    batch.length === 0 &&
    cancellations.length === 0 &&
    returns.length === 0 &&
    shifts.length === 0 &&
    movements.length === 0
  ) {
    return 0
  }

  let response: Response
  try {
    response = await fetch('/api/pos/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shifts: shifts.map(stripShiftLocalFields),
        sales: batch.map(stripLocalFields),
        returns: returns.map(stripReturnLocalFields),
        movements: movements.map(stripMovementLocalFields),
        cancellations,
      }),
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

  const store = posStore(siteId)
  let accepted = 0

  /*
   * Shifts first, and the ID IS THE POINT.
   *
   * A shift that posts comes back with the id the server gave it, and the row is
   * stamped with it — that is what lets everything afterwards stop naming the
   * shift by uid. Where this is the shift the till is CURRENTLY on, the stored
   * pointer is upgraded too, so the next sale carries a real id and the next
   * cash-up has something to close.
   *
   * `adopted` is a SUCCESS that the cashier still needs to know about: a shift was
   * already open on this drawer, so that one was used and the float counted here
   * was not added. Recorded on the row rather than raised as an error, because
   * nothing is wrong with the takings — see `postOfflineShift` for why adopting is
   * the only answer that keeps them reconcilable.
   */
  for (const result of payload.shifts ?? []) {
    const entry = shifts.find((s) => s.shiftUid === result.shiftUid)
    if (!entry) continue

    if (result.ok) {
      accepted += 1
      await store.shiftUpdate(result.shiftUid, {
        status: 'synced',
        syncedAt: new Date().toISOString(),
        lastError: null,
        shiftId: result.shiftId ?? null,
        adopted: result.adopted,
      })
      /* Only if this is still the shift being sold against. A till that cashed up
         and reopened while its queue drained must not have yesterday's id written
         over today's pointer. */
      const held = await currentShift(siteId)
      if (result.shiftId && held.uid === result.shiftUid) {
        await setCurrentShift(siteId, { id: result.shiftId, uid: result.shiftUid })
      }
      continue
    }

    /*
     * A refused shift is `failed` where the server says so, and the consequence is
     * worth stating: the sales naming its uid post with a NULL shift, which
     * `finaliseDocument` accepts. Their money reaches the books and reaches no
     * reconciliation. That is the honest end for a shift the server will never
     * take, and it is strictly better than holding the sales back — but it is
     * exactly why the outbox screen has to show this row to a human.
     */
    await store.shiftUpdate(result.shiftUid, {
      status: result.retryable === false ? 'failed' : 'pending',
      attempts: entry.attempts + 1,
      lastError: result.error ?? 'The server would not open this shift.',
    })
  }

  for (const result of payload.results) {
    const entry = batch.find((s) => s.saleUid === result.saleUid)
    if (!entry) continue

    if (result.ok) {
      accepted += 1
      await store.outboxUpdate(result.saleUid, {
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
    await store.outboxUpdate(result.saleUid, {
      status: result.retryable === false ? 'failed' : 'pending',
      attempts: entry.attempts + 1,
      lastError: result.error ?? 'The server would not accept this sale.',
    })
  }

  /*
   * Returns, on exactly the same terms as sales: accepted rows are stamped with the
   * number the BOOKS ended up using, a non-retryable refusal becomes `failed` for a
   * human, and anything else stays pending.
   *
   * The number can legitimately differ from the printed one here in a way a sale's
   * cannot: if uq_doc_number refuses the printed number, the server keeps the credit
   * note under the number it allocated and says so in the exception. Storing what came
   * back means a reprint shows what the books say rather than what the till hoped.
   */
  for (const result of payload.returns ?? []) {
    const entry = returns.find((r) => r.returnUid === result.returnUid)
    if (!entry) continue

    if (result.ok) {
      accepted += 1
      await store.returnUpdate(result.returnUid, {
        status: 'synced',
        syncedAt: new Date().toISOString(),
        lastError: null,
        documentNumber: result.documentNumber ?? entry.documentNumber,
      })
      continue
    }

    await store.returnUpdate(result.returnUid, {
      status: result.retryable === false ? 'failed' : 'pending',
      attempts: entry.attempts + 1,
      lastError: result.error ?? 'The server would not accept this return.',
    })
  }

  /*
   * Drawer movements, on the same terms as everything above.
   *
   * One case is its own: a movement whose shift did not arrive comes back
   * RETRYABLE rather than failed, because the shift will be there on the next
   * attempt — usually the batch was simply cut short. The money genuinely left
   * the drawer, so discarding the record over a temporary ordering problem would
   * turn a payout into an unexplained variance.
   */
  for (const result of payload.movements ?? []) {
    const entry = movements.find((m) => m.movementUid === result.movementUid)
    if (!entry) continue

    if (result.ok) {
      accepted += 1
      await store.movementUpdate(result.movementUid, {
        status: 'synced',
        syncedAt: new Date().toISOString(),
        lastError: null,
      })
      continue
    }

    await store.movementUpdate(result.movementUid, {
      status: result.retryable === false ? 'failed' : 'pending',
      attempts: entry.attempts + 1,
      lastError: result.error ?? 'The server would not record this movement.',
    })
  }

  /*
   * Cancellations that reached the audit trail are stamped, not deleted — the row
   * stays as this till's own record of what it cancelled. One that was refused stays
   * unstamped and goes again, because a cancellation nobody can see is exactly the
   * hole the trail exists to close.
   */
  for (const outcome of payload.cancelled ?? []) {
    if (!outcome.ok) continue
    accepted += 1
    await markCancellationSynced(siteId, outcome.saleUid)
  }

  return accepted
}

/** The outbox row minus the fields that are local bookkeeping. */
function stripLocalFields(entry: OutboxSale): OfflineSale {
  const { status, attempts, lastError, syncedAt, ...sale } = entry
  return sale
}

/** The same, for a return. */
function stripReturnLocalFields(entry: OutboxReturn): OfflineReturn {
  const {
    status,
    attempts,
    lastError,
    syncedAt,
    cancelReason,
    cancelledAt,
    cancelledByUserId,
    cancelledByName,
    numberBurnt,
    ...ret
  } = entry
  return ret
}

/** The same, for a queued shift. `shiftId` and `adopted` are answers, not requests. */
function stripShiftLocalFields(entry: OutboxShift): OfflineShift {
  const { status, attempts, lastError, syncedAt, shiftId, adopted, ...shift } = entry
  return shift
}

/** And for a drawer movement. */
function stripMovementLocalFields(entry: OutboxMovement): OfflineMovement {
  const { status, attempts, lastError, syncedAt, ...movement } = entry
  return movement
}

/* ── Pruning ─────────────────────────────────────────────────────────────── */

/**
 * Deletes SYNCED entries older than a week.
 *
 * Explicitly `.equals('synced')` rather than "not pending": getting that predicate
 * backwards is exactly how the reference POS lost sales off the floor, and the
 * safe version of this query is the one that can only ever match rows the server
 * has already confirmed.
 *
 * Note what that phrasing already protects, and must keep protecting: a `cancelled`
 * row is not `synced`, so this cannot reach one even when its audit record has not
 * been delivered yet. Do not "simplify" this to a negated status — deleting a
 * cancellation before the server has it destroys the only evidence that a sale was
 * made to disappear, which is precisely what that trail exists to prevent.
 */
export async function pruneSynced(siteId: number): Promise<void> {
  const cutoff = new Date(Date.now() - KEEP_SYNCED_DAYS * 86_400_000).toISOString()
  const store = posStore(siteId)
  await store.outboxPruneSynced(cutoff)
  /* Returns on identical terms, and written out rather than shared so the
     `.equals('synced')` predicate above is repeated verbatim rather than abstracted
     into something that could later be loosened for one table and not the other. A
     pending or failed return is the only record that money left the drawer. */
  await store.returnPruneSynced(cutoff)
  /*
   * Shifts and movements on the same terms, and written out for the same reason:
   * the `.equals('synced')` predicate is repeated verbatim per table rather than
   * abstracted into something that could later be loosened for one and not another.
   *
   * A shift is pruned even though its id may still be referenced by a sale row —
   * which is fine, because that sale has by then been stamped with a real shift on
   * the server. What must never be pruned is a PENDING one: it is what a queued
   * sale's uid resolves through, and deleting it would strand that sale's takings
   * in no reconciliation at all.
   */
  await store.shiftPruneSynced(cutoff)
  await store.movementPruneSynced(cutoff)
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
