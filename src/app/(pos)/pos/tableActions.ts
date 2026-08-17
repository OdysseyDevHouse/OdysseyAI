'use server'

import { actorFor, actorForOrThrow, withTillOperator } from '@/lib/auth'
import {
  listTables,
  seatTable,
  freeTable,
  markBillAsked,
  freeTableForDocument,
  type PosTable,
} from '@/lib/site/posTables'
import {
  linkSeatedBookingToBill,
  listReservations,
  setReservationStatus,
  setReservationTable,
} from '@/lib/site/reservations'
import {
  splitTableBill,
  splitBillOntoDocument,
  transferTableBill,
  billLinesForSplit,
  billLinesForSplitByDocument,
} from '@/lib/site/posSplit'
import {
  saveDraft,
  saveForLaterDocument,
  releaseDocument,
  cancelUnpostedDocument,
  getDocument,
  attributeTo,
} from '@/lib/site/salesDocuments'
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
  const denied = await actorFor('sales.till')
  if ('ok' in denied) return denied
  const { siteId, actor } = await withTillOperator(denied)

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
    /* Stamped like every counter line. Missing here until now, so every line on
       every table bill carried no salesperson: commission fell back to whoever
       captured the header, and staff cost — which requires the line stamp —
       dropped restaurant sales entirely. */
    lines: attributeTo(input.lines, actor.userId),
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

  /*
   * If a booking is sitting at this table, point it at the bill.
   *
   * THIS is the moment: a booking is seated when the party walks in, but a bill
   * only exists once they order, so the two facts arrive minutes apart and this
   * is the later one. The queue can then show what the table is spending, which
   * is what `setReservationStatus`'s docblock has promised since the feature
   * shipped and nothing has ever delivered.
   *
   * Fail-soft and unawaited in spirit: a booking that could not be linked is a
   * missing figure on a back-office list, and refusing a real sale to protect a
   * cross-reference would be the wrong trade by a wide margin.
   */
  await linkSeatedBookingToBill(siteId, input.customerName?.trim() ?? '', draft.id).catch(
    () => {},
  )

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
  const denied = await actorFor('sales.till')
  if ('ok' in denied) return denied
  const { siteId, actor } = await withTillOperator(denied)

  const existing = await getDocument(siteId, documentId)
  if (!existing) return { ok: false, error: 'That bill no longer exists.' }
  /* A table's bill is `saved` for its whole life now that a claim lives in its own
     column (171). `draft` is still accepted because a till on the PREVIOUS build claims
     by moving the status, and a mixed fleet mid-upgrade must not have one machine
     refusing to save the table another machine opened.

     What stays refused is a POSTED document — already paid or voided while the waiter
     was adding to it. Appending to a finalised invoice would change a document somebody
     has already been given. */
  if (existing.status !== 'saved' && existing.status !== 'draft') {
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
      lines: attributeTo(carryAttribution(input.lines, existing.lines), actor.userId),
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

/**
 * Keeps each already-saved line pointed at the waiter who rang it up.
 *
 * ── WHY THIS IS NEEDED AT ALL ──────────────────────────────────────────────
 *
 * `saveDraft` DELETEs every line and reinserts the payload (see the DELETE in
 * salesDocuments.ts), and `salePayloadLines` — the till's one whitelist of what
 * a basket line may send — does not carry `salesRepUserId`. So without this,
 * stamping the incoming payload would give the CURRENT operator every line on
 * the bill: a waiter who adds one drink to a colleague's table of ten would
 * take the commission for all eleven.
 *
 * That is exactly the case the per-line column exists to answer, so the
 * attribution is restored from the document rather than trusted from the client
 * — which is also the safer direction, since a client-supplied "who sold it" is
 * a client-chosen one.
 *
 * ── MATCHED BY POSITION, AND WHY THAT IS SOUND HERE ────────────────────────
 *
 * The till appends to the end of the basket and never reorders it, so line N of
 * the payload is line N of the saved bill for as far as the saved bill goes.
 * Anything beyond that length is new and falls through to the current operator.
 *
 * The imperfect case is a line DELETED from the middle: the lines after it
 * shift up one and inherit their neighbour's waiter. Accepted deliberately —
 * the alternative is matching on a line identity the payload does not carry,
 * and voiding a line off a table is rare next to adding to one. Fixing it
 * properly means putting the line id in the payload, which is its own change.
 */
function carryAttribution(
  incoming: LineInput[],
  saved: { salesRepUserId: number | null }[],
): LineInput[] {
  return incoming.map((line, index) => {
    if (line.salesRepUserId != null) return line
    const previous = saved[index]?.salesRepUserId
    return previous == null ? line : { ...line, salesRepUserId: previous }
  })
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

/**
 * Puts a table's bill back on the shelf when the till walks away from it.
 *
 * ── WHY LEAVING HAS TO WRITE ANYTHING AT ALL ──────────────────────────────
 *
 * Resuming a table CLAIMS its document by flipping it to `draft`, so a second till that
 * tries the same bill is refused rather than both of them editing it. That claim has to
 * be given back, and until this existed nothing gave it back: `listTables` joins on
 * `status = 'saved'`, so a table whose bill was left in `draft` read as FREE — its money
 * invisible to the floor, to the split screen and to the tab list alike. A waiter who
 * resumed a table and then walked away stranded it permanently.
 *
 * Belt-and-braces once the claim moves off the status column (see `claimDocument`), but
 * kept: it is what makes a bill safe the instant the till stops looking at it, without
 * waiting for a claim to lapse.
 *
 * Silent on failure BY DESIGN. Every caller is a waiter LEAVING — going back to the
 * floor, closing the sale — and there is nothing they could do about a re-park that did
 * not land. The stale claim expires on its own, so an error here would be a toast about
 * a problem that has already fixed itself.
 */
export async function reparkTableBillAction(documentId: number): Promise<void> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return

  const doc = await getDocument(ctx.siteId, documentId)
  /* Only ever an unposted bill going back to the shelf. A document that was finalised or
     cancelled while the waiter held it must keep that status — re-parking a paid invoice
     would put it back on the floor as an open bill and invite it to be paid twice. */
  if (!doc || (doc.status !== 'draft' && doc.status !== 'saved')) return

  await releaseDocument(ctx.siteId, documentId)
}

/**
 * The bill behind a VOIDED basket, taken off the floor.
 *
 * ── WHY A VOID HAS TO REACH THE SERVER AT ALL ─────────────────────────────
 *
 * Voiding used to be a purely local act: the reducer dropped the lines and the
 * screen went blank. That is the whole story for a retail basket, which lives in
 * the browser until it is paid — but a seated table's basket does NOT. It was
 * parked the moment the first line landed, so clearing the screen left a fully
 * populated `saved` document sitting on the floor. The waiter watched the sale
 * disappear; the table stayed occupied by it, and the next person to tap that
 * table got the voided order back.
 *
 * ── CANCELLED, NOT DELETED ────────────────────────────────────────────────
 *
 * `discardDocument` would remove the row outright, and for an unposted sale that
 * is normally right — it never had a number and never moved stock. It is wrong
 * here: a void is a thing that HAPPENED, `recordVoidAction` has just written
 * rows pointing at this `document_id`, and deleting the document would leave the
 * void trail pointing at nothing. Cancelling keeps both halves of the story and
 * matches how a finalised void reads, so a report joining the two does not have
 * to care which kind it was.
 *
 * Idempotent and quiet, like `reparkTableBillAction` above and for the same
 * reason: the caller is a waiter walking away, the void itself already stands
 * locally, and there is nothing they could usefully do about a failure here.
 */
export async function voidTableBillAction(documentId: number): Promise<void> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return

  const doc = await getDocument(ctx.siteId, documentId)
  /* Only ever an unposted bill. A document finalised while the waiter held it is
     real money on the books, and cancelling it here would silently reverse a
     paid sale — that path is `voidSaleAction`, which asks for a manager. */
  if (!doc || (doc.status !== 'draft' && doc.status !== 'saved')) return

  await cancelUnpostedDocument(ctx.siteId, documentId)
  /* The table is pointed at a document that is no longer an open bill, so it has
     to be let go explicitly — `listTables` joins on `status = 'saved'` and would
     now read the table as free anyway, but leaving the pointer behind strands the
     row's own occupancy flags. */
  await freeTableForDocument(ctx.siteId, documentId)
}

/** The lines on a table's bill, for the split screen to divide. */
export async function billForSplitAction(tableId: number) {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return null
  return billLinesForSplit(ctx.siteId, tableId)
}

/**
 * What a prospective destination already has on it.
 *
 * Same read as `billForSplitAction`, named for what the split screen uses it for: showing
 * the target's own products under "Already on this bill" so a waiter can tell they have
 * picked the right table. Returns null for a free one, which is not an error — it is the
 * answer, and the screen shows an empty slip.
 */
export async function destinationBillAction(tableId: number) {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return null
  return billLinesForSplit(ctx.siteId, tableId)
}

/** The lines on any open sale, for the split screen — by document, not by table. */
export async function billForSplitByDocumentAction(documentId: number) {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return null
  return billLinesForSplitByDocument(ctx.siteId, documentId)
}

/**
 * Splits an open sale onto another open sale, or onto a new one.
 *
 * ── WHY THE DESTINATION IS A DOCUMENT ─────────────────────────────────────
 *
 * Because most open sales are not on the floor plan. A till's open-sales list mixes
 * seated tables with free-text tabs — "Tiaan", "Walk-in", a takeaway — and the
 * table-based split could only ever offer the seated ones. A waiter looking at four open
 * bills was shown one destination, or on a one-table floor, none at all.
 *
 * `sales.till`, like the table split beside it: dividing a bill moves lines between two
 * open sales and creates no money, so whoever may take an order may divide one.
 */
export async function splitBillAction(input: {
  fromDocumentId: number
  toDocumentId: number | null
  newSaleName?: string | null
  moves: { lineId: number; qty: number }[]
}): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = await withTillOperator(ctx)

  const result = await splitBillOntoDocument(siteId, actor, input)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, tables: await listTables(siteId) }
}

/**
 * Moves part of one table's bill onto another table — free, or one already occupied.
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
 * Moves a whole tab to another table.
 *
 * Same right as splitting, for the same reason: it moves lines' address, not
 * money. The party moved; their bill follows them.
 */
export async function transferTableAction(input: {
  fromTableId: number
  toTableId: number
}): Promise<TablesResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await transferTableBill(siteId, actor, input)
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

/* ── Reservations, as the floor sees them ──────────────────────────────────
 *
 * Bookings have lived in a back-office queue that the floor does not have open.
 * "Seat now" there was a status change in a browser tab — it did not touch the
 * floor plan, open a bill, or tell the till anything at all.
 *
 * These two actions put tonight's book where the waiter is standing. They are
 * deliberately thin: the reservations module owns the state machine and refuses
 * an illegal move itself, so nothing here re-implements a rule.
 */

/** One booking, as a till tile draws it. */
export type TillBooking = {
  id: number
  reference: string
  contactName: string
  contactPhone: string
  partySize: number
  /** ISO wall-clock, so the tile can show a time and how near it is. */
  reservedFor: string
  tableName: string
  status: 'confirmed' | 'seated'
  note: string
}

/**
 * Tonight's bookings, for the floor.
 *
 * TODAY ONLY, and only the two states a waiter can act on: a confirmed party
 * still to arrive, and one already seated (so the gate can show which table is
 * spoken for). Pending requests are excluded on purpose — nobody has promised
 * those a table yet, and a waiter is not the person who decides.
 *
 * Returns an empty list rather than refusing when the shop does not take
 * bookings: the gate asks unconditionally, and a retail till or a restaurant
 * with reservations switched off should simply see nothing.
 */
export async function tillBookingsAction(): Promise<TillBooking[]> {
  const { siteId } = await actorForOrThrow('sales.till')

  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
    today.getDate(),
  ).padStart(2, '0')}`

  const rows = await listReservations(siteId, {
    fromDate: key,
    toDate: key,
    statuses: ['confirmed', 'seated'],
    limit: 200,
  })

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    partySize: r.partySize,
    reservedFor: r.reservedFor,
    tableName: r.tableName,
    status: r.status === 'seated' ? 'seated' : 'confirmed',
    note: r.customerNote,
  }))
}

/**
 * The party has arrived — mark the booking seated.
 *
 * Does NOT open the bill. Seating and ringing up are two acts: a waiter seats a
 * party, hands them menus, and comes back when they have chosen. Opening a table
 * here would create an empty bill on the floor for a party that has ordered
 * nothing, which is exactly what `openTableAction` refuses to do for a walk-in.
 *
 * The table is set first when the gate names one, so a booking seated onto a
 * different table than it was pencilled against records where the party actually
 * went rather than where somebody once meant to put them.
 */
export async function seatBookingAction(
  reservationId: number,
  tableName?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const denied = await actorFor('sales.till')
  if ('ok' in denied) return denied
  const { siteId, actor } = await withTillOperator(denied)

  if (tableName !== undefined) {
    const placed = await setReservationTable(siteId, reservationId, tableName, actor)
    if (!placed.ok) return placed
  }

  return setReservationStatus(siteId, reservationId, 'seated', actor)
}
