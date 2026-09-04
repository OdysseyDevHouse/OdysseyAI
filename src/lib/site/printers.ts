import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import { PAPER_COLUMNS, type PrinterPaper } from '../printing/documents'
import type { ConfiguredPrinter, PrinterConnection, PrinterPurpose } from '../printing/resolve'

/**
 * The shop's printers. Each one knows where it is.
 *
 * ── ONE QUESTION, ASKED ONCE ──────────────────────────────────────────────
 *
 * A printer is reached one of two ways, chosen when it is created:
 *
 *   'queue'    an OS print queue on ONE named machine — a USB printer, or a
 *              network one somebody installed in Windows. Picked from a
 *              dropdown of that machine's real queues, so nobody types a name.
 *   'network'  raw TCP to an address. No driver needed anywhere, reachable from
 *              every machine at once — how a kitchen printer is usually wired.
 *
 * An earlier version split this in two (a shop-wide printer plus a per-machine
 * "how do I reach it" row) so a network IP could be edited once. It asked the
 * same question twice and confused everyone who read the screen. The full
 * argument, and what the split bought, is in sql/site/247.
 *
 * ── WHAT "PER DEVICE" MEANS NOW ───────────────────────────────────────────
 *
 * The printer LIST is the shop's. The ASSIGNMENTS — which document comes out of
 * which printer — are per machine, which is where per-device setup actually
 * lives. A queue printer is simply not offered on any machine but its own, and
 * the document drawer says why rather than greying it out silently.
 */

export type { PrinterPurpose, PrinterConnection, ConfiguredPrinter }

export type Printer = {
  id: number
  name: string
  purpose: PrinterPurpose
  paper: PrinterPaper
  slipColumns: number | null
  connection: PrinterConnection
  /** For 'queue': whose machine. Null for a network printer, and for a queue
   *  printer whose machine has been forgotten. */
  deviceId: string | null
  /** A queue name, or a host. */
  target: string
  shareName: string
  port: number | null
  drawerKick: boolean
  sortOrder: number
  isActive: boolean
  /** The machine's own name, LEFT JOINed, so a row can say where it is. */
  deviceLabel: string | null
  /** How many products route here. Shown so a rename or switch-off is informed. */
  productCount: number
  /** How many documents point here, across every machine. */
  documentCount: number
  /** Nothing names a way in yet. The amber state. */
  unconfigured: boolean
}

export type PrinterInput = {
  name: string
  purpose: PrinterPurpose
  paper: PrinterPaper
  slipColumns: number | null
  connection: PrinterConnection
  deviceId: string | null
  target: string
  shareName: string
  port: number | null
  drawerKick: boolean
}

export type PrinterResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

const PAPERS: readonly PrinterPaper[] = ['slip80', 'slip58', 'a4', 'label']
const PURPOSES: readonly PrinterPurpose[] = ['kitchen', 'general']
const CONNECTIONS: readonly PrinterConnection[] = ['queue', 'network']

function mapPrinter(r: Row): Printer {
  const connection = String(r.connection ?? 'queue') as PrinterConnection
  const target = String(r.target ?? '')
  const deviceId = (r.device_id as string | null) ?? null
  return {
    id: Number(r.id),
    name: String(r.name),
    purpose: String(r.purpose ?? 'general') as PrinterPurpose,
    paper: String(r.paper ?? 'slip80') as PrinterPaper,
    slipColumns: r.slip_columns == null ? null : Number(r.slip_columns),
    connection,
    deviceId,
    target,
    shareName: String(r.share_name ?? ''),
    port: r.port == null ? null : Number(r.port),
    drawerKick: Number(r.drawer_kick ?? 0) === 1,
    sortOrder: Number(r.sort_order ?? 0),
    isActive: Number(r.is_active ?? 1) === 1,
    deviceLabel: (r.device_label as string | null) ?? null,
    productCount: Number(r.product_count ?? 0),
    documentCount: Number(r.document_count ?? 0),
    /* A queue printer needs both a machine and a queue name; a network one needs
       an address. Either half missing and nothing will come out — which the
       screen must say, because it is the state a half-finished setup leaves. */
    unconfigured: connection === 'queue' ? !deviceId || !target : !target,
  }
}

const SELECT_PRINTER = `
  SELECT p.*,
         COALESCE(NULLIF(d.label, ''), t.name) AS device_label,
         (SELECT COUNT(*) FROM product_kitchen_printers pkp WHERE pkp.printer_id = p.id) AS product_count,
         (SELECT COUNT(*) FROM device_document_printers ddp WHERE ddp.printer_id = p.id) AS document_count
    FROM printers p
    LEFT JOIN devices d ON d.device_id = p.device_id
    LEFT JOIN terminals t ON t.device_id = p.device_id
`

export async function listPrinters(siteId: number, includeInactive = false): Promise<Printer[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_PRINTER}
      ${includeInactive ? '' : 'WHERE p.is_active = 1'}
      ORDER BY p.sort_order ASC, p.name ASC`,
  ).catch(() => [] as Row[])
  return rows.map(mapPrinter)
}

/**
 * Whether a given machine can reach a printer.
 *
 * The whole reachability rule, in two lines — which is the point of 247. A
 * network printer is reachable from anywhere on the LAN; a queue printer only
 * from the machine its queue is installed on.
 */
export function reachableFrom(printer: Printer, deviceId: string | null): boolean {
  if (printer.unconfigured) return false
  if (printer.connection === 'network') return true
  return deviceId !== null && printer.deviceId === deviceId
}

/** Why not, in a sentence a person can act on. Null when it is reachable. */
export function unreachableBecause(printer: Printer, deviceId: string | null): string | null {
  if (reachableFrom(printer, deviceId)) return null
  if (printer.unconfigured) {
    return printer.connection === 'queue'
      ? 'No printer has been picked for it yet.'
      : 'It has no network address yet.'
  }
  return printer.deviceLabel
    ? `Plugged into ${printer.deviceLabel}, not this machine.`
    : 'The machine it was plugged into is no longer set up here.'
}

/** Validates a printer as the screen may submit it. Shared by create and update. */
function checkInput(input: PrinterInput): { ok: true; name: string } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'Give the printer a name.' }
  if (name.length > 60) return { ok: false, error: 'That name is too long — 60 characters at most.' }
  if (!PAPERS.includes(input.paper)) return { ok: false, error: 'Pick what paper is loaded in it.' }
  if (!PURPOSES.includes(input.purpose)) return { ok: false, error: 'That is not a kind of printer.' }
  if (!CONNECTIONS.includes(input.connection)) {
    return { ok: false, error: 'That is not a way to reach a printer.' }
  }

  /* A HALF-FINISHED printer is allowed to save, deliberately.
   *
   * A manager setting up the office PC's laser from the counter cannot pick a
   * queue that only exists on the office PC. Refusing the save would mean the
   * printer cannot be created until somebody walks to that machine — so it
   * saves, reads "needs a printer picked", and is finished in one click from
   * there. What is NOT allowed is a contradiction: a name with no way in at all
   * once one has been claimed. */
  if (input.connection === 'network' && input.target.trim() && !isHostish(input.target.trim())) {
    return { ok: false, error: 'That is not a printer address.' }
  }
  if (input.port != null && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) {
    return { ok: false, error: 'That is not a port number.' }
  }
  if (
    input.slipColumns != null &&
    (!Number.isInteger(input.slipColumns) || input.slipColumns < 16 || input.slipColumns > 96)
  ) {
    return { ok: false, error: 'Characters across must be between 16 and 96.' }
  }
  return { ok: true, name }
}

/** A bare hostname or IP. Mirrors electron/printTargets.js, which is the gate. */
function isHostish(value: string): boolean {
  if (value.length > 253) return false
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) return true
  return /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value)
}

/** The columns a create and an update both write. One shape, one place. */
function fields(input: PrinterInput, name: string): unknown[] {
  const queue = input.connection === 'queue'
  return [
    name,
    input.purpose,
    input.paper,
    input.slipColumns,
    input.connection,
    /* Blanked when it cannot apply, rather than kept "just in case". A stale
       address no reader consults is still a fact the screen would show, and
       somebody would one day trust it. */
    queue ? (input.deviceId?.trim() || null) : null,
    input.target.trim().slice(0, 190),
    queue ? input.shareName.trim().slice(0, 190) : '',
    queue ? null : input.port,
    input.drawerKick ? 1 : 0,
  ]
}

export async function createPrinter(
  siteId: number,
  input: PrinterInput,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const checked = checkInput(input)
  if (!checked.ok) return checked

  /* Reactivate rather than refuse when the name is taken by a switched-off
     printer. "Grill" coming back after a refit is the same Grill, and its
     history and its product routing should reconnect rather than become
     "Grill 2". Carried over from 229's createKitchenPrinter. */
  const existing = await siteQuery<Row>(
    siteId,
    `SELECT id, is_active FROM printers WHERE name = ? LIMIT 1`,
    [checked.name],
  )
  if (existing.length > 0) {
    const row = existing[0]
    if (Number(row.is_active) === 1) {
      return { ok: false, error: `There is already a printer called “${checked.name}”.` }
    }
    const id = Number(row.id)
    await writeFields(siteId, id, input, checked.name)
    await siteExecute(siteId, `UPDATE printers SET is_active = 1 WHERE id = ?`, [id])
    return { ok: true, id }
  }

  const result = await siteExecute(
    siteId,
    `INSERT INTO printers
       (name, purpose, paper, slip_columns, connection, device_id, target, share_name, port, drawer_kick, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT COALESCE(MAX(s.sort_order), 0) + 10 FROM (SELECT sort_order FROM printers) s))`,
    fields(input, checked.name),
  )
  return { ok: true, id: result.insertId }
}

async function writeFields(
  siteId: number,
  id: number,
  input: PrinterInput,
  name: string,
): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE printers
        SET name = ?, purpose = ?, paper = ?, slip_columns = ?, connection = ?,
            device_id = ?, target = ?, share_name = ?, port = ?, drawer_kick = ?
      WHERE id = ?`,
    [...fields(input, name), id],
  )
}

export async function updatePrinter(
  siteId: number,
  id: number,
  input: PrinterInput,
): Promise<PrinterResult> {
  const checked = checkInput(input)
  if (!checked.ok) return checked

  const clash = await siteQuery<Row>(
    siteId,
    `SELECT id FROM printers WHERE name = ? AND id <> ? LIMIT 1`,
    [checked.name, id],
  )
  if (clash.length > 0) return { ok: false, error: `There is already a printer called “${checked.name}”.` }

  await writeFields(siteId, id, input, checked.name)
  return { ok: true }
}

/**
 * Turns a printer off. Never deletes.
 *
 * `kitchen_sends` holds the FK with ON DELETE RESTRICT, so deleting a printer
 * that has ever cooked anything is refused by the database itself. Deactivating
 * is what the screen offers instead: the product routing and every machine's
 * assignment stay put, so switching it back on restores the shop's setup rather
 * than asking somebody to re-tick four hundred products and sixteen documents.
 */
export async function setPrinterActive(siteId: number, id: number, active: boolean): Promise<void> {
  await siteExecute(siteId, `UPDATE printers SET is_active = ? WHERE id = ?`, [active ? 1 : 0, id])
}

/** How wide this printer's paper is. The override, else the paper's default. */
export function columnsFor(printer: Printer): number | null {
  return printer.slipColumns ?? PAPER_COLUMNS[printer.paper] ?? null
}

/** One printer as a machine needs it, ready to open. */
export function configuredPrinter(printer: Printer): ConfiguredPrinter {
  return {
    id: printer.id,
    name: printer.name,
    paper: printer.paper,
    columns: columnsFor(printer),
    connection: printer.connection,
    target: printer.target,
    shareName: printer.shareName,
    port: printer.port,
    drawerKick: printer.drawerKick,
  }
}
