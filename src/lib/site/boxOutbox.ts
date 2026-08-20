import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { HYBRID, tabsAreLocal } from './tabRouting'
import type { OfflineSale, SyncSaleResult } from '../posOffline/types'

/**
 * The queue that gets a hybrid shop's takings onto the books.
 *
 * ── THE SAME RULES AS THE TILL'S OUTBOX, MOVED SERVER-SIDE ────────────────
 *
 * `lib/posOffline/sync.ts` already flushes a device's queue and its rules are
 * the right ones. They are restated here rather than reused because the storage
 * differs — Dexie there, MariaDB here — but nothing about the POLICY changes,
 * and any change to one should be made to the other:
 *
 *   · A `pending` row is a sale that HAPPENED. The customer left with the goods
 *     and the drawer holds the cash; this row is the only record. NOTHING
 *     deletes one. Not a prune, not an upgrade, not a "clear the queue".
 *   · `synced` rows are deletable, because the cloud has them.
 *   · `failed` rows are kept until a human deals with them. A sale that quietly
 *     disappeared is worse than one sitting in a list marked "needs attention".
 *   · Oldest first, one run at a time.
 *   · A TRANSPORT failure aborts the run and everything stays pending. A RECORD
 *     rejection marks that one row and the rest continue. Conflating the two
 *     either drops good sales or retries a bad one forever.
 *
 * ── WHY THE BOX HOLDS THE QUEUE AT ALL ────────────────────────────────────
 *
 * On a hybrid site the tab lives on the box, so the box is what has the sale
 * when the waiter closes it. Leaving the queue on the device would mean ten
 * devices each holding part of one shop's takings, and a till taken home in
 * somebody's bag taking its share with it.
 *
 * ── AND WHY IT DOES NOT POST ──────────────────────────────────────────────
 *
 * The box never calls finaliseDocument. Posting reaches stock, the ledger,
 * loyalty, serials, tips and shifts — none of which the box has, and two stock
 * ledgers cannot be reconciled. It hands the captured sale to the cloud, which
 * posts it through the SAME path an offline till's sale takes
 * (lib/site/offlineSync.ts: "there is no second posting path").
 */

/** Per request. Matches the till's client-side batch; the route allows 50. */
const BATCH_SIZE = 25

/** How long a delivered sale is kept for reprints before pruning. */
const KEEP_SYNCED_DAYS = 7

type OutboxRow = RowDataPacket & {
  id: number
  sale_uid: string
  document_number: string
  taken_at: Date
  payload: string
  status: 'pending' | 'synced' | 'failed'
  attempts: number
}

export type BoxOutboxEntry = {
  id: number
  saleUid: string
  documentNumber: string
  takenAt: Date
  status: 'pending' | 'synced' | 'failed'
  attempts: number
  lastError: string | null
}

/**
 * A transport failure — about the connection, not about any sale in the batch.
 *
 * The distinction is the whole retry policy, which is why it is a type rather
 * than a flag: "the line is down" says nothing about the sales, so the run stops
 * and everything stays pending.
 */
export class BoxTransportError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'BoxTransportError'
  }
}

/**
 * Queues a finalised sale.
 *
 * Called when a waiter closes a tab. The sale is captured exactly as the till
 * computed it — the cloud recomputes every figure on arrival and records any
 * disagreement as an exception, so this is a record of what was CHARGED rather
 * than a request to charge it.
 *
 * INSERT IGNORE on the uid: a till that retries after a timeout must not create
 * a second copy of a sale already waiting. The unique index makes that a
 * constraint rather than a hope.
 */
export async function queueSale(siteId: number, sale: OfflineSale): Promise<{ queued: boolean }> {
  const result = await siteExecute(
    siteId,
    `INSERT IGNORE INTO box_outbox (sale_uid, document_number, taken_at, payload, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [sale.saleUid, sale.documentNumber, toMysqlDateTime(sale.takenAt), JSON.stringify(sale)],
    HYBRID,
  )
  return { queued: result.affectedRows > 0 }
}

/**
 * What the header chip reads.
 *
 * `pending` counts SALES only. It is the figure a manager must not cash up
 * against, and it means "money not yet on the books".
 */
export async function outboxCounts(
  siteId: number,
): Promise<{ pending: number; failed: number; synced: number }> {
  const rows = await siteQuery<RowDataPacket & { status: string; n: number }>(
    siteId,
    'SELECT status, COUNT(*) AS n FROM box_outbox GROUP BY status',
    [],
    HYBRID,
  )
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.n ?? 0)
  return { pending: by('pending'), failed: by('failed'), synced: by('synced') }
}

/** The queue, newest problems first. For the exceptions screen. */
export async function listOutbox(siteId: number, limit = 100): Promise<BoxOutboxEntry[]> {
  const rows = await siteQuery<OutboxRow & { last_error: string | null }>(
    siteId,
    `SELECT id, sale_uid, document_number, taken_at, status, attempts, last_error
       FROM box_outbox
      ORDER BY status = 'failed' DESC, taken_at ASC
      LIMIT ?`,
    [limit],
    HYBRID,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    saleUid: r.sale_uid,
    documentNumber: r.document_number,
    takenAt: r.taken_at,
    status: r.status,
    attempts: Number(r.attempts),
    lastError: r.last_error,
  }))
}

/**
 * One flush.
 *
 * Returns how many the cloud accepted. Throws BoxTransportError when the
 * request itself failed, in which case NOTHING was marked and everything stays
 * pending — which is the correct response to a line that is down.
 *
 * `deliver` is injected rather than fetched here so the caller decides how the
 * cloud is reached — and so this can be exercised without a network.
 */
export async function flushOnce(
  siteId: number,
  deliver: (sales: OfflineSale[]) => Promise<SyncSaleResult[]>,
): Promise<number> {
  const batch = await siteQuery<OutboxRow>(
    siteId,
    `SELECT id, sale_uid, document_number, taken_at, payload, status, attempts
       FROM box_outbox
      WHERE status = 'pending'
      ORDER BY taken_at ASC, id ASC
      LIMIT ?`,
    [BATCH_SIZE],
    HYBRID,
  )
  if (batch.length === 0) return 0

  const sales: OfflineSale[] = []
  for (const row of batch) {
    try {
      sales.push(JSON.parse(row.payload) as OfflineSale)
    } catch {
      /* A payload that will not parse cannot be posted by anyone, and retrying
         it forever would block the queue behind it. Marked failed so a human
         sees it — NEVER deleted, because it is still the only record that a
         sale happened. */
      await markFailed(siteId, row.sale_uid, 'The stored sale could not be read.')
    }
  }
  if (sales.length === 0) return 0

  /* Throws on transport failure. Deliberately not caught: the caller must be
     able to tell "the line is down" from "the cloud refused a sale". */
  const results = await deliver(sales)

  let accepted = 0
  for (const result of results) {
    const row = batch.find((r) => r.sale_uid === result.saleUid)
    if (!row) continue

    if (result.ok) {
      accepted += 1
      /* A duplicate is SUCCESS, not an error: it means a previous run delivered
         it and the acknowledgement was lost. The cloud's claim table makes the
         replay a no-op, which is exactly what allows a retry to be safe. */
      await siteExecute(
        siteId,
        `UPDATE box_outbox SET status = 'synced', synced_at = NOW(), last_error = NULL
          WHERE sale_uid = ?`,
        [result.saleUid],
        HYBRID,
      )
      continue
    }

    if (result.retryable) {
      /* Ours, not the sale's — a deadlock, a dropped connection. Left pending
         so the next run tries again; only the attempt count moves, so a row
         that never succeeds is visible rather than silent. */
      await siteExecute(
        siteId,
        'UPDATE box_outbox SET attempts = attempts + 1, last_error = ? WHERE sale_uid = ?',
        [truncate(result.error), result.saleUid],
        HYBRID,
      )
      continue
    }

    await markFailed(siteId, result.saleUid, result.error ?? 'Refused.')
  }

  return accepted
}

async function markFailed(siteId: number, saleUid: string, error: string): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE box_outbox
        SET status = 'failed', attempts = attempts + 1, last_error = ?
      WHERE sale_uid = ?`,
    [truncate(error), saleUid],
    HYBRID,
  )
}

/**
 * Drops delivered sales older than a week.
 *
 * ── ON A TIMER, NOT ON ACKNOWLEDGEMENT ────────────────────────────────────
 *
 * Pruning the moment the cloud accepts a sale would mean a reprint an hour
 * later, with the line down, has nowhere to read from: the bill is on the books
 * but unreadable in the building where the customer is standing.
 *
 * The predicate is `status = 'synced'` and nothing else. Getting that backwards
 * loses a real sale off the floor with nothing to reconstruct it from — the
 * reference POS did exactly that in two of its early migrations.
 */
export async function prune(siteId: number, keepDays = KEEP_SYNCED_DAYS): Promise<number> {
  const result = await siteExecute(
    siteId,
    `DELETE FROM box_outbox
      WHERE status = 'synced'
        AND synced_at IS NOT NULL
        AND synced_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
    [Math.max(1, Math.floor(keepDays))],
    HYBRID,
  )
  return result.affectedRows
}

/** Whether this site keeps its queue on a box at all. */
export async function usesBoxOutbox(siteId: number): Promise<boolean> {
  return tabsAreLocal(siteId)
}

/** `last_error` is VARCHAR(400); a long stack must not fail the UPDATE. */
function truncate(text: string | undefined): string | null {
  if (!text) return null
  return text.length > 400 ? `${text.slice(0, 397)}...` : text
}

/**
 * An ISO instant as MariaDB wall-clock.
 *
 * The pool runs with timezone 'Z', so a DATETIME is read back with getUTC*.
 * Formatting here rather than handing the driver a Date keeps the stored value
 * and `takenAt` in the payload describing the same moment.
 */
function toMysqlDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 19).replace('T', ' ')
  return d.toISOString().slice(0, 19).replace('T', ' ')
}
