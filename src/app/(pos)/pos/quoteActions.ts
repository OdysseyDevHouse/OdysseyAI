'use server'

import { actorFor, actorForOrThrow, withTillOperator } from '@/lib/auth'
import { listQuotes, getQuote } from '@/lib/site/quotes'
import { getDocument } from '@/lib/site/salesDocuments'
import { claimDocument, documentClaim } from '@/lib/site/salesDocuments'
import type { QuoteState } from '@/lib/quotesModel'
import type { RecalledSale } from './actions'
import { basketLinesForDocument } from './recalledLines'

/**
 * Quotes, at the till.
 *
 * ── SAME ENGINE, DIFFERENT ENVIRONMENT ────────────────────────────────────
 *
 * The back office already has a complete quote module: a register, validity
 * dates, issue, decline, reopen, and conversion to an invoice. None of it is
 * reimplemented here. This file is a THIN pair of actions over `site/quotes`,
 * shaped for a person standing at a counter rather than sitting at a desk —
 * which is the whole of the difference between the two screens.
 *
 * That split is deliberate and worth stating, because the tempting shortcut is
 * to give the till its own query "just for the list". The moment it has one,
 * the two screens can disagree about what a quote IS — whether an expired one
 * counts as open, whether a cancelled one shows — and the answer a customer
 * gets depends on which screen the person serving them happened to use.
 *
 * ── WHY RECALL IS NOT `recallSaleForTillAction` ───────────────────────────
 *
 * That action refuses anything whose status is not `saved`, which is right for
 * a parked basket: a sale that has moved on has been taken by another till or
 * discarded. But quotes never live in `saved`. They are `draft` while being
 * built and `issued` once sent, and on this database every existing quote is
 * one or the other — so the shared recall would have rejected every quote in
 * the shop while looking like it worked.
 *
 * Everything else it does is reused: the same claim, the same line mapper, and
 * therefore the same re-reading of discount ceilings and shelf prices against
 * TODAY'S product file rather than the ones that applied when the quote was
 * written.
 */

type Denied = { ok: false; error: string }

/** A quote as the till's list shows it. */
export type TillQuote = {
  id: number
  documentNumber: string | null
  customerName: string | null
  totalIncl: number
  /** Derived, never stored — see quotesModel. */
  state: QuoteState
  validUntil: string | null
  /** Negative once past. Null when it never expires. */
  daysRemaining: number | null
  /** Whether the till may pull this one onto the basket — see below. */
  recallable: boolean
}

/**
 * Which quotes a counter can work with.
 *
 * ── WHAT IS LISTED ────────────────────────────────────────────────────────
 *
 * THE WHOLE SHOP'S, not this till's. A customer holding a quote printed at the
 * front counter may well walk up to the back one, and a list scoped per till
 * would send them away over an accident of which machine took the details.
 *
 * Cancelled quotes are excluded, which is `listQuotes` default. Everything else
 * is shown — including expired, declined and accepted ones — because a cashier
 * needs to FIND the quote the customer is holding before anything can be said
 * about it. A list that hides the expired one leaves the customer insisting it
 * exists and the cashier unable to see it, which is worse than showing it and
 * saying it has lapsed.
 *
 * ── AND WHY SOME ARE INERT ────────────────────────────────────────────────
 *
 * Shown, but not tappable — the same reasoning the online-order list uses for a
 * paid order. An ACCEPTED quote has already become an invoice; pulling its
 * lines onto a till would sell the same goods twice with nothing on either
 * screen looking wrong. A DECLINED one was answered.
 *
 * Expired stays recallable on purpose: a shop honouring a lapsed quote is an
 * ordinary commercial decision, and the price is re-read against today's file
 * on the way in regardless, so nothing stale rides along with it.
 */
export async function listTillQuotesAction(search?: string): Promise<TillQuote[]> {
  const { siteId } = await actorForOrThrow('sales.till')

  const { items } = await listQuotes(siteId, { search, limit: 100 })

  return items.map((q) => ({
    id: q.id,
    documentNumber: q.documentNumber,
    customerName: q.customerName,
    totalIncl: q.totalIncl,
    state: q.state,
    validUntil: q.validUntil,
    daysRemaining: q.daysRemaining,
    recallable: q.state !== 'accepted' && q.state !== 'declined' && q.state !== 'cancelled',
  }))
}

/**
 * Puts a quote's lines onto this till.
 *
 * ── THE ACCEPTED CHECK IS THE IMPORTANT ONE ───────────────────────────────
 *
 * An accepted quote has already been converted — there is an invoice with its
 * goods on it and, quite possibly, money against that invoice. Recalling it
 * would ring the same goods up a second time. So it is refused HERE, in the
 * action, and not merely greyed out in the list: the list is a screen and this
 * is the boundary. A second till, a stale list and a fast finger are all it
 * takes to reach this without the button ever having looked disabled.
 *
 * ── WHAT COMES BACK ───────────────────────────────────────────────────────
 *
 * The document id travels with the basket, so saving writes back to the SAME
 * quote rather than making a second one. The basket keeps its `quote` doc type
 * from the module the till is on; nothing here changes what the document is.
 * Turning a quote into an invoice is `convertToInvoice`, a decision somebody
 * makes deliberately — not a side effect of looking at one on a till.
 */
export async function recallQuoteForTillAction(
  quoteId: number,
  priceStructureId: number | null,
  /** Which till is asking. The claim belongs to the terminal — see migration 177. */
  terminalId?: number | null,
): Promise<RecalledSale | Denied> {
  const base = await actorFor('sales.till')
  if ('ok' in base) return base
  const { siteId, actor } = await withTillOperator(base)

  /* Read as a QUOTE, which is what derives `state` — a raw document row has a
     status and an outcome and leaves the expiry arithmetic to the caller. */
  const quote = await getQuote(siteId, quoteId)
  if (!quote) return { ok: false, error: 'That quote no longer exists.' }

  if (quote.state === 'accepted') {
    return {
      ok: false,
      error: quote.convertedToNumber
        ? `That quote was accepted and became invoice ${quote.convertedToNumber}.`
        : 'That quote has already been accepted and invoiced.',
    }
  }
  if (quote.state === 'declined') {
    return { ok: false, error: 'That quote was declined. Reopen it in the back office first.' }
  }
  if (quote.state === 'cancelled') {
    return { ok: false, error: 'That quote was cancelled.' }
  }

  /*
   * CLAIM IT. Two tills with the same quote on screen would both save over it,
   * and the second write would silently discard the first cashier's edits —
   * with a customer standing in front of each of them.
   *
   * Same claim the recalled basket takes, so a quote and a parked sale cannot
   * be held by different mechanisms that do not see each other.
   */
  const claimed = await claimDocument(siteId, quoteId, actor.userId, terminalId ?? null)
  if (!claimed.ok) {
    /* Name the machine holding it. "Open on another till" sends somebody
       hunting; naming it is what lets them walk over or fetch a supervisor. */
    const holder = await documentClaim(siteId, quoteId)
    if (holder?.terminalCode) {
      const since = holder.claimedAt ? ` since ${holder.claimedAt.toISOString().slice(11, 16)}` : ''
      return {
        ok: false,
        error: `That quote is open on ${holder.terminalCode}${since}${
          holder.userName ? ` (${holder.userName})` : ''
        }.`,
      }
    }
    return { ok: false, error: claimed.error }
  }

  /* The document, for its LINES. getQuote answers about the quote's state; the
     lines and their instructions come from the document read. */
  const doc = await getDocument(siteId, quoteId)
  if (!doc) return { ok: false, error: 'That quote could not be read.' }

  return {
    ok: true,
    documentId: doc.id,
    customerId: doc.customerId,
    customerName: doc.customerName,
    /* Re-reads the discount ceiling, shelf price and fraction rule from the
       PRODUCT, not from the stored line — so a quote written before a ceiling
       was tightened comes back under the new one. See recalledLines. */
    lines: await basketLinesForDocument(siteId, doc, priceStructureId),
  }
}
