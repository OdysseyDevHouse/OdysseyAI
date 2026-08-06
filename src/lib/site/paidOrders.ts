import 'server-only'
import { siteExecute } from '../siteDb'
import { getTenderByCode } from './tenderTypes'
import { acceptOrder } from './onlineOrders'
import { finaliseDocument } from './salesPosting'
import { getOrder } from './onlineOrders'

/**
 * What happens to an online order once its payment is confirmed.
 *
 * ── WHY A PAID ORDER INVOICES ITSELF ─────────────────────────────────────
 *
 * An unpaid order becomes a DRAFT sale and waits for someone at the till. A
 * paid one cannot: the money is already in the store's account, so an order
 * left as a draft is takings with no invoice behind them, stock that has left
 * the shelf on paper but not in the system, and a VAT liability nothing has
 * recorded. So a confirmed payment runs the order all the way through the
 * ordinary posting engine.
 *
 * ── IT GOES THROUGH finaliseDocument, NOT AROUND IT ──────────────────────
 *
 * Every invariant the till relies on — stock movements, the sequence, the
 * ledger, cash-up — lives in that function. A parallel "online" posting path
 * would be a second implementation of the hardest code in the app, and the two
 * would drift.
 *
 * ── THE MONEY IS BANKED AS ITS OWN TENDER ────────────────────────────────
 *
 * Not cash, not card. It never went into a drawer and never went through the
 * shop's card machine, so banking it as either would make every cash-up claim
 * takings that are not physically there. The ONLINE tender type exists for
 * exactly this, with counts_as_drawer_cash = 0.
 */

export type InvoiceResult =
  | { ok: true; documentId: number; documentNumber: string | null }
  | { ok: false; error: string }

/**
 * Invoice an order whose payment has been VERIFIED.
 *
 * The caller must have settled the intent first. This is deliberately not
 * idempotent on its own — `settleIntent`'s status guard is what makes the
 * whole path safe to retry, and this only runs on the callback that actually
 * flipped the intent to paid.
 */
export async function invoicePaidOrder(
  siteId: number,
  orderId: number,
  amountPaid: number,
  paymentReference: string,
): Promise<InvoiceResult> {
  const tender = await getTenderByCode(siteId, 'ONLINE')
  if (!tender) {
    return {
      ok: false,
      error: 'No “Online payment” tender type is configured, so this cannot be banked.',
    }
  }

  // The order is a request until someone (or something) accepts it. Accepting
  // re-prices it against the current product file and writes the draft, which
  // is exactly what we then finalise. Idempotent: an order that already has a
  // sale is acknowledged rather than duplicated.
  const accepted = await acceptOrder(siteId, orderId, {
    userId: 0,
    userName: 'Online payment',
  })
  if (!accepted.ok) return accepted

  // A price that moved between ordering and paying is a real problem: the
  // shopper has been charged the OLD figure. The sale is still posted — the
  // money is in and the goods are going out — but the discrepancy is recorded
  // on the order so staff can see it rather than discover it at month end.
  if (accepted.repriced.length > 0) {
    await siteExecute(
      siteId,
      `UPDATE online_orders
          SET internal_note = CONCAT(COALESCE(internal_note,''), ?)
        WHERE id = ?`,
      [
        `\n[payment] ${accepted.repriced.length} line(s) changed price between ordering and payment. Paid R${amountPaid.toFixed(2)}.`,
        orderId,
      ],
    ).catch(() => {
      /* the note is a courtesy; never fail a settled payment over it */
    })
  }

  const finalised = await finaliseDocument(
    siteId,
    { userId: 0, userName: 'Online payment' },
    {
      documentId: accepted.documentId,
      tenders: [
        {
          tenderTypeId: tender.id,
          // What the shopper actually paid, not what the re-priced sale came
          // to. If those differ, the difference must show up as an over- or
          // under-payment rather than being quietly papered over.
          amount: amountPaid,
          reference: paymentReference,
        },
      ],
    },
  )

  if (!finalised.ok) return finalised

  const order = await getOrder(siteId, orderId)
  return {
    ok: true,
    documentId: accepted.documentId,
    documentNumber: order?.documentNumber ?? null,
  }
}

/** Record on the order what the shop should believe about its payment. */
export async function markOrderPayment(
  siteId: number,
  orderId: number,
  status: 'unpaid' | 'pending' | 'paid',
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE online_orders SET payment_status = ?, paid_at = ? WHERE id = ?`,
    [status, status === 'paid' ? new Date() : null, orderId],
  )
}
