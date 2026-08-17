'use client'

import { posDb, type LocalDraft } from './db'

/**
 * The basket on screen, kept where a power cut cannot reach it.
 *
 * ── THE PROBLEM THIS SOLVES ───────────────────────────────────────────────
 *
 * A retail basket lived in React state until it was paid or parked. That is fine
 * for a counter sale that takes ninety seconds — but the same till now writes
 * quotations and orders, and somebody thirty lines into a hardware quote has
 * been building it for ten minutes. A browser crash, a power cut, or a PC
 * somebody switched off at the wall took all of it, with nothing to go back to.
 *
 * So the basket is written locally as it is built. Not to the server: that is a
 * round trip per line on a machine that may have no network, and the server does
 * not need to know about a basket nobody has committed to yet. IndexedDB is on
 * the same machine as the cashier, costs nothing, and survives everything except
 * the machine itself.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 *
 * Not the outbox, which holds sales that HAPPENED and may never be deleted.
 * Not `parked`, which holds baskets somebody deliberately set aside.
 *
 * This is the one nobody chose to keep. It is written constantly, deleted the
 * moment the basket becomes something real, and its whole value is being there
 * on the morning after a till went down mid-sale.
 *
 * ── WHY WRITES ARE FIRE-AND-FORGET ────────────────────────────────────────
 *
 * `saveDraft` never throws and never blocks the caller. A till whose IndexedDB
 * is full, blocked by private browsing, or simply slow must keep selling — the
 * draft is insurance, and insurance that stops the shop trading is worse than no
 * insurance. Every failure is swallowed deliberately; the cost is that recovery
 * silently does not happen on a machine that cannot write, which is the right
 * trade against refusing a sale.
 */

/** One draft per till: a till has one basket on screen. */
const DRAFT_KEY = 'current'

/**
 * The doc types a recovered draft may claim to be.
 *
 * Restated here rather than imported from `salesDocuments`, which is
 * `server-only` and cannot be pulled into a client module for its VALUES — a
 * type-only import erases, but this needs the list at runtime.
 *
 * A stored draft is untrusted input like any other: it was written by a possibly
 * older build of this app, and reading a doc type the current one does not know
 * would put a basket on screen that no save path accepts. Anything unrecognised
 * reads back as an invoice, which is what every draft was before types existed.
 */
const DRAFT_DOC_TYPES = ['quote', 'sales_order', 'invoice', 'credit_sale'] as const
export type DraftDocType = (typeof DRAFT_DOC_TYPES)[number]

export function draftDocType(value: unknown): DraftDocType {
  return (DRAFT_DOC_TYPES as readonly string[]).includes(String(value))
    ? (value as DraftDocType)
    : 'invoice'
}

export type DraftInput = {
  documentId: number | null
  docType: string
  customerId: number | null
  customerName: string
  customerVatNo: string | null
  customerPhone: string | null
  priceStructureId: number | null
  returning: boolean
  lines: unknown[]
  totalIncl: number
}

/**
 * Writes the basket. Never throws — see the module docblock.
 *
 * An EMPTY basket clears the draft rather than storing a row with no lines: an
 * empty draft is not something to offer back, and leaving one would have the
 * till ask "recover your sale?" about nothing.
 */
export async function saveDraft(siteId: number, input: DraftInput): Promise<void> {
  try {
    if (input.lines.length === 0) {
      await posDb(siteId).drafts.delete(DRAFT_KEY)
      return
    }
    const row: LocalDraft = {
      key: DRAFT_KEY,
      savedAt: new Date().toISOString(),
      documentId: input.documentId,
      docType: input.docType,
      customerId: input.customerId,
      customerName: input.customerName,
      customerVatNo: input.customerVatNo,
      customerPhone: input.customerPhone,
      priceStructureId: input.priceStructureId,
      returning: input.returning,
      lines: input.lines,
      itemCount: input.lines.length,
      totalIncl: input.totalIncl,
    }
    await posDb(siteId).drafts.put(row)
  } catch {
    // Storage full, blocked, or unavailable. The sale continues without cover.
  }
}

/**
 * The draft left behind by a session that ended badly, if there is one.
 *
 * Returns null on any failure, which the caller reads as "nothing to recover" —
 * the same answer as a clean shutdown, and the right one: a till that could not
 * read its draft should open ready to trade, not stuck on an error about a
 * basket nobody may even want back.
 */
export async function readDraft(siteId: number): Promise<LocalDraft | null> {
  try {
    return (await posDb(siteId).drafts.get(DRAFT_KEY)) ?? null
  } catch {
    return null
  }
}

/**
 * Drops the draft.
 *
 * Called the moment the basket becomes something else — finalised, parked, or
 * cleared. Every one of those is a decision, and a draft that outlived the
 * decision would be offered back to the next customer.
 */
export async function clearDraft(siteId: number): Promise<void> {
  try {
    await posDb(siteId).drafts.delete(DRAFT_KEY)
  } catch {
    // Nothing to do: the next write replaces it, and a stale draft is offered
    // with its own timestamp so a cashier can see it is not theirs.
  }
}
