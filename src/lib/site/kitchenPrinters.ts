import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'

/**
 * Kitchen printers — the three layers of "where does this food go".
 *
 * A logical printer ("Bar") is one row here. Products point at it. Each TILL
 * says which of its own spool queues that name means. The reasoning for the
 * split is in sql/site/229_kitchen_printing.sql; the short version is that
 * the menu changes weekly, the hardware changes yearly, and neither should
 * have to be re-done because the other did.
 *
 * A product with no printers never reaches a kitchen, and that is the
 * ordinary case rather than a gap to be defaulted away — see
 * `printersForProducts`.
 */

export type KitchenPrinter = {
  id: number
  name: string
  sortOrder: number
  isActive: boolean
  /** How many products currently route here. Shown so a rename is informed. */
  productCount: number
  /** How many tills can actually reach it. Zero is the "nothing prints" trap. */
  terminalCount: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapPrinter(r: Row): KitchenPrinter {
  return {
    id: Number(r.id),
    name: String(r.name),
    sortOrder: Number(r.sort_order ?? 0),
    isActive: Number(r.is_active ?? 1) === 1,
    productCount: Number(r.product_count ?? 0),
    terminalCount: Number(r.terminal_count ?? 0),
  }
}

export async function listKitchenPrinters(
  siteId: number,
  includeInactive = false,
): Promise<KitchenPrinter[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.*,
            (SELECT COUNT(*) FROM product_kitchen_printers pkp WHERE pkp.printer_id = p.id) AS product_count,
            (SELECT COUNT(*) FROM terminal_kitchen_printers tkp WHERE tkp.printer_id = p.id) AS terminal_count
       FROM kitchen_printers p
      ${includeInactive ? '' : 'WHERE p.is_active = 1'}
      ORDER BY p.sort_order ASC, p.name ASC`,
  ).catch(() => [] as Row[])
  return rows.map(mapPrinter)
}

export async function createKitchenPrinter(
  siteId: number,
  name: string,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'Give the printer a name.' }
  if (clean.length > 60) return { ok: false, error: 'That name is too long — 60 characters at most.' }

  /* Reactivate rather than refuse when the name is already taken by a
     deactivated printer. "Bar" coming back after a refit is the same Bar, and
     its history should reconnect rather than become "Bar 2". */
  const existing = await siteQuery<Row>(
    siteId,
    `SELECT id, is_active FROM kitchen_printers WHERE name = ? LIMIT 1`,
    [clean],
  )
  if (existing.length > 0) {
    const row = existing[0]
    if (Number(row.is_active) === 1) {
      return { ok: false, error: `There is already a printer called “${clean}”.` }
    }
    await siteExecute(siteId, `UPDATE kitchen_printers SET is_active = 1 WHERE id = ?`, [row.id])
    return { ok: true, id: Number(row.id) }
  }

  const result = await siteExecute(
    siteId,
    `INSERT INTO kitchen_printers (name, sort_order)
     VALUES (?, (SELECT COALESCE(MAX(s.sort_order), 0) + 10 FROM (SELECT sort_order FROM kitchen_printers) s))`,
    [clean],
  )
  return { ok: true, id: result.insertId }
}

export async function renameKitchenPrinter(
  siteId: number,
  id: number,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = name.trim()
  if (!clean) return { ok: false, error: 'Give the printer a name.' }
  if (clean.length > 60) return { ok: false, error: 'That name is too long — 60 characters at most.' }

  const clash = await siteQuery<Row>(
    siteId,
    `SELECT id FROM kitchen_printers WHERE name = ? AND id <> ? LIMIT 1`,
    [clean, id],
  )
  if (clash.length > 0) return { ok: false, error: `There is already a printer called “${clean}”.` }

  await siteExecute(siteId, `UPDATE kitchen_printers SET name = ? WHERE id = ?`, [clean, id])
  return { ok: true }
}

/**
 * Turns a printer off. Never deletes.
 *
 * Tickets already sent point at this row, and kitchen_sends holds the FK with
 * ON DELETE RESTRICT — so deleting a printer that has ever cooked anything is
 * refused by the database. Deactivating is what the screen offers instead: the
 * routing rules stay put, so turning it back on restores the shop's setup
 * rather than asking somebody to re-tick four hundred products.
 */
export async function setKitchenPrinterActive(
  siteId: number,
  id: number,
  active: boolean,
): Promise<void> {
  await siteExecute(siteId, `UPDATE kitchen_printers SET is_active = ? WHERE id = ?`, [
    active ? 1 : 0,
    id,
  ])
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
       INNER JOIN kitchen_printers p ON p.id = pkp.printer_id
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

/* ── Per-till mapping ─────────────────────────────────────────────────── */

export type TerminalPrinterMap = {
  printerId: number
  printerName: string
  /** The bridge's own name for the spool queue. Empty means unreachable. */
  bridgePrinter: string
}

/**
 * What THIS till can reach, one row per active logical printer.
 *
 * Every active printer appears, mapped or not — the unmapped ones carry an
 * empty `bridgePrinter`. A setup screen has to show the gaps, because a
 * missing row is exactly the state where food silently stops printing, and a
 * list that only showed what was already working could never reveal it.
 */
export async function printerMapForTerminal(
  siteId: number,
  terminalId: number,
): Promise<TerminalPrinterMap[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.name, COALESCE(tkp.bridge_printer, '') AS bridge_printer
       FROM kitchen_printers p
       LEFT JOIN terminal_kitchen_printers tkp
              ON tkp.printer_id = p.id AND tkp.terminal_id = ?
      WHERE p.is_active = 1
      ORDER BY p.sort_order ASC, p.name ASC`,
    [terminalId],
  ).catch(() => [] as Row[])

  return rows.map((r) => ({
    printerId: Number(r.id),
    printerName: String(r.name),
    bridgePrinter: String(r.bridge_printer ?? ''),
  }))
}

/**
 * Points one till's logical printer at one of its spool queues.
 *
 * Blank CLEARS the mapping rather than storing an empty string, so "this till
 * cannot reach the grill" has exactly one representation — no row — and every
 * reader tests the same thing.
 */
export async function setTerminalPrinter(
  siteId: number,
  terminalId: number,
  printerId: number,
  bridgePrinter: string,
): Promise<void> {
  const clean = bridgePrinter.trim()
  if (!clean) {
    await siteExecute(
      siteId,
      `DELETE FROM terminal_kitchen_printers WHERE terminal_id = ? AND printer_id = ?`,
      [terminalId, printerId],
    )
    return
  }
  await siteExecute(
    siteId,
    `INSERT INTO terminal_kitchen_printers (terminal_id, printer_id, bridge_printer)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE bridge_printer = VALUES(bridge_printer)`,
    [terminalId, printerId, clean.slice(0, 190)],
  )
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
