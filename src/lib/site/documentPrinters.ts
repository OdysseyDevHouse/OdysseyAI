import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteExecute } from '../siteDb'
import {
  PRINT_DOCS,
  getPrintDoc,
  isPrintDoc,
  mediumFitsPaper,
  type PrinterPaper,
} from '../printing/documents'
import type { DevicePrintConfig, PrintMode } from '../printing/resolve'
import {
  configuredPrinter,
  listPrinters,
  reachableFrom,
  unreachableBecause,
  type Printer,
} from './printers'

/**
 * What each machine prints where.
 *
 * ── EVERY DOCUMENT APPEARS, ANSWERED OR NOT ───────────────────────────────
 *
 * The left side of this join is PRINT_DOCS — a code-owned array — so it is a
 * fold rather than a SQL LEFT JOIN. The guarantee is the one that matters: a
 * document with no answer still shows up, because an unanswered document is
 * exactly the state where paper silently does not come out, and a list of only
 * what already works could never reveal it.
 *
 * ── NO ROW IS A REAL STATE ────────────────────────────────────────────────
 *
 * It means "not set", it resolves to the browser's print dialog, and the screen
 * badges it amber. An implicit "use the only slip printer" default was rejected
 * for the reason 229's screen already states about unmapped tills: a gap that
 * silently works is a gap nobody fixes until the day it stops.
 *
 * `defaultsTo` in the catalogue is a different thing and is deliberate rather
 * than implicit — a gift slip follows the till slip because somebody wrote that
 * down once, and the answer carries `inheritedFrom` so a screen can say where
 * it came from. A destination whose origin cannot be named is the thing this
 * avoids.
 */

/* Defined in lib/printing/resolve.ts, which the till can import; re-exported so
   server code has one obvious place to reach for it. */
export type { PrintMode, DevicePrintConfig }

const MODES: readonly PrintMode[] = ['printer', 'pdf', 'browser', 'off']

export type DocumentAssignment = {
  docKey: string
  mode: PrintMode
  printerId: number | null
  printerName: string | null
  copies: number
  /** No row of its own and nothing inherited. Resolves to the browser dialog. */
  unset: boolean
  /** Points at a printer this machine cannot reach. The one that loses paper. */
  unreachable: boolean
  /** Why not, in a sentence. Null when it is reachable. */
  unreachableBecause: string | null
  /** The doc_key this answer was borrowed from, when it was borrowed. */
  inheritedFrom: string | null
}

export type DocumentResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

type StoredRow = { mode: PrintMode; printerId: number | null; copies: number }

async function storedRows(siteId: number, deviceId: string): Promise<Map<string, StoredRow>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT doc_key, mode, printer_id, copies
       FROM device_document_printers
      WHERE device_id = ?`,
    [deviceId],
  ).catch(() => [] as Row[])

  const map = new Map<string, StoredRow>()
  for (const r of rows) {
    map.set(String(r.doc_key), {
      mode: String(r.mode ?? 'printer') as PrintMode,
      printerId: r.printer_id == null ? null : Number(r.printer_id),
      copies: Number(r.copies ?? 1),
    })
  }
  return map
}

/**
 * Every printable document with this machine's answer for it.
 *
 * Documents whose module the shop does not hold are still returned. Filtering
 * them out is the screen's job, and doing it here would silently drop a row
 * that already exists in the database — a shop that lets a module lapse should
 * keep its job-card setup for when it comes back, not have it vanish.
 */
export async function assignmentsForDevice(
  siteId: number,
  deviceId: string,
  printers?: readonly Printer[],
): Promise<DocumentAssignment[]> {
  const [stored, all] = await Promise.all([
    storedRows(siteId, deviceId),
    printers ? Promise.resolve(printers) : listPrinters(siteId),
  ])
  const byPrinter = new Map(all.map((p) => [p.id, p]))

  return PRINT_DOCS.map((doc) => {
    let row = stored.get(doc.key)
    let inheritedFrom: string | null = null

    /* One hop only. `defaultsTo` chains are refused by the catalogue test, so a
       single lookup is the whole rule — and a loop here would be a way for a
       future cycle to hang a page render rather than fail a test. */
    if (!row && doc.defaultsTo) {
      const borrowed = stored.get(doc.defaultsTo)
      if (borrowed) {
        row = borrowed
        inheritedFrom = doc.defaultsTo
      }
    }

    if (!row) {
      return {
        docKey: doc.key,
        mode: 'browser' as PrintMode,
        printerId: null,
        printerName: null,
        copies: 1,
        unset: true,
        unreachable: false,
        unreachableBecause: null,
        inheritedFrom: null,
      }
    }

    const printer = row.printerId == null ? undefined : byPrinter.get(row.printerId)
    const unreachable =
      row.mode === 'printer' && (!printer || !reachableFrom(printer, deviceId))
    return {
      docKey: doc.key,
      mode: row.mode,
      printerId: row.printerId,
      /* Null when the printer was switched off or deleted since. The screen says
         so in words rather than showing a blank, because a missing name is the
         same visual as an unset row and means something entirely different. */
      printerName: printer?.name ?? null,
      copies: row.copies,
      unset: false,
      unreachable,
      /* WHY it cannot be reached, so the row is actionable. "Plugged into
         TILL08, not this machine" is a sentence somebody fixes; "not reachable"
         is one they escalate. */
      unreachableBecause: printer ? unreachableBecause(printer, deviceId) : 'That printer is no longer set up here.',
      inheritedFrom,
    }
  })
}

/**
 * Points one document on one machine at a destination.
 *
 * This is where the catalogue does its work as a boundary: a `doc_key` it does
 * not know is refused, so an unknown string can never reach the column however
 * the request was composed.
 *
 * The paper check is the other half, and it is the one that saves a support
 * call. Pointing the A4-only cash-up declaration at an 80mm head is accepted by
 * every layer below this one, produces nothing, and gives nobody a reason why.
 */
export async function setDocumentPrinter(
  siteId: number,
  deviceId: string,
  docKey: string,
  input: { mode: PrintMode; printerId?: number | null; copies?: number },
): Promise<DocumentResult> {
  const doc = getPrintDoc(docKey)
  if (!doc) return { ok: false, error: 'That is not a document this app prints.' }
  if (!MODES.includes(input.mode)) return { ok: false, error: 'That is not a way to print something.' }

  const copies = input.copies ?? 1
  if (!Number.isInteger(copies) || copies < 1 || copies > 10) {
    return { ok: false, error: 'Copies must be between 1 and 10.' }
  }

  let printerId: number | null = null
  if (input.mode === 'printer') {
    printerId = input.printerId ?? null
    if (!printerId) return { ok: false, error: 'Pick a printer.' }

    const rows = await siteQuery<Row>(
      siteId,
      `SELECT id, name, paper, is_active FROM printers WHERE id = ? LIMIT 1`,
      [printerId],
    )
    if (rows.length === 0) return { ok: false, error: 'That printer is not set up here.' }
    const printer = rows[0]
    if (Number(printer.is_active) !== 1) {
      return { ok: false, error: `“${String(printer.name)}” is switched off.` }
    }
    const paper = String(printer.paper ?? 'slip80') as PrinterPaper
    if (!mediumFitsPaper(doc.medium, paper)) {
      return {
        ok: false,
        error: `“${String(printer.name)}” cannot print ${doc.label.toLowerCase()} — the paper is the wrong size.`,
      }
    }
  }

  await siteExecute(
    siteId,
    `INSERT INTO device_document_printers (device_id, doc_key, mode, printer_id, copies)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       mode       = VALUES(mode),
       printer_id = VALUES(printer_id),
       copies     = VALUES(copies)`,
    [deviceId, docKey, input.mode, printerId, copies],
  )
  return { ok: true }
}

/**
 * Puts a document back to "not set".
 *
 * Deleting rather than storing `mode: 'browser'` — the two look the same on
 * paper and are different facts. "Not set" is a shop that has not decided yet
 * and should be prompted; "use the browser dialog" is a shop that decided, and
 * should be left alone. The screen badges them differently for that reason.
 */
export async function clearDocumentPrinter(
  siteId: number,
  deviceId: string,
  docKey: string,
): Promise<void> {
  if (!isPrintDoc(docKey)) return
  await siteExecute(
    siteId,
    `DELETE FROM device_document_printers WHERE device_id = ? AND doc_key = ?`,
    [deviceId, docKey],
  )
}

/* ── What a machine needs in order to print ───────────────────────────────── */

/**
 * Everything one machine needs to decide where a document goes, flattened.
 *
 * Deliberately RESOLVED rather than raw: the site answer and the machine's
 * override are reconciled here, once, on the server. A till holding both halves
 * would be a second implementation of `resolve()` in a place that has to keep
 * working with the server unreachable — and two implementations of a resolution
 * rule is how a slip starts coming out of the wrong printer after a config
 * change that only one of them understood.
 *
 * This rides the POS catalog feed so an offline till has it. It is small — a
 * handful of printers and sixteen documents — and it is sent WHOLE every time,
 * never as a delta: re-pointing a printer touches nothing on products, so a
 * products-keyed delta would leave a till printing to the old queue until
 * something unrelated happened to touch a product.
 */
export async function printConfigForDevice(
  siteId: number,
  deviceId: string,
): Promise<DevicePrintConfig> {
  const printers = await listPrinters(siteId)
  const [assignments, dirRows] = await Promise.all([
    assignmentsForDevice(siteId, deviceId, printers),
    siteQuery<Row>(siteId, `SELECT pdf_dir FROM devices WHERE device_id = ? LIMIT 1`, [
      deviceId,
    ]).catch(() => [] as Row[]),
  ])

  return {
    deviceId,
    pdfDir: dirRows.length > 0 ? String(dirRows[0].pdf_dir ?? '') : '',
    /* Only what this machine can actually open. A destination it has no way to
       reach is not a destination, and leaving it in the list invites a caller to
       try — the till's job is to print or to say plainly that it cannot. */
    printers: printers.filter((p) => reachableFrom(p, deviceId)).map(configuredPrinter),
    assignments: assignments
      .filter((a) => !a.unset)
      .map((a) => ({
        docKey: a.docKey,
        mode: a.mode,
        printerId: a.printerId,
        copies: a.copies,
      })),
  }
}
