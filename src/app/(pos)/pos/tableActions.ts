'use server'

import { actorFor, actorForOrThrow } from '@/lib/auth'
import {
  listTables,
  seatTable,
  freeTable,
  markBillAsked,
  freeTableForDocument,
  type PosTable,
} from '@/lib/site/posTables'
import { splitTableBill, billLinesForSplit } from '@/lib/site/posSplit'
import { saveDraft, saveForLaterDocument, getDocument } from '@/lib/site/salesDocuments'
import type { LineInput } from '@/lib/site/salesDocuments'

/**
 * Tables, from the till.
 *
 * ── SEATING IS "PARK A BASKET, THEN POINT AT IT" ───────────────────────────
 *
 * There is no new concept here. `openTableAction` writes an ordinary draft, flips it to
 * `saved` — the same two calls the retail till's Park button makes — and then points the
 * table at it. Which means a table's bill is a saved sale that happens to have a table
 * attached, and every rule about specials, VAT, stock and posting already applies.
 *
 * The order matters: park FIRST, then point. Pointing at a draft would make
 * `listTables` read the table as free (it joins on `status = 'saved'`), so a waiter would
 * seat a table and watch it stay empty.
 *
 * ── GUARDED ON sales.till, NOT setup.edit ─────────────────────────────────
 *
 * Building the floor is configuration; USING it is selling. A waiter who may ring up a
 * sale may seat a table, and requiring a setup right would mean the person doing the job
 * could not do it.
 */

export type TablesResult = { ok: true; tables: PosTable[] } | { ok: false; error: string }

/** The floor as it stands. Read on open and after every change. */
export async function listTablesAction(): Promise<TablesResult> {
  const { siteId } = await actorForOrThrow('sales.till')
  return { ok: true, tables: await listTables(siteId) }
}

export type OpenTableResult =
  | { ok: true; documentId: number; tables: PosTable[] }
  | { ok: false; error: string }

/**
 * Seats a table, creating its bill.
 *
 * ── A TABLE IS SEATED BY ITS FIRST ITEM, NOT BY THE TAP ───────────────────
 *
 * Which is why this takes the lines. `saveDraft` refuses a document with no lines —
 * correctly, because a SAVE with an empty basket is a mistake everywhere else in the app
 * — so tapping a table shows an empty basket and the table only becomes occupied once
 * something is on it.
 *
 * Creating an empty document at tap time would have been simpler and worse: the floor
 * would fill with bills for parties who changed their minds before ordering, and every
 * one of them would need somebody to notice and clear it.
 */
export async function openTableAction(
  tableId: number,
  input: {
    customerName?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
): Promise<OpenTableResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  if (input.lines.length === 0) {
    return { ok: false, error: 'Ring something up before seating the table.' }
  }

  const draft = await saveDraft(siteId, actor, {
    docType: 'invoice',
    /* The table's own name, when the waiter has not attached a customer. It prints on
       the bill and it is what a kitchen ticket is read by. */
    customerName: input.customerName?.trim() || 'Table',
    terminalId: input.terminalId ?? null,
    terminalCode: input.terminalCode ?? null,
    priceStructureId: input.priceStructureId ?? null,
    lines: input.lines,
  })
  if (!draft.ok) return { ok: false, error: draft.error }

  // Parked BEFORE the table points at it — see the note above.
  const parked = await saveForLaterDocument(siteId, draft.id)
  if (!parked.ok) return { ok: false, error: parked.error }

  const seated = await seatTable(siteId, tableId, draft.id)
  if (!seated.ok) {
    /* The table was taken while the waiter was ringing up. The basket is NOT discarded:
       it is a real order somebody took, and it is now in Saved sales where it can be put
       on another table or paid at the counter. Losing it to tidy up a pointer would lose
       the order. */
    return {
      ok: false,
      error: `${seated.error} The order is safe in Saved sales.`,
    }
  }

  return { ok: true, documentId: draft.id, tables: await listTables(siteId) }
}

/**
 * Adds to a table that already has a bill.
 *
 * Rewrites the saved document's lines wholesale, which is what `saveDraft` does with an
 * id — and is right here for the same reason it is right at the counter: the till holds
 * the whole basket in state and sends all of it, so matching up which line moved is work
 * with no payoff on a document that has not posted.
 */
export async function updateTableBillAction(
  documentId: number,
  input: {
    customerName?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const existing = await getDocument(siteId, documentId)
  if (!existing) return { ok: false, error: 'That bill no longer exists.' }
  if (existing.status !== 'saved') {
    /* Already paid, or voided, while the waiter was adding to it. Refused rather than
       silently reopened: a finalised invoice is on the books, and appending to it would
       change a document somebody has already been given. */
    return { ok: false, error: 'That bill has already been settled.' }
  }

  const saved = await saveDraft(
    siteId,
    actor,
    {
      docType: 'invoice',
      customerName: input.customerName?.trim() || 'Table',
      terminalId: input.terminalId ?? null,
      terminalCode: input.terminalCode ?? null,
      priceStructureId: input.priceStructureId ?? null,
      lines: input.lines,
    },
    documentId,
  )
  if (!saved.ok) return { ok: false, error: saved.error }

  /* Back to `saved`. saveDraft leaves a document as it found it for an update, but the
     status is the thing `listTables` joins on — so this is belt-and-braces against a
     future change there quietly emptying the floor. */
  await saveForLaterDocument(siteId, documentId)

  return { ok: true, tables: await listTables(siteId) }
}

/** Marks the bill as asked for, so the floor shows who is waiting to pay. */
export async function askForBillAction(tableId: number): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await markBillAsked(siteId, tableId)
  if (!result.ok) return result
  return { ok: true, tables: await listTables(siteId) }
}

/** The lines on a table's bill, for the split screen to divide. */
export async function billForSplitAction(tableId: number) {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return null
  return billLinesForSplit(ctx.siteId, tableId)
}

/**
 * Moves part of one table's bill onto another table.
 *
 * `sales.till` rather than a right of its own. Splitting moves lines between two open
 * bills and creates no money — nothing is discounted, voided or paid — so whoever may
 * take an order may divide one. A separate capability would leave a shop able to seat
 * tables but not split them, which is a state no restaurant wants.
 *
 * Re-checked here rather than trusted from the screen that offered the gesture: a server
 * action is a public endpoint, and the only capability check that counts is the one a
 * client cannot skip.
 */
export async function splitTableAction(input: {
  fromTableId: number
  toTableId: number
  moves: { lineId: number; qty: number }[]
}): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await splitTableBill(siteId, actor, input)
  if (!result.ok) return result
  return { ok: true, tables: await listTables(siteId) }
}

/**
 * Lets a table go without paying.
 *
 * For a party that walked, or a table seated by mistake. The BILL is left alone — it
 * stays in Saved sales, because an order somebody took is a record even when nobody
 * paid, and discarding it here would be a way to make a sale disappear without a trace.
 * Whoever wants it gone discards it from the saved-sales list, which logs.
 */
export async function releaseTableAction(tableId: number): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = await freeTable(siteId, tableId)
  if (!result.ok) return result
  return { ok: true, tables: await listTables(siteId) }
}

/**
 * Frees whichever table held a document, after it posts.
 *
 * Called by the till once a bill is paid. Idempotent and deliberately quiet: a table
 * that failed to release is visible on the gate and fixable in a tap, whereas failing
 * the sale would undo real money to tidy up a flag.
 */
export async function tablePaidAction(documentId: number): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  await freeTableForDocument(siteId, documentId)
  return { ok: true, tables: await listTables(siteId) }
}
