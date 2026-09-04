import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'
import { columnsFor, listPrinters, reachableFrom, type PrinterConnection, type Printer } from './printers'
import { getTerminal } from './terminals'

/**
 * Kitchen printing — which products go where, and what has already gone there.
 *
 * ── WHAT MOVED OUT OF HERE ────────────────────────────────────────────────
 *
 * 229 gave this file three layers: the printer LIST, the product routing, and
 * the per-till physical address. The list and the address turned out not to be
 * kitchen-specific at all — every document has a printer and every machine
 * reaches it somehow — so 246 generalised both. They now live in
 * lib/site/printers.ts, and what stays here is what is genuinely about food:
 * which products fire a ticket, and what each printer has already been told.
 *
 * `listKitchenPrinters` and `printerMapForTerminal` remain as the narrow views
 * their callers want, delegating rather than duplicating. Two queries for "the
 * shop's printers" is exactly how the two would drift.
 *
 * A product with no printers never reaches a kitchen, and that is the ordinary
 * case rather than a gap to be defaulted away — see `printersForProducts`.
 */

/** The printer list as the kitchen screens want it: only the kitchen ones. */
export type KitchenPrinter = Printer

type Row = RowDataPacket & Record<string, unknown>

/**
 * The printers a product may be routed to.
 *
 * Filtered to `purpose = 'kitchen'` so the product form's picker offers the
 * Grill and the Bar and not the office laser. A filter rather than a boundary:
 * nothing breaks if a general printer is routed to, it is simply not offered.
 */
export async function listKitchenPrinters(
  siteId: number,
  includeInactive = false,
): Promise<KitchenPrinter[]> {
  const all = await listPrinters(siteId, includeInactive)
  return all.filter((p) => p.purpose === 'kitchen')
}

/* ── Product routing ──────────────────────────────────────────────────── */

/** The printer ids one product routes to. Empty means it never prints. */
export async function printersForProduct(siteId: number, productId: number): Promise<number[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT printer_id FROM product_kitchen_printers WHERE product_id = ?`,
    [productId],
  ).catch(() => [] as Row[])
  return rows.map((r) => Number(r.printer_id))
}

/**
 * Replaces a product's routing wholesale.
 *
 * Delete-then-insert inside one transaction, rather than a diff: the set is at
 * most a handful of ids, and a half-applied diff would route food to a printer
 * nobody chose. An EMPTY list is a legitimate save meaning "this stops going to
 * the kitchen" — it must not be read as "leave it alone".
 */
export async function setPrintersForProduct(
  siteId: number,
  productId: number,
  printerIds: readonly number[],
): Promise<void> {
  const unique = [...new Set(printerIds.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))]
  await siteTransaction(siteId, async (tx) => {
    await tx.execute(`DELETE FROM product_kitchen_printers WHERE product_id = ?`, [productId])
    for (const printerId of unique) {
      /* IGNORE absorbs a printer deleted between the read and the save. The
         alternative is failing a product save because somebody else tidied up
         setup mid-edit, which is a worse outcome than one dropped route. */
      await tx.execute(
        `INSERT IGNORE INTO product_kitchen_printers (product_id, printer_id) VALUES (?, ?)`,
        [productId, printerId],
      )
    }
  })
}

/**
 * Routing for MANY products at once — what the send path needs.
 *
 * One query for the whole basket rather than one per line: a table of twelve
 * would otherwise be twelve round trips on the path between a waiter's tap and
 * paper coming out of a machine.
 *
 * Products with no routing are ABSENT from the map rather than present with an
 * empty array. Callers must treat missing as "does not print" — which is the
 * same branch either way, and keeps the map small on a retail catalogue where
 * almost nothing routes anywhere.
 */
export async function printersForProducts(
  siteId: number,
  productIds: readonly number[],
): Promise<Map<number, number[]>> {
  const ids = [...new Set(productIds.filter((n) => Number.isFinite(n) && n > 0))]
  const map = new Map<number, number[]>()
  if (ids.length === 0) return map

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT pkp.product_id, pkp.printer_id
       FROM product_kitchen_printers pkp
       INNER JOIN printers p ON p.id = pkp.printer_id
      WHERE pkp.product_id IN (${ids.map(() => '?').join(',')})
        AND p.is_active = 1`,
    ids,
  ).catch(() => [] as Row[])

  for (const row of rows) {
    const productId = Number(row.product_id)
    const printerId = Number(row.printer_id)
    const list = map.get(productId)
    if (list) list.push(printerId)
    else map.set(productId, [printerId])
  }
  return map
}

/**
 * The kitchen groups this shop already uses, for the product form's suggestions.
 *
 * Free text is what makes the field work for a shop that groups by course and
 * one that groups by station — but it also means "Starters" and "starters" are
 * one keystroke apart. Offering what already exists is how that stays a
 * convenience rather than a trap: the send path matches case-insensitively
 * anyway, so a mismatch costs an oddly-cased heading rather than a course that
 * cannot be fired.
 */
export async function distinctKitchenGroups(siteId: number): Promise<string[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT DISTINCT kitchen_group
       FROM products
      WHERE kitchen_group <> ''
      ORDER BY kitchen_group ASC
      LIMIT 100`,
  ).catch(() => [] as Row[])
  return rows.map((r) => String(r.kitchen_group))
}

/* ── Where a machine sends its tickets ────────────────────────────────── */

export type TerminalPrinterMap = {
  printerId: number
  printerName: string
  /**
   * How this machine opens that printer — an IP, or an OS queue name.
   *
   * EMPTY MEANS UNREACHABLE, and the send path skips it. That contract is
   * unchanged from 229; what changed is where the answer comes from. It used to
   * be a bridge spool name typed per till; it is now the resolved address from
   * `printerLinksForDevice`, which may be the shop's own network address rather
   * than anything this machine had to be told.
   */
  bridgePrinter: string
  /**
   * WHICH KIND of address that is.
   *
   * Sent rather than inferred. The client could guess from the string's shape —
   * dots and digits look like an IP — but a printer queue called "TM-T20.2" or a
   * network printer addressed by bare hostname would each guess wrong, and the
   * failure is a ticket that silently goes nowhere. The server resolved it; it
   * costs one field to say so.
   */
  connection: PrinterConnection
  port: number | null
  /**
   * How wide the docket paper is, from the KITCHEN printer's own row.
   *
   * A shop with a 58mm docket printer at the pass and an 80mm head at the
   * counter is ordinary, and one column count for both prints one of them
   * wrong.
   */
  columns: number | null
}

/**
 * What a MACHINE can reach, one row per active kitchen printer.
 *
 * Every active kitchen printer appears, reachable or not — the unreachable ones
 * carry an empty string. A setup screen has to show the gaps, because a missing
 * answer is exactly the state where food silently stops printing, and a list
 * that only showed what was already working could never reveal it.
 */
export async function printerMapForDevice(
  siteId: number,
  deviceId: string,
): Promise<TerminalPrinterMap[]> {
  const printers = await listPrinters(siteId)
  return printers
    .filter((p) => p.purpose === 'kitchen')
    .map((p) => {
      const reachable = reachableFrom(p, deviceId)
      return {
        printerId: p.id,
        printerName: p.name,
        bridgePrinter: reachable ? p.target : '',
        connection: p.connection,
        port: p.port,
        columns: columnsFor(p),
      }
    })
}

/**
 * The same answer, for callers that hold a till rather than a machine.
 *
 * The POS knows which terminal it is long before it thinks about printers, so
 * this stays as the shape its two call sites want. It resolves the terminal to
 * the machine currently holding it and delegates — because printer setup is a
 * fact about the MACHINE, and a till nobody has claimed reaches nothing, which
 * is the honest answer rather than an error.
 */
export async function printerMapForTerminal(
  siteId: number,
  terminalId: number,
): Promise<TerminalPrinterMap[]> {
  const terminal = await getTerminal(siteId, terminalId)
  if (!terminal?.deviceId) return []
  return printerMapForDevice(siteId, terminal.deviceId)
}

/* ── Send history ─────────────────────────────────────────────────────── */

/**
 * How a ticket came to be raised.
 *
 * `auto` is the send when a tab is committed, `manual` a waiter pressing the
 * key, `cancel` a void telling the kitchen to STOP. Worth keeping apart: "the
 * kitchen got it twice" is a different bug depending on which fired, and a
 * cancellation must be excluded from any report counting what was ordered.
 */
export type KitchenSendSource = 'auto' | 'manual' | 'cancel'

/**
 * How much of each line has already gone to each printer.
 *
 * Keyed `lineId:printerId` because that pair IS the delta's grain — see 229.
 * A line sent to the Bar owes the Grill everything regardless, and a single
 * per-line number could not express it.
 */
export async function sentQtyByLineAndPrinter(
  siteId: number,
  documentId: number,
): Promise<Map<string, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ksl.line_id, ks.printer_id, SUM(ksl.qty) AS qty
       FROM kitchen_send_lines ksl
       INNER JOIN kitchen_sends ks ON ks.id = ksl.send_id
      WHERE ks.document_id = ?
      GROUP BY ksl.line_id, ks.printer_id`,
    [documentId],
  ).catch(() => [] as Row[])

  const map = new Map<string, number>()
  for (const row of rows) {
    map.set(`${Number(row.line_id)}:${Number(row.printer_id)}`, toNum(row.qty))
  }
  return map
}

/**
 * What each printer has been told about a DOCUMENT'S PRODUCTS, not its lines.
 *
 * The cancellation path needs this because a voided basket line carries no
 * database line id — the basket's `key` is a client string, and by the time a
 * void is confirmed the line may not exist on the document at all. The product
 * is the durable handle: it survives a re-key, a merge of two lines of the same
 * item, and a line removed from the document entirely.
 *
 * Keyed `productId:printerId`, summing every line of that product.
 */
export async function sentQtyByProductAndPrinter(
  siteId: number,
  documentId: number,
): Promise<Map<string, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT l.product_id, ks.printer_id, SUM(ksl.qty) AS qty
       FROM kitchen_send_lines ksl
       INNER JOIN kitchen_sends ks ON ks.id = ksl.send_id
       INNER JOIN sales_document_lines l ON l.id = ksl.line_id
      WHERE ks.document_id = ? AND l.product_id IS NOT NULL
      GROUP BY l.product_id, ks.printer_id`,
    [documentId],
  ).catch(() => [] as Row[])

  const map = new Map<string, number>()
  for (const row of rows) {
    map.set(`${Number(row.product_id)}:${Number(row.printer_id)}`, toNum(row.qty))
  }
  return map
}

/**
 * One line of the document carrying a given product, for a cancellation to
 * hang its negative quantity on.
 *
 * A cancellation is recorded against a real line so the FK holds and the row
 * joins like any other. Which line, when a product appears on several, does not
 * matter: every reader of this table sums by (product or line) × printer, and a
 * negative against any line of that product reduces the same total.
 */
export async function anyLineForProduct(
  siteId: number,
  documentId: number,
  productId: number,
): Promise<number | null> {
  const row = await siteQuery<Row>(
    siteId,
    `SELECT id FROM sales_document_lines
      WHERE document_id = ? AND product_id = ?
      ORDER BY id ASC LIMIT 1`,
    [documentId, productId],
  ).catch(() => [] as Row[])
  return row.length > 0 ? Number(row[0].id) : null
}

/**
 * Records one physical ticket.
 *
 * Called only AFTER the client says paper came out — see kitchenActions.ts for
 * why that order is deliberate. Writes the header and its lines in one
 * transaction so a crash cannot leave a send that claims to have printed
 * nothing, which would re-send the whole course on the next save.
 *
 * A CANCELLATION is the same shape with negative quantities and
 * `source: 'cancel'` — see recordKitchenCancel. That is what lets the delta
 * arithmetic stay one SUM: an item sent then cancelled nets to zero, so the
 * kitchen owes it again if the customer changes their mind back.
 */
export async function recordKitchenSend(
  siteId: number,
  input: {
    documentId: number
    printerId: number
    terminalId: number | null
    sentBy: number | null
    sentByName: string
    source: KitchenSendSource
    lines: readonly { lineId: number; qty: number }[]
  },
): Promise<number> {
  /* Zero carries no information and would write a ticket claiming nothing.
     Negatives ARE meaningful — that is a cancellation, see recordKitchenCancel —
     so the filter tests for zero rather than for "not positive". */
  const lines = input.lines.filter((l) => l.qty !== 0)
  if (lines.length === 0) return 0

  return siteTransaction(siteId, async (tx) => {
    const [header] = await tx.execute(
      `INSERT INTO kitchen_sends
         (document_id, printer_id, terminal_id, sent_by, sent_by_name, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.documentId,
        input.printerId,
        input.terminalId,
        input.sentBy,
        input.sentByName.slice(0, 120),
        input.source,
      ],
    )
    const sendId = (header as { insertId: number }).insertId

    for (const line of lines) {
      await tx.execute(`INSERT INTO kitchen_send_lines (send_id, line_id, qty) VALUES (?, ?, ?)`, [
        sendId,
        line.lineId,
        line.qty.toFixed(3),
      ])
    }
    return sendId
  })
}

/**
 * Records a CANCELLATION — the delta rule running backwards.
 *
 * ── WHY A NEGATIVE ROW AND NOT A FLAG ────────────────────────────────────
 *
 * The whole feature rests on one arithmetic: what a printer is owed is
 * `qty − SUM(what it has been sent)`. A cancellation is simply a send of a
 * negative quantity, so that SUM keeps working untouched — no reader learns a
 * new concept, no query grows a special case.
 *
 * It also gets the awkward cases right for free. Cancel 2 of 5 Cokes and the
 * bar has still legitimately had 3, so it is owed nothing and the docket says
 * two came off. Cancel an item and then re-ring it, and the net returns to zero
 * — meaning the kitchen is owed it again, which is exactly right: they were
 * told to stop, so they must be told to start.
 *
 * ── NEVER MORE THAN WAS SENT ─────────────────────────────────────────────
 *
 * Clamped at what that printer actually received. Voiding a line the kitchen
 * never saw cancels NOTHING and prints no docket — announcing "CANCEL: steak"
 * for food nobody is cooking sends a chef looking for an order that does not
 * exist. Over-cancelling would also drive the net negative, which would read as
 * the kitchen being owed MORE than was ordered.
 */
export async function recordKitchenCancel(
  siteId: number,
  input: {
    documentId: number
    printerId: number
    terminalId: number | null
    sentBy: number | null
    sentByName: string
    lines: readonly { lineId: number; qty: number }[]
  },
): Promise<number> {
  return recordKitchenSend(siteId, {
    ...input,
    source: 'cancel',
    // Negated here rather than at every call site, so a caller passing what it
    // wants cancelled cannot accidentally send MORE food by getting a sign wrong.
    lines: input.lines
      .filter((l) => l.qty > 0)
      .map((l) => ({ lineId: l.lineId, qty: -l.qty })),
  })
}
