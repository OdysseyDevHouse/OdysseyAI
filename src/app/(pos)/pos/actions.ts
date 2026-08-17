'use server'

import { actorForOrThrow, withTillOperator } from '@/lib/auth'
import {
  listSaved,
  listOpenTabs,
  getDocument,
  claimDocument,
  documentClaim,
  listDocuments,
} from '@/lib/site/salesDocuments'
import { basketLinesForDocument, type RecalledLine } from './recalledLines'
import { siteQuery } from '@/lib/siteDb'
import { recordServiceChargeRemoval } from '@/lib/site/tips'
import { logActivity } from '@/lib/site/activityLog'
import { recordVoidEvents, type VoidType } from '@/lib/site/posVoids'
import { requireSalesReason } from '@/lib/site/salesReasons'
import type { BasketLine } from '@/lib/basket'

/**
 * Server actions the touch till needs and the desk till does not.
 *
 * Everything else the POS does goes through `(app)/sales/actions` — the same
 * actions the desk till uses, so there is one gate (`sales.till`), one pricing
 * re-check, and one posting path. Only what is genuinely POS-shaped lives here.
 */

/** A parked basket, as the saved-sales list shows it. */
export type SavedSaleRow = {
  id: number
  customerName: string | null
  totalIncl: number
  /** How many LINES, which is what a cashier recognises a basket by. */
  lineCount: number
  updatedAt: string
}

/**
 * The parked baskets, with a line count.
 *
 * `listSaved` maps its documents with an empty `lines` array — it is a list
 * query and deliberately does not join the lines — so the count is fetched
 * separately rather than derived from a `lines.length` that is always zero.
 * Getting that wrong would show every parked sale as "0 items", which is exactly
 * the field a cashier uses to find theirs.
 *
 * Returns a narrowed shape rather than SalesDocument: the modal needs five
 * fields, and shipping the whole document to the browser sends a customer's
 * address and internal notes to a screen that has no use for either.
 */
export async function listSavedSalesAction(terminalId: number | null): Promise<SavedSaleRow[]> {
  // Throws rather than returning a refusal union: this is a read behind a screen
  // that already required `sales.till` to render, so a refusal here means
  // something is wrong rather than something the caller should handle. Same
  // choice the other read-only sales actions make.
  const { siteId } = await actorForOrThrow('sales.till')

  const docs = await listSaved(siteId, terminalId ?? undefined)
  if (docs.length === 0) return []

  const counts = await siteQuery<{ document_id: number; n: number }>(
    siteId,
    `SELECT document_id, COUNT(*) AS n
       FROM sales_document_lines
      WHERE document_id IN (${docs.map(() => '?').join(',')})
      GROUP BY document_id`,
    docs.map((d) => d.id),
  )
  const byDoc = new Map(counts.map((c) => [Number(c.document_id), Number(c.n)]))

  return docs.map((d) => ({
    id: d.id,
    customerName: d.customerName,
    totalIncl: d.totalIncl,
    lineCount: byDoc.get(d.id) ?? 0,
    // ISO rather than a Date: a Date crossing the server/client boundary in a
    // server action arrives as a string anyway, and saying so keeps the type
    // honest about what the browser actually receives.
    updatedAt: d.updatedAt.toISOString(),
  }))
}

/* ── The hospitality floor ───────────────────────────────────────────────── */

/**
 * One open tab, as the table gate draws it.
 *
 * ── WHY A TAB IS A SAVED SALE AND NOT A `pos_tables` ROW ────────────────────
 *
 * A restaurant tab is opened by a waiter typing a number or a customer's name
 * at the moment somebody sits down. It is not configuration, and making one
 * would mean writing a permanent row into the back-office table list every time
 * a walk-in orders a coffee — a setup screen that fills with rubbish, and a
 * floor plan that grows a tile for "Tiaan Smith".
 *
 * So the tab IS the bill: a `sales_documents` row with `status = 'saved'`,
 * labelled by `reference`. `pos_tables` keeps its own job — the drawn floor
 * plan and the physical furniture — and the two meet only when a tab's label
 * happens to match a table's code.
 */
export type OpenTab = {
  documentId: number
  /**
   * What the tile says. The typed reference, else the customer's name, else
   * "N/A" — a sale parked by an older till with no label at all still has to be
   * reachable, and a blank tile is one nobody can tap with confidence.
   */
  label: string
  /** Shown under the label, unless the customer IS the label. */
  customerName: string | null
  /** Who opened it — a waiter searches for their own tables. */
  userName: string
  lineCount: number
  totalIncl: number
  personCount: number | null
  visitTypeId: number | null
  visitTypeName: string | null
  /** ISO — a Date crossing a server action arrives as a string regardless. */
  updatedAt: string
}

/**
 * Every open tab in the SHOP, not just on this till.
 *
 * Deliberately unscoped by terminal: a waiter opens table 12 on the bar till
 * and settles it at the pass, and a floor that only listed the tabs this screen
 * happened to open would strand every other one.
 */
export async function listOpenTabsAction(): Promise<OpenTab[]> {
  const { siteId } = await actorForOrThrow('sales.till')
  const rows = await listOpenTabs(siteId)

  return rows.map((r) => {
    const reference = (r.reference ?? '').trim()
    const customer = (r.customerName ?? '').trim()
    return {
      documentId: r.id,
      label: reference || customer || 'N/A',
      // Blank when the customer's name is already the headline, so the tile
      // does not print the same string twice.
      customerName: reference ? customer || null : null,
      userName: r.userName,
      lineCount: r.lineCount,
      totalIncl: r.totalIncl,
      personCount: r.personCount,
      visitTypeId: r.visitTypeId,
      visitTypeName: r.visitTypeName,
      updatedAt: r.updatedAt.toISOString(),
    }
  })
}

/* ── Recalling a parked basket ───────────────────────────────────────────── */

/** A parked basket, converted back into something the till can put on screen. */
export type RecalledSale =
  | {
      ok: true
      documentId: number
      customerId: number | null
      customerName: string | null
      lines: RecalledLine[]
    }
  | { ok: false; error: string }

/* The line shape and the mapping that builds it live in `recalledLines`, which
   the online-order action shares — see that module for why it is not exported
   from here. Re-exported so existing importers are undisturbed. */
export type { RecalledLine } from './recalledLines'

/**
 * Reads a parked basket back onto the till.
 *
 * ── WHY THIS IS NOT JUST `getDocument` ────────────────────────────────────
 *
 * A stored line records what was CHARGED — quantity, price, discount, VAT, cost.
 * A basket line needs three things more, and none of them are on the line because
 * none of them are properties of the sale:
 *
 *   maxDiscountPct   the ceiling the line editor enforces
 *   shelfPriceIncl   what the shelf says, so an override can be told from it
 *   allowFractions   whether − may take half a unit
 *
 * They live on the PRODUCT, and they are re-read here rather than remembered.
 * That is the point: a basket parked yesterday against a product whose discount
 * ceiling has since been tightened must come back under the NEW ceiling, not the
 * one that applied when it was parked. Reading them fresh is what makes recall
 * safe rather than a way to smuggle stale rules back in.
 *
 * A product deleted since parking keeps its line — the description and price are
 * on the document, so the sale is still sellable — but gets a zero ceiling and no
 * shelf price, because there is no longer a product to say otherwise.
 */
export async function recallSaleForTillAction(
  documentId: number,
  priceStructureId: number | null,
  /**
   * Which till is asking.
   *
   * The claim belongs to the TERMINAL (177), so this is what decides whether a
   * bill can be resumed: the same till always gets its own back, and any other
   * is refused until a supervisor overrides. Null is an unclaimed machine, which
   * falls back to the older user-owned claim — see claimDocument.
   */
  terminalId?: number | null,
): Promise<RecalledSale> {
  const { siteId, actor } = await withTillOperator(await actorForOrThrow('sales.till'))

  const doc = await getDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That saved sale no longer exists.' }
  if (doc.status !== 'saved') {
    // Another till got there first, or it was discarded from the back office.
    return { ok: false, error: 'That sale has already been taken or discarded.' }
  }

  // CLAIM it first. Two tills recalling the same basket would otherwise both put it on
  // screen and the second would fail at finalise, in front of a customer — so the claim
  // is taken under the database's own guard and exactly one of them wins.
  //
  // The claim no longer moves the document out of `saved`, which is what a table's
  // occupancy is read from: a resumed table used to read as FREE, its bill invisible to
  // the floor and the split screen, and stranded outright if the till never came back.
  // See 171_document_claim.sql.
  const claimed = await claimDocument(siteId, documentId, actor.userId, terminalId ?? null)
  if (!claimed.ok) {
    /* Say WHICH till is holding it. "That sale is open on another till" sends
       somebody hunting; naming the machine and how long it has held the bill is
       what lets them go and look, or fetch a supervisor. */
    const holder = await documentClaim(siteId, documentId)
    if (holder?.terminalCode) {
      const since = holder.claimedAt
        ? ` since ${holder.claimedAt.toISOString().slice(11, 16)}`
        : ''
      return {
        ok: false,
        error: `That sale is open on ${holder.terminalCode}${since}${
          holder.userName ? ` (${holder.userName})` : ''
        }.`,
      }
    }
    return { ok: false, error: claimed.error }
  }

  return {
    ok: true,
    documentId: doc.id,
    customerId: doc.customerId,
    customerName: doc.customerName,
    lines: await basketLinesForDocument(siteId, doc, priceStructureId),
  }
}

/**
 * Records that a manager removed a forced service charge.
 *
 * ── WHY THIS IS ITS OWN ACTION AND NOT PART OF THE FINALISE ────────────────
 *
 * The removal is a fact worth keeping even when the sale is not completed. A manager who
 * takes a charge off a bill and then voids it still took it off, and a shop looking at who
 * removes service charges — which is the whole reason a forced charge is removable at all
 * — wants that visible. Folding it into `finaliseSaleAction` would record only the removals
 * that happened to end in a sale.
 *
 * `sales.discount_override`, re-checked here rather than trusted from the screen that
 * offered the button: a server action is a public endpoint, and the only capability check
 * that counts is the one a client cannot skip. A waiter calling this directly gets nothing.
 */
export async function recordServiceChargeWaivedAction(
  documentId: number | null,
  amount: number,
): Promise<{ ok: boolean }> {
  const { siteId, actor } = await actorForOrThrow('sales.discount_override')
  await recordServiceChargeRemoval(siteId, actor, {
    documentId,
    amount,
    /* No free-text reason from the till. The pad has no room for one mid-sale, and a
       forced-and-empty box collects "asdf" — the name, the amount and the moment are the
       facts that make the pattern visible, and those are all recorded. */
    reason: 'Removed at the till',
  })
  return { ok: true }
}

/**
 * Records a line taken back off the basket.
 *
 * ── WHY AN UNDO IS WORTH A ROW ────────────────────────────────────────────
 *
 * Nothing posted, so there is nothing to reverse and nothing an auditor could
 * reconcile against — which is exactly why this has to be written down here or
 * not at all. A line rung up and removed leaves no trace in any document: the
 * sale that finalises is simply a sale without it. An honest mis-scan and a
 * cashier ringing goods up, taking the money and undoing the line produce the
 * identical absence, and the only thing that separates them is how often it
 * happens and to whom.
 *
 * So EVERY undo is recorded, including the ones inside the limit. The limit is
 * about what the till permits; this is about what it remembers, and a shop that
 * sets the limit to 0 for convenience should not thereby switch off the trail.
 *
 * Fire-and-forget from the caller's point of view — `logActivity` swallows its
 * own errors, so a failed audit row can never block the undo it describes. The
 * cashier's correction is not held hostage to the logging of it.
 *
 * `sales.till` and nothing heavier: undoing is inside a cashier's ordinary
 * rights, and requiring more would mean the till could not record the undos it
 * had just allowed.
 */
export async function recordUndoAction(input: {
  /** The draft this basket has, when it has one. Most are undone before that. */
  documentId: number | null
  productId: number | null
  description: string
  qty: number
  /** What the line was worth — the figure that makes a pattern worth reading. */
  lineTotalIncl: number
  /** Which undo this was on this basket: 1 for the first. */
  undoNumber: number
  terminalCode: string | null
}): Promise<{ ok: boolean }> {
  /* The PIN operator, not the browser session. A manager who signed this till in
     at seven is not the person who pressed undo at four, and a trail naming them
     is worse than no trail — it accuses the wrong person. */
  const { siteId, actor } = await withTillOperator(await actorForOrThrow('sales.till'))

  await logActivity(siteId, actor, {
    entity: 'pos_undo',
    entityId: input.documentId,
    action: 'undo',
    detail: `${formatQty(input.qty)} × ${input.description}`,
    /* The shape `changes` takes everywhere else is from/to. An undo has no
       "from" — the line simply stopped existing — so `to: null` says removed and
       `from` carries what was removed. Reading the log, that is the sentence:
       this was there, now it is not. */
    changes: {
      line: { from: input.description, to: null },
      qty: { from: input.qty, to: null },
      value: { from: input.lineTotalIncl, to: null },
      productId: { from: input.productId, to: null },
      undoNumber: { from: null, to: input.undoNumber },
      terminal: { from: null, to: input.terminalCode },
    },
  })
  return { ok: true }
}

/** Trailing zeros off a till quantity: "2" rather than "2.000". */
function formatQty(qty: number): string {
  return Number.isInteger(qty) ? String(qty) : String(Number(qty.toFixed(3)))
}

/** One thing the cashier voided off the draft, as the till reports it. */
export type VoidEventPayload = {
  voidType: VoidType
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  /** Gross, before line discount — the same basis the undo trail uses. */
  valueIncl: number
}

/**
 * Records what a cashier took off a sale that was never finalised.
 *
 * ── WHY THIS IS NOT voidSaleAction ────────────────────────────────────────
 *
 * They are different events and the vocabulary matters. `voidSaleAction`
 * CANCELS a finalised document — stock back, money reversed, status cancelled.
 * This records a VOID: something removed from a draft, where nothing has posted
 * and there is nothing to reverse. The legacy system used void for this second
 * meaning, which is why the first was renamed to cancel; writing both through
 * one path would put reversed invoices in a report asking what the till loses
 * to voids.
 *
 * ── WHY IT IS WORTH A ROW ─────────────────────────────────────────────────
 *
 * The same argument `recordUndoAction` makes, and more sharply. A line rung up
 * and voided leaves NO trace in any document — the sale that finalises is
 * simply a sale without it. An honest mis-scan and a cashier ringing goods up,
 * taking the cash and voiding the line produce an identical absence, and the
 * only thing separating them is how often it happens and to whom. Without this
 * table that question has no answer at all.
 *
 * ── WHY THE SERVER RE-RESOLVES THE REASON ─────────────────────────────────
 *
 * The client sends a reason id, which arrives from a browser and may be stale —
 * an offline till replays voids hours after a manager retired the reason. So
 * `requireSalesReason` resolves it here and the row stores the code it returns,
 * not one the client supplied. A rejected reason still records the void with a
 * null reason rather than dropping it: the goods left the sale either way, and
 * a void with an unresolved reason is worth incomparably more than no row.
 *
 * `sales.till` and nothing heavier: voiding a mis-scan is inside a cashier's
 * ordinary rights, and requiring more would mean the till could not record the
 * voids it had just permitted.
 */
export async function recordVoidAction(input: {
  reasonId: number
  note: string | null
  documentId: number | null
  terminalId: number | null
  terminalCode: string | null
  shiftId: number | null
  /** Set when a whole basket went, tying its rollup to its line rows. */
  groupId: string | null
  events: VoidEventPayload[]
}): Promise<{ ok: boolean }> {
  /* The PIN operator, not the browser session. A manager who signed this till
     in at seven is not the person who voided a line at four, and a trail naming
     them is worse than no trail — it accuses the wrong person. */
  const { siteId, actor } = await withTillOperator(await actorForOrThrow('sales.till'))

  const chosen = await requireSalesReason(siteId, 'void', input.reasonId)

  const ok = await recordVoidEvents(
    siteId,
    {
      userId: actor.userId,
      userName: actor.userName,
      terminalId: input.terminalId,
      terminalCode: input.terminalCode,
      shiftId: input.shiftId,
    },
    input.events.map((e) => ({
      voidType: e.voidType,
      groupId: input.groupId,
      reasonId: input.reasonId,
      /* The code the SERVER resolved, not one the client sent. */
      reasonCode: chosen.ok ? chosen.reason.code : null,
      note: input.note,
      documentId: input.documentId,
      productId: e.productId,
      productCode: e.productCode,
      description: e.description,
      qty: e.qty,
      valueIncl: e.valueIncl,
    })),
  )
  return { ok }
}

/** A past sale, as the reprint list shows it. */
export type PastSaleRow = {
  id: number
  documentNumber: string | null
  /** ISO date. The till formats it — the server does not know the locale. */
  date: string
  customerName: string | null
  totalIncl: number
  /** How many times it has been printed. Above zero, the next one says COPY. */
  printCount: number
}

/**
 * Finalised invoices, newest first, for the reprint list.
 *
 * ── WHY THE WHOLE SHOP AND NOT JUST THIS TILL ─────────────────────────────
 *
 * A customer comes back for a slip they were never given, or lost. They do not
 * know which register served them, and the person at the counter now may not be
 * the person who served them — so a list scoped to this terminal answers the
 * question "what did I sell" when the question actually being asked is "what did
 * this shop sell". Scoping it to the till would send somebody to the other
 * register to look, which is not a workflow, it is a wild goose chase.
 *
 * The reach is real, so it is bounded rather than pretended away: finalised
 * invoices only — nothing draft, saved or cancelled — and reading one is a
 * `sales.view` right that a cashier without it does not get. Every reprint stamps
 * COPY through `printCount`, so a duplicate can never pass for an original.
 *
 * `search` is what makes the reach usable rather than merely large. Without a
 * term this returns the most recent sales, which is the common case (the customer
 * is still in the shop); with one it matches a number, a customer name or a
 * reference, which is what somebody holding a slip or a bank statement has.
 */
export async function listPastSalesAction(
  search: string,
  limit = 40,
): Promise<PastSaleRow[]> {
  const { siteId } = await actorForOrThrow('sales.view')

  const { items } = await listDocuments(siteId, {
    docTypes: ['invoice'],
    /* Finalised ONLY. A draft has no number and no money against it, and a
       cancelled invoice must never be reprintable — a cancelled document that can
       be handed to a customer on paper is a document that still exists. */
    statuses: ['finalised'],
    search: search.trim() || undefined,
    limit: Math.min(Math.max(limit, 1), 100),
  })

  return items.map((doc) => ({
    id: doc.id,
    documentNumber: doc.documentNumber,
    date: doc.documentDate,
    customerName: doc.customerName,
    totalIncl: doc.totalIncl,
    printCount: doc.printCount,
  }))
}
