'use client'

import { posStore } from './store'
import { releaseLocalNumber } from './saleNumber'
import { numberValueOf } from '../numberFormat'
import type { CancelledSale, OutboxSale } from './types'

/**
 * Cancelling a sale that was rung up offline and has not yet synced.
 *
 * ── THERE IS NOTHING TO VOID ──────────────────────────────────────────────
 *
 * The sale never reached the server, so `voidDocument` has no document to reverse.
 * The entry leaves the queue instead. But it must NOT leave silently: a till that can
 * make a sale disappear without a trace is a till somebody can steal from, and the
 * person best placed to exploit that is the one standing at it. So the whole payload —
 * every line, every tender, the operator, the reason — is kept and travels to
 * `offline_cancelled_sales` on the next sync, where a pattern of large cancelled
 * sales by one person is visible.
 *
 * The row is therefore NOT deleted. It is re-statused to `cancelled`, which keeps it
 * inside the rule that nothing removes an outbox row until the server has it.
 *
 * ── THE NUMBER IS BURNT ───────────────────────────────────────────────────
 *
 * This is the part that matters most, and the tempting mistake is to hand the number
 * back so the till's run stays gapless.
 *
 * It must not, in general. If the slip printed, the customer may be holding a tax
 * invoice bearing that number — reissuing it would put two entirely different sales
 * under one invoice number, and offline there is no `uq_doc_number` to catch it. A
 * burnt number is a gap somebody can explain; a reused one is a corruption nobody can
 * unpick months later.
 *
 * The one safe exception is narrow and worth taking, because a shop that cancels a
 * mis-scan before printing should not accumulate holes: a sale can rewind only if its
 * counter is still the MOST RECENTLY ISSUED one and nothing has printed since.
 * `releaseLocalNumber` enforces exactly that and refuses otherwise, so the decision is
 * made by the sequence rather than by this function's optimism.
 */

export type CancelResult = {
  /** True when the counter was handed back; false when the number was burnt. */
  rewound: boolean
  documentNumber: string
}

/**
 * Cancels a queued sale.
 *
 * `reason` is required and not defaulted. The reason IS the audit trail — a cancelled
 * sale with no explanation tells a manager only that money went missing, and making it
 * optional guarantees it is usually absent.
 */
export async function cancelOfflineSale(
  siteId: number,
  saleUid: string,
  reason: string,
  operator: { userId: number; name: string },
): Promise<CancelResult | null> {
  const store = posStore(siteId)
  const sale = await store.outboxGet(saleUid)

  // Already gone, already synced, or already cancelled: all three mean "not
  // cancellable", and a synced sale needs voidDocument rather than this.
  if (!sale || sale.status === 'synced' || sale.status === 'cancelled') return null

  /*
   * Try to hand the number back BEFORE re-statusing, so a refusal is recorded
   * accurately. `releaseLocalNumber` compares against the stored counter and returns
   * false unless this really was the last number issued — which is the whole safety
   * check, and the reason this is not decided here.
   */
  const counter = numberValueOf(sale.documentNumber)
  const rewound = counter === null ? false : await releaseLocalNumber(siteId, counter)

  const cancelledAt = new Date().toISOString()
  const next: OutboxSale = {
    ...sale,
    status: 'cancelled',
    cancelReason: reason.trim().slice(0, 190),
    cancelledAt,
    // Burnt unless the sequence agreed to take it back.
    numberBurnt: !rewound,
    /* Recorded ALONGSIDE who rang the sale up, never over it. "Who sold it" and "who
       made it disappear" are different questions, and a shop investigating a pattern of
       cancellations needs both — overwriting the first would hide precisely the case
       this trail exists to catch. */
    cancelledByUserId: operator.userId,
    cancelledByName: operator.name,
    lastError: null,
  }
  await store.outboxPut(next)

  return { rewound, documentNumber: sale.documentNumber }
}

/**
 * Cancelled sales waiting to reach the audit trail.
 *
 * Sent by the sync engine alongside the pending ones. They post to
 * `offline_cancelled_sales` rather than `sales_documents` — there is no document and
 * there should not be one.
 */
export async function pendingCancellations(
  siteId: number,
  limit = 25,
): Promise<CancelledSale[]> {
  const rows = await posStore(siteId).outboxCancelledUnsynced(limit)

  return rows.map((row) => ({
    saleUid: row.saleUid,
    documentNumber: row.documentNumber,
    terminalId: row.terminalId,
    terminalCode: row.terminalCode,
    operatorUserId: row.operatorUserId,
    operatorName: row.operatorName,
    totalIncl: row.claimedTotalIncl,
    reason: row.cancelReason ?? '',
    takenAt: row.takenAt,
    cancelledAt: row.cancelledAt ?? row.takenAt,
    /* The whole sale, so the audit row can answer "what was in it" without a join
       to lines that were never written — plus who cancelled it and whether the number
       was burnt, which is what makes the gap in the till's run explainable. */
    payload: {
      lines: row.lines,
      tenders: row.tenders,
      numberBurnt: row.numberBurnt,
      cancelledByUserId: row.cancelledByUserId ?? null,
      cancelledByName: row.cancelledByName ?? null,
    },
  }))
}

/** Marks a cancellation as delivered. Keeps the row — the server now has it too. */
export async function markCancellationSynced(siteId: number, saleUid: string): Promise<void> {
  const store = posStore(siteId)
  const row = await store.outboxGet(saleUid)
  if (!row) return
  await store.outboxPut({ ...row, syncedAt: new Date().toISOString() })
}

/** Everything in the queue, for the outbox screen. Newest first. */
export async function outboxEntries(siteId: number): Promise<OutboxSale[]> {
  const rows = await posStore(siteId).outboxRecent()
  return rows
}
