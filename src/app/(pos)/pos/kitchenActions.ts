'use server'

import { actorFor } from '@/lib/auth'
import { getDocument } from '@/lib/site/salesDocuments'
import { getSetting } from '@/lib/site/settings'
import {
  printersForProducts,
  printerMapForTerminal,
  sentQtyByLineAndPrinter,
  sentQtyByProductAndPrinter,
  anyLineForProduct,
  recordKitchenSend,
  recordKitchenCancel,
} from '@/lib/site/kitchenPrinters'
import { kitchenDelta, groupKitchenLines, kitchenGroupKey } from '@/lib/kitchenTicket'
import type { KitchenTicketData } from '@/lib/escpos/slips'

/**
 * Send-to-kitchen, the server half.
 *
 * ── PRINT THEN MARK, IN THAT ORDER ───────────────────────────────────────
 *
 * The ordering is the design: the server cannot reach a printer on the shop's
 * LAN, so the CLIENT prints (through its local bridge) and only then calls
 * `markKitchenSentAction`. A failed print marks nothing — the retry reprints; a
 * failed mark risks only a duplicate ticket, and a kitchen shrugs at a
 * duplicate where a lost ticket is a lost meal.
 *
 * ── ONE TICKET PER PRINTER ───────────────────────────────────────────────
 *
 * A tab fans out into as many tickets as it has destinations. Each carries its
 * own delta, because "what the Bar has seen" and "what the Grill has seen" are
 * different questions — see sql/site/229. Each is marked separately too, so a
 * bar printer that is out of paper does not re-fire the food.
 *
 * ── A PRODUCT WITH NO PRINTER IS SKIPPED ─────────────────────────────────
 *
 * Silently and by design. There is no default printer: a product nobody routed
 * is a product with nothing to tell a kitchen — a bag of ice, a T-shirt — and
 * inventing a destination for it would put paper in front of a chef for every
 * till roll sold.
 */

/** One printer's worth of a send: what to print, and where this till sends it. */
export type KitchenTicketJob = {
  printerId: number
  /** The bridge's spool name on THIS till. Empty means unreachable from here. */
  bridgePrinter: string
  ticket: KitchenTicketData
  /** What to mark once paper actually comes out. */
  lines: { lineId: number; qty: number }[]
}

export type KitchenTicketResult =
  | { ok: true; jobs: KitchenTicketJob[] }
  | { ok: false; error: string }

/**
 * What may be fired, rather than everything outstanding.
 *
 * The three-course case is the whole reason this exists: a table orders
 * starters, mains and dessert in one sitting, and the waiter releases each
 * course as the kitchen needs it. `groups` and `lineIds` are the two ways a
 * person actually thinks about that — "send the starters", or "send that one
 * steak now".
 *
 * Undefined means everything outstanding, which is what the automatic send on
 * save passes.
 */
export type KitchenScope = {
  /** Group headings to include, matched case- and whitespace-insensitively. */
  groups?: string[]
  /** Specific line ids to include. */
  lineIds?: number[]
}

export async function kitchenTicketAction(
  documentId: number,
  terminalId: number | null,
  scope?: KitchenScope,
): Promise<KitchenTicketResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const doc = await getDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That bill no longer exists.' }
  if (doc.status !== 'saved') {
    return { ok: false, error: 'Save the table first — only a parked tab can send to the kitchen.' }
  }

  /* Which lines the caller is asking about. An explicit scope narrows it; the
     automatic send passes none and means "everything outstanding". */
  const wantedGroups = scope?.groups?.map(kitchenGroupKey)
  const wantedLineIds = scope?.lineIds ? new Set(scope.lineIds) : null
  const inScope = doc.lines.filter((line) => {
    if (wantedLineIds && !wantedLineIds.has(line.id)) return false
    if (wantedGroups && !wantedGroups.includes(kitchenGroupKey(line.kitchenGroup))) return false
    return true
  })
  if (inScope.length === 0) return { ok: false, error: 'Nothing on this tab matches what you picked.' }

  /* Routing and history, both keyed off the lines in play. Two queries for the
     whole tab rather than two per line — this sits between a waiter's tap and
     paper coming out of a machine. */
  const [routing, alreadySent, terminalMap] = await Promise.all([
    printersForProducts(
      siteId,
      inScope.map((l) => l.productId).filter((id): id is number => id !== null),
    ),
    sentQtyByLineAndPrinter(siteId, documentId),
    terminalId ? printerMapForTerminal(siteId, terminalId) : Promise.resolve([]),
  ])

  const bridgeFor = new Map(terminalMap.map((m) => [m.printerId, m.bridgePrinter]))
  const nameFor = new Map(terminalMap.map((m) => [m.printerId, m.printerName]))

  /* Invert the routing: for each printer, which lines owe it something. A line
     routed to two printers appears under both, with its own delta in each. */
  const byPrinter = new Map<number, typeof inScope>()
  for (const line of inScope) {
    if (line.productId === null) continue
    for (const printerId of routing.get(line.productId) ?? []) {
      const list = byPrinter.get(printerId)
      if (list) list.push(line)
      else byPrinter.set(printerId, [line])
    }
  }
  if (byPrinter.size === 0) {
    return { ok: false, error: 'None of these items are set up to print to a kitchen printer.' }
  }

  const at = new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
  const jobs: KitchenTicketJob[] = []

  for (const [printerId, lines] of byPrinter) {
    const delta = kitchenDelta(
      lines.map((line) => ({
        lineId: line.id,
        qty: Math.abs(line.qty),
        sentQty: alreadySent.get(`${line.id}:${printerId}`) ?? 0,
      })),
    )
    if (delta.length === 0) continue

    const byId = new Map(lines.map((l) => [l.id, l]))
    const printerName = nameFor.get(printerId) ?? ''

    jobs.push({
      printerId,
      bridgePrinter: bridgeFor.get(printerId) ?? '',
      ticket: {
        tableLabel: doc.customerName?.trim() || 'Table',
        printerName,
        /* The SENDER, not the bill's original waiter — the runner delivers to
           whoever pressed the key. */
        waiter: actor.userName,
        at,
        covers: doc.personCount,
        groups: groupKitchenLines(
          delta.map((d) => {
            const line = byId.get(d.lineId)!
            return {
              qty: d.qty,
              description: line.description,
              notes: line.instructions
                .filter((i) => i.printsOnKitchen)
                .map((i) => (i.qty > 1 ? `${i.qty} × ${i.optionName}` : i.optionName)),
              // The free-text note — "allergy: nuts" MUST reach the kitchen.
              note: line.note,
              kitchenGroup: line.kitchenGroup,
            }
          }),
        ),
      },
      lines: delta,
    })
  }

  if (jobs.length === 0) return { ok: false, error: 'Nothing new to send — the kitchen has it all.' }
  return { ok: true, jobs }
}

/**
 * Records what was PRINTED, for one printer.
 *
 * One call per ticket rather than one per send, so a bar printer that jammed
 * leaves the bar's lines unmarked while the kitchen's stay sent. Marking them
 * together would make one failure re-fire everything.
 */
export async function markKitchenSentAction(
  documentId: number,
  printerId: number,
  lines: { lineId: number; qty: number }[],
  terminalId: number | null,
  source: 'auto' | 'manual',
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  await recordKitchenSend(siteId, {
    documentId,
    printerId,
    terminalId,
    sentBy: actor.userId,
    sentByName: actor.userName,
    source,
    lines: lines.filter((l) => l.qty > 0),
  })
  return { ok: true }
}

/**
 * Whether the automatic send is switched on for this site.
 *
 * Read on the client before every auto-send, which sounds wasteful and is not:
 * a shop that turns this off mid-service should stop firing food on the next
 * save rather than at the next page reload, and a till holds a page open for a
 * whole shift.
 *
 * FAILS ON. A control-database blip must not silently stop a restaurant's food
 * reaching the kitchen — the failure mode of an unwanted duplicate ticket is a
 * shrug, and the failure mode of a missing one is a table waiting an hour.
 */
export async function kitchenAutoPrintEnabledAction(): Promise<boolean> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return true
  try {
    return (await getSetting(ctx.siteId, 'pos_auto_print_kitchen')) !== '0'
  } catch {
    return true
  }
}

/**
 * The courses on a tab that still owe a printer something — what the
 * send-to-kitchen key offers a waiter.
 *
 * Only groups with something OUTSTANDING appear. A starters course already
 * fired is not a choice; offering it would invite a waiter to send it twice and
 * then wonder why the kitchen was annoyed.
 */
export type KitchenSendOption = {
  /** The group heading, or empty for the ungrouped remainder. */
  group: string
  /** Lines in this group that still owe at least one printer. */
  lines: { lineId: number; description: string; qty: number }[]
}

export async function kitchenSendOptionsAction(
  documentId: number,
): Promise<{ ok: true; options: KitchenSendOption[] } | { ok: false; error: string }> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const doc = await getDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That bill no longer exists.' }

  const [routing, alreadySent] = await Promise.all([
    printersForProducts(
      siteId,
      doc.lines.map((l) => l.productId).filter((id): id is number => id !== null),
    ),
    sentQtyByLineAndPrinter(siteId, documentId),
  ])

  const options = new Map<string, KitchenSendOption>()
  for (const line of doc.lines) {
    if (line.productId === null) continue
    const printers = routing.get(line.productId) ?? []
    if (printers.length === 0) continue

    /* Outstanding against the printer that is FURTHEST BEHIND. A line the bar
       has had but the grill has not still has something to send, and taking the
       maximum is what keeps it on the list until every destination is caught
       up. */
    const outstanding = Math.max(
      ...printers.map((printerId) =>
        Math.max(0, Math.abs(line.qty) - (alreadySent.get(`${line.id}:${printerId}`) ?? 0)),
      ),
    )
    if (outstanding <= 0) continue

    const title = line.kitchenGroup.trim()
    const key = kitchenGroupKey(title)
    const entry = options.get(key)
    const item = { lineId: line.id, description: line.description, qty: outstanding }
    if (entry) entry.lines.push(item)
    else options.set(key, { group: title, lines: [item] })
  }

  return { ok: true, options: [...options.values()] }
}

/* ── Cancellation ─────────────────────────────────────────────────────── */

/** One voided item, as the till knows it at the moment of the void. */
export type KitchenCancelItem = {
  productId: number
  description: string
  /** How much came off the basket. Clamped to what was actually sent. */
  qty: number
}

/**
 * Builds the STOP-COOKING dockets for a void.
 *
 * ── ONLY WHAT THE KITCHEN ACTUALLY HAS ───────────────────────────────────
 *
 * The quantity cancelled is clamped to what that printer was sent. Voiding a
 * line the kitchen never saw produces NO docket at all — announcing "CANCEL:
 * steak" for food nobody is cooking sends a chef looking for an order that does
 * not exist, which is worse than silence. It is also why this returns an empty
 * job list rather than an error for that case: nothing went wrong, there is
 * simply nothing to say.
 *
 * ── RESOLVED BY PRODUCT, NOT BY LINE ─────────────────────────────────────
 *
 * A voided basket line carries no database line id — the basket's key is a
 * client string, and by the time the void is confirmed the line may be gone
 * from the document entirely. The product is the durable handle; see
 * `sentQtyByProductAndPrinter`.
 */
export async function kitchenCancelTicketAction(
  documentId: number,
  terminalId: number | null,
  items: KitchenCancelItem[],
  reason: string,
): Promise<KitchenTicketResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const wanted = items.filter((i) => i.productId > 0 && i.qty > 0)
  if (wanted.length === 0) return { ok: false, error: 'Nothing to cancel.' }

  const [routing, alreadySent, terminalMap] = await Promise.all([
    printersForProducts(siteId, wanted.map((i) => i.productId)),
    sentQtyByProductAndPrinter(siteId, documentId),
    terminalId ? printerMapForTerminal(siteId, terminalId) : Promise.resolve([]),
  ])

  const bridgeFor = new Map(terminalMap.map((m) => [m.printerId, m.bridgePrinter]))
  const nameFor = new Map(terminalMap.map((m) => [m.printerId, m.printerName]))

  /* Per printer, what of this void it has actually had. Two lines of the same
     product in one void are summed first: they are one thing to a kitchen, and
     clamping them separately against a shared total would cancel twice. */
  const byPrinter = new Map<number, Map<number, { description: string; qty: number }>>()
  for (const item of wanted) {
    for (const printerId of routing.get(item.productId) ?? []) {
      const had = alreadySent.get(`${item.productId}:${printerId}`) ?? 0
      if (had <= 0) continue

      const forPrinter = byPrinter.get(printerId) ?? new Map()
      const running = forPrinter.get(item.productId)
      const claimed = (running?.qty ?? 0) + item.qty
      // Never more than the kitchen was told about — see the docblock.
      const qty = Math.min(claimed, had)
      if (qty <= 0) continue

      forPrinter.set(item.productId, { description: item.description, qty })
      byPrinter.set(printerId, forPrinter)
    }
  }
  if (byPrinter.size === 0) return { ok: true, jobs: [] }

  const at = new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
  const doc = await getDocument(siteId, documentId)
  const jobs: KitchenTicketJob[] = []

  for (const [printerId, products] of byPrinter) {
    /* A real line of the document to hang the negative on, so the FK holds and
       the row joins like any other send. Which line does not matter — every
       reader sums by product × printer. */
    const lines: { lineId: number; qty: number }[] = []
    const ticketLines: {
      qty: number
      description: string
      notes: string[]
      note: string
      kitchenGroup: string
    }[] = []

    for (const [productId, entry] of products) {
      const lineId = await anyLineForProduct(siteId, documentId, productId)
      if (lineId === null) continue
      lines.push({ lineId, qty: entry.qty })
      ticketLines.push({
        qty: entry.qty,
        description: entry.description,
        notes: [],
        note: '',
        /* The course, so a cancellation files under the same heading the order
           did — a chef looking for "2 Steak" under MAINS should find the
           cancellation there too rather than in an unsorted pile. */
        kitchenGroup:
          doc?.lines.find((l) => l.productId === productId)?.kitchenGroup ?? '',
      })
    }
    if (lines.length === 0) continue

    jobs.push({
      printerId,
      bridgePrinter: bridgeFor.get(printerId) ?? '',
      ticket: {
        tableLabel: doc?.customerName?.trim() || 'Table',
        printerName: nameFor.get(printerId) ?? '',
        waiter: actor.userName,
        at,
        covers: doc?.personCount ?? null,
        cancelled: true,
        reason,
        groups: groupKitchenLines(ticketLines),
      },
      lines,
    })
  }

  return { ok: true, jobs }
}

/**
 * Records a cancellation once the paper is out.
 *
 * The mirror of `markKitchenSentAction`, and PRINT THEN MARK for the same
 * reason inverted: a cancellation that marks without printing leaves the
 * kitchen cooking food the system believes it has stopped, which is the one
 * outcome worth failing loudly over.
 */
export async function markKitchenCancelledAction(
  documentId: number,
  printerId: number,
  lines: { lineId: number; qty: number }[],
  terminalId: number | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  await recordKitchenCancel(siteId, {
    documentId,
    printerId,
    terminalId,
    sentBy: actor.userId,
    sentByName: actor.userName,
    lines,
  })
  return { ok: true }
}
