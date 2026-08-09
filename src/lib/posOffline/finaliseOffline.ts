'use client'

import { nextLocalNumber, releaseLocalNumber } from './saleNumber'
import { queueSale } from './sync'
import { decrementStock } from './catalog'
import { kvGet, KV } from './db'
import type { OfflineSale, OfflineSaleLine, OfflineTender } from './types'

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
