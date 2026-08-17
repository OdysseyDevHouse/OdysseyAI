'use server'

import { actorFor, actorForOrThrow, withTillOperator } from '@/lib/auth'
import { listLaybys, getLayby, takePayment, completeLayby } from '@/lib/site/laybys'
import { listTenderTypes } from '@/lib/site/tenderTypes'

/**
 * Lay-bys, at the till.
 *
 * ── WHY THE TILL AND NOT ONLY THE BACK OFFICE ─────────────────────────────
 *
 * A lay-by payment is the one lay-by event that happens at a COUNTER. Somebody
 * walks in with cash and a card in their wallet, pays R200 off the kitchen
 * table they are buying, and leaves. Sending that to the back office means a
 * cashier leaving the till — with a queue behind the customer — to use a screen
 * built for a manager working through a list.
 *
 * Creating a lay-by, cancelling one, chasing overdue ones and reporting on them
 * all stay where they are. This is the counter's half.
 *
 * ── WHAT THIS DOES NOT REIMPLEMENT ────────────────────────────────────────
 *
 * Everything. `takePayment` and `completeLayby` are the same functions the back
 * office calls, with the same refusals — an over-payment, a cancelled lay-by,
 * handing goods over before the balance is clear. This file resolves the till's
 * operator and terminal and gets out of the way.
 *
 * ── AND WHY IT IS SAFE NOW ────────────────────────────────────────────────
 *
 * It was not before. `takePayment` banks into a shift, but `expectedCash` was
 * derived from sales tenders alone, so lay-by money was shown on the
 * declaration and left out of the figure it was counted against — a till
 * taking payments here would have made every drawer read over by exactly them.
 * The cash-up counts off-ledger money now, which is what unblocked this.
 */

type Denied = { ok: false; error: string }

/** A lay-by as the till's list shows it. */
export type TillLayby = {
  id: number
  laybyNumber: string | null
  customerName: string | null
  totalIncl: number
  paidTotal: number
  outstanding: number
  dueDate: string | null
  /** Past its due date and still open. */
  overdue: boolean
  /** Nothing left to pay — the goods can go. */
  settled: boolean
}

/**
 * Lay-bys a counter can work with.
 *
 * OPEN ONES ONLY. Unlike the quote list, which shows settled quotes because a
 * customer holding a lapsed one still needs to be told it lapsed. A completed
 * lay-by has been handed over and a cancelled one has been refunded; both are
 * finished, and offering either to a cashier invites taking money against
 * something that no longer exists.
 *
 * The whole shop's, like every other till list — a lay-by started at the front
 * counter is paid off at whichever one has the shortest queue.
 */
export async function listTillLaybysAction(search?: string): Promise<TillLayby[]> {
  const { siteId } = await actorForOrThrow('sales.till')

  const { items } = await listLaybys(siteId, { status: 'active', q: search, limit: 100 })
  const today = new Date().toISOString().slice(0, 10)

  return items.map((l) => ({
    id: l.id,
    laybyNumber: l.laybyNumber,
    customerName: l.customerName,
    totalIncl: l.totalIncl,
    paidTotal: l.paidTotal,
    outstanding: l.outstanding,
    dueDate: l.dueDate,
    overdue: !!l.dueDate && l.dueDate < today,
    settled: l.outstanding <= 0.004,
  }))
}

/**
 * The ways a counter may take a lay-by payment.
 *
 * Read from the shop's own tenders rather than assumed, and narrowed to what
 * makes sense for money arriving now: a lay-by instalment cannot be paid on
 * ACCOUNT (that would move the debt rather than settle it) and cannot be paid
 * with a gift card or loyalty points without those becoming a second thing to
 * reconcile. Cash and card are what a counter actually takes.
 */
export async function laybyTendersAction(): Promise<
  { id: number; name: string; countsAsDrawerCash: boolean }[]
> {
  const { siteId } = await actorForOrThrow('sales.till')
  const tenders = await listTenderTypes(siteId)

  return tenders
    .filter((t) => t.isActive && !t.postsToDebtor)
    .map((t) => ({ id: t.id, name: t.name, countsAsDrawerCash: t.countsAsDrawerCash }))
}

export type TillPaymentResult =
  | { ok: true; paidTotal: number; outstanding: number; settled: boolean; laybyNumber: string | null }
  | Denied

/**
 * Takes an instalment at the counter.
 *
 * The terminal is passed through so the payment banks into THIS till's shift —
 * `shiftToBankInto` resolves it, and without a terminal a payment on a shared
 * counter machine would land in whichever shift the browser session happened to
 * belong to.
 *
 * Deliberately does NOT complete the lay-by when the last instalment lands. The
 * balance reaching zero and the goods leaving the shop are two different
 * events, and they are frequently days apart — a customer who has finished
 * paying may be collecting on Saturday. Completing automatically would invoice
 * and move stock for goods still on the shelf. The list says "ready to collect"
 * instead, and somebody presses the button when the customer is holding them.
 */
export async function takeLaybyPaymentAction(
  laybyId: number,
  input: {
    amount: number
    tenderTypeId: number
    reference?: string | null
    terminalId?: number | null
  },
): Promise<TillPaymentResult> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const { siteId, actor } = await withTillOperator(base)

  if (!(input.amount > 0)) return { ok: false, error: 'Enter how much they are paying.' }

  const tenders = await listTenderTypes(siteId)
  const tender = tenders.find((t) => t.id === input.tenderTypeId && t.isActive)
  if (!tender) return { ok: false, error: 'Choose how they are paying.' }
  if (tender.postsToDebtor) {
    return {
      ok: false,
      error: 'A lay-by instalment cannot go on account — that moves the debt rather than paying it.',
    }
  }

  const result = await takePayment(siteId, actor, laybyId, {
    amount: input.amount,
    tenderTypeId: tender.id,
    tenderName: tender.name,
    reference: input.reference ?? null,
    terminalId: input.terminalId ?? null,
  })
  if (!result.ok) return result

  const layby = await getLayby(siteId, laybyId)
  return {
    ok: true,
    paidTotal: result.paidTotal,
    outstanding: result.outstanding,
    settled: result.settled,
    laybyNumber: layby?.laybyNumber ?? null,
  }
}

export type TillCollectResult =
  | { ok: true; documentId: number; documentNumber: string }
  | Denied

/**
 * Hands the goods over, once nothing is outstanding.
 *
 * THE MOMENT IT BECOMES A SALE: the invoice is raised, the VAT is declared and
 * the stock finally moves — all through the ordinary finalise path.
 *
 * The settlement tender is chosen HERE rather than asked of the cashier,
 * because there is exactly one right answer and it is not one a counter should
 * have to know. The money was taken over the instalments and is already in the
 * drawer and already counted; recording the settlement as cash would count
 * every rand of it a second time. `completeLayby` refuses drawer cash outright,
 * so this picks the non-drawer tender that says "already paid".
 */
export async function collectLaybyAction(laybyId: number): Promise<TillCollectResult> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const { siteId, actor } = await withTillOperator(base)

  const tenders = await listTenderTypes(siteId)
  /* By CODE first — DEPOSIT is the seeded "Deposit paid" and is what the back
     office settles with, so both screens record the same thing. Any other
     non-drawer tender is a workable fallback for a shop that has renamed or
     removed it; without one there is nothing honest to record and the refusal
     says what to add. */
  const settlement =
    tenders.find((t) => t.isActive && t.code === 'DEPOSIT' && !t.countsAsDrawerCash) ??
    tenders.find((t) => t.isActive && !t.countsAsDrawerCash && !t.postsToDebtor)
  if (!settlement) {
    return {
      ok: false,
      error:
        'This shop has no non-cash method to settle a lay-by against. Add one under Setup → Tenders.',
    }
  }

  return completeLayby(siteId, actor, laybyId, settlement.id)
}
