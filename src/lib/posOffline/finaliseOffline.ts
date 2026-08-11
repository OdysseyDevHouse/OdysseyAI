'use client'

import { nextLocalNumber, releaseLocalNumber } from './saleNumber'
import { queueReturn, queueSale } from './sync'
import { decrementStock } from './catalog'
import { kvGet, KV } from './db'
import type {
  OfflineReturn,
  OfflineReturnLine,
  OfflineSale,
  OfflineSaleLine,
  OfflineTender,
} from './types'

/**
 * Completing a sale with no server.
 *
 * ── THE ORDER OF THESE FOUR STEPS IS THE WHOLE DESIGN ─────────────────────
 *
 *   1. take a number     — advances the local counter, burning it on a crash
 *   2. QUEUE THE SALE    — the only durable record that this happened
 *   3. take stock off    — cosmetic, so the next customer sees a truthful figure
 *   4. return, and let the caller print
 *
 * Queueing comes BEFORE printing, and that is not arbitrary. If the print fails the
 * sale is still recorded; if the order were reversed, a crash between printing and
 * queueing would leave a customer holding a tax invoice for a sale no system has any
 * record of. One of those is a reprint, the other is unrecoverable.
 *
 * Numbering comes before queueing for the same reason in miniature: `nextLocalNumber`
 * advances the stored counter before it returns, so a crash burns a number rather
 * than reusing one. A burnt number is an explainable gap in a till's run; a reused
 * one is two different sales under one invoice number, which offline has no unique
 * index to catch.
 *
 * ── WHAT IS NOT COMPUTED HERE ─────────────────────────────────────────────
 *
 * No totals, no VAT, no rounding, no discount arithmetic. The caller passes what the
 * screen already showed — computed by documentMath and specialsEngine, the same
 * modules the server recomputes with at sync. A second implementation of any of that
 * in this file is how an offline slip and its posted invoice come to disagree.
 */

export type OfflineFinaliseInput = {
  siteId: number
  terminal: { id: number; code: string } | null
  operator: { userId: number; name: string }
  shiftId: number | null
  customer: { id: number | null; name: string; vatNumber: string | null; phone: string | null }
  priceStructureId: number | null
  lines: OfflineSaleLine[]
  tenders: OfflineTender[]
  /** What the screen showed. Compared server-side, never trusted in place of it. */
  totalIncl: number
  tenderedTotal: number
  change: number
  /** Declared tips per tender type, from the pad. */
  declaredTips?: Record<number, number>
  /** The forced service charge the slip showed. */
  serviceCharge?: number
}

export type OfflineFinaliseResult =
  | { ok: true; documentNumber: string; saleUid: string; change: number }
  | { ok: false; error: string }

/**
 * A uid for this sale.
 *
 * `crypto.randomUUID` where it exists, which is everywhere this till runs — but it
 * needs a secure context, the same requirement the service worker has, so the
 * fallback keeps a plain-HTTP LAN till working. The fallback is NOT cryptographically
 * strong and does not need to be: the uid's job is uniqueness across one till's
 * queue, and the server's PRIMARY KEY is what actually enforces it.
 */
function saleUid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('')
  return `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`
}

/** Today, as the till's own clock sees it. `document_date` governs the VAT period. */
function todayIso(): string {
  const now = new Date()
  // Local date parts, NOT toISOString(): a sale rung up at 01:00 in UTC+2 is
  // yesterday in UTC, and that would file it in the wrong VAT period and the wrong
  // day's takings.
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Rings up an offline sale.
 *
 * Returns `ok: false` only for the two things that make an offline sale impossible
 * rather than merely awkward: no local sequence to number it from, and a failure to
 * write the queue entry. Both must refuse BEFORE any slip prints — a sale the till
 * cannot record is a sale it must not take.
 */
export async function finaliseOffline(
  input: OfflineFinaliseInput,
): Promise<OfflineFinaliseResult> {
  const { siteId } = input

  /* 1. The number. Refusing here is the honest answer when this till has never
        been online, or when the store numbers site-wide — there is no number it
        could invent that would not risk colliding with another till's. */
  const numbered = await nextLocalNumber(siteId)
  if (!numbered) {
    return {
      ok: false,
      error:
        'This till cannot number a sale offline yet. Connect once so it can pick up its own numbering, then try again.',
    }
  }

  const sale: OfflineSale = {
    saleUid: saleUid(),
    documentNumber: numbered.documentNumber,
    terminalId: input.terminal?.id ?? null,
    terminalCode: input.terminal?.code ?? null,
    operatorUserId: input.operator.userId,
    operatorName: input.operator.name,
    shiftId: input.shiftId,
    takenAt: new Date().toISOString(),
    documentDate: todayIso(),
    priceStructureId: input.priceStructureId,
    customerId: input.customer.id,
    customerName: input.customer.name,
    customerVatNo: input.customer.vatNumber,
    customerPhone: input.customer.phone,
    lines: input.lines,
    tenders: input.tenders,
    claimedTotalIncl: input.totalIncl,
    claimedTenderedTotal: input.tenderedTotal,
    claimedChange: input.change,
    /*
     * Carried, not recomputed at sync.
     *
     * The tiers may have changed by the time this till reconnects — a shop that edits its
     * bands at 18:00 must not have that reprice a bill a customer settled at 17:30. And the
     * declared split is a person's decision about money already handed over; nothing at sync
     * time can reconstruct it.
     *
     * Omitted entirely when there are none, so an OLD queued sale and a new tipless one are
     * byte-identical on the wire.
     */
    ...(input.declaredTips && Object.keys(input.declaredTips).length > 0
      ? { declaredTips: input.declaredTips }
      : {}),
    ...(input.serviceCharge && input.serviceCharge > 0.005
      ? { serviceCharge: input.serviceCharge }
      : {}),
  }

  /* 2. The queue. THE durable record. */
  try {
    await queueSale(siteId, sale)
  } catch (error) {
    /*
     * Nothing was recorded, so the number goes back — this is the one case where
     * releasing is safe, because no slip has printed and this is still the most
     * recently issued counter. Then refuse, so the cashier takes payment on a till
     * that can actually record it rather than handing over goods for a sale that
     * exists nowhere.
     */
    await releaseLocalNumber(siteId, numbered.counter)
    return {
      ok: false,
      error:
        error instanceof Error
          ? `This sale could not be saved on the till: ${error.message}`
          : 'This sale could not be saved on the till.',
    }
  }

  /* 3. Stock, optimistically. Cosmetic — the next refresh overwrites it — and
        deliberately after the queue write, because a failure here must not lose a
        recorded sale. */
  await decrementStock(siteId, input.lines).catch(() => {})

  return { ok: true, documentNumber: sale.documentNumber, saleUid: sale.saleUid, change: input.change }
}

/* ── A return, taken with no server ──────────────────────────────────────── */

export type OfflineReturnInput = {
  siteId: number
  terminal: { id: number; code: string } | null
  operator: { userId: number; name: string }
  /** Who authorised it, when the operator does not hold `sales.credit_note`. */
  authorisedBy: { userId: number; name: string } | null
  shiftId: number | null
  customer: { id: number | null; name: string } | null
  reason: string
  lines: OfflineReturnLine[]
  /** What went back out of the drawer. Empty leaves the credit on the account. */
  refunds: OfflineTender[]
  totalIncl: number
  refundTotal: number
}

export type OfflineReturnResult =
  | { ok: true; documentNumber: string; returnUid: string; refundTotal: number }
  | { ok: false; error: string }

/**
 * Takes a return with no server.
 *
 * The same four steps in the same order as a sale, for the same reasons — number, QUEUE,
 * stock, then let the caller print. Two differences, both in the same direction:
 *
 *   · The number comes from the CREDIT-NOTE sequence, not the invoice one. A credit note
 *     that consumed an invoice number would leave a gap in the invoice register that
 *     nothing explains, and verifySequence would report it as a missing sale.
 *   · Stock goes UP. The goods are back on the shelf, so the optimistic adjustment is the
 *     mirror of a sale's — and a till that showed 0 on hand after taking three back would
 *     have a cashier refusing to sell what is sitting in front of them.
 *
 * The queue-before-print rule matters MORE here than for a sale. A crash between printing
 * and queueing leaves a customer holding a credit note for a refund no system knows about
 * — and unlike a sale, the money has already come out of the drawer, so that record is
 * the only thing standing between the shop and an unexplained shortage at cash-up.
 */
export async function returnOffline(
  input: OfflineReturnInput,
): Promise<OfflineReturnResult> {
  const { siteId } = input

  /* Refused rather than defaulted, and before a number is taken: createCreditNote
     refuses a blank reason server-side, so inventing one here would queue a return that
     is certain to be rejected at sync — after the cash is gone. */
  if (!input.reason.trim()) {
    return { ok: false, error: 'Give a reason for the return.' }
  }
  if (input.lines.length === 0) {
    return { ok: false, error: 'Add what is being returned.' }
  }

  /* 1. The number, from this till's own CRN sequence. Null means the till has no credit
        sequence — registered before migration 079, or a store on site-wide numbering —
        and inventing one could collide with the back office's run. */
  const numbered = await nextLocalNumber(siteId, 'return')
  if (!numbered) {
    return {
      ok: false,
      error:
        'This till cannot number a return offline yet. Connect once so it can pick up its own credit-note numbering, then try again.',
    }
  }

  const ret: OfflineReturn = {
    returnUid: saleUid(),
    documentNumber: numbered.documentNumber,
    terminalId: input.terminal?.id ?? null,
    terminalCode: input.terminal?.code ?? null,
    operatorUserId: input.operator.userId,
    operatorName: input.operator.name,
    authorisedByUserId: input.authorisedBy?.userId ?? null,
    authorisedByName: input.authorisedBy?.name ?? null,
    shiftId: input.shiftId,
    takenAt: new Date().toISOString(),
    documentDate: todayIso(),
    customerId: input.customer?.id ?? null,
    customerName: input.customer?.name ?? null,
    reason: input.reason.trim(),
    lines: input.lines,
    refunds: input.refunds,
    claimedTotalIncl: input.totalIncl,
    claimedRefundTotal: input.refundTotal,
  }

  /* 2. The queue. THE durable record that money left the drawer. */
  try {
    await queueReturn(siteId, ret)
  } catch (error) {
    // Nothing recorded and nothing printed, so the number goes back safely.
    await releaseLocalNumber(siteId, numbered.counter, 'return')
    return {
      ok: false,
      error:
        error instanceof Error
          ? `This return could not be saved on the till: ${error.message}`
          : 'This return could not be saved on the till.',
    }
  }

  /* 3. Stock back on, optimistically — negated quantities through the same helper a
        sale uses, so there is one implementation of "adjust the local pile". */
  await decrementStock(
    siteId,
    input.lines.map((l) => ({ productId: l.productId, qty: -Math.abs(l.qty) })),
  ).catch(() => {})

  return {
    ok: true,
    documentNumber: ret.documentNumber,
    returnUid: ret.returnUid,
    refundTotal: input.refundTotal,
  }
}

/**
 * The shift an offline sale banks into.
 *
 * Read from what the till stored while it was last online, and passed through to the
 * server unchanged. That is the point: the cash went into a specific drawer at a
 * specific moment, and by sync time — possibly the next morning — that shift may be
 * closed and another open. `finaliseDocument` takes this as an explicit value for
 * exactly this reason, and a null means "belongs to no shift" rather than "work it
 * out", which it already treats as legitimate.
 */
export async function currentShiftId(siteId: number): Promise<number | null> {
  const shift = await kvGet<{ id: number } | null>(siteId, KV.shift)
  return shift?.id ?? null
}

/*
 * ── STILL TO COME: cancelling an offline sale before it syncs ──────────────
 *
 * It never reached the server, so there is nothing to void — the entry leaves the
 * outbox instead. But it must NOT be silent: a till that can make a sale disappear
 * without a trace is a till somebody can steal from, so the whole payload is kept
 * for `offline_cancelled_sales` (already in migration 064) and travels on the next
 * sync.
 *
 * ⚠ And the NUMBER IS BURNT, not reused. If the slip printed, reissuing that number
 * would put two different sales under one invoice number, which offline has no
 * unique index to catch. `releaseLocalNumber` above is deliberately usable only for
 * the most recently issued counter with nothing printed since — everything else
 * burns, and the cancelled record is what explains the one gap a till's otherwise
 * gapless run can have.
 *
 * Written down here, beside the code it constrains, rather than rediscovered when
 * the outbox screen is built.
 */
