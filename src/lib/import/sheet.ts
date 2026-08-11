import * as XLSX from 'xlsx'
import { splitCsvLine, sniffDelimiter, normaliseHeader } from './text'

/**
 * Turning a file into a header row and body rows.
 *
 * ── EVERY CELL ARRIVES AS A STRING ───────────────────────────────────────
 *
 * Both paths — CSV and XLSX — produce `string[][]`, and every field's `parse`
 * reads strings. That is one code path rather than two, and it heads off
 * Excel's helpfulness: left to type cells itself, SheetJS turns a 13-digit
 * barcode into 1.23457e+12 and a product code of '007' into the number 7.
 * Reading the formatted text is what the user saw in the cell, which is what
 * they meant.
 *
 * ── READING UNTRUSTED SPREADSHEETS ───────────────────────────────────────
 *
 * `xlsx` was already a dependency here, but only ever for WRITING exports.
 * Parsing a file somebody uploaded is a different risk: this version carries
 * known prototype-pollution and ReDoS advisories, and the reported paths run
 * through formula and HTML parsing. So the reader turns off everything it does
 * not need — formulas, HTML, stubs — and takes the cached text of any formula
 * cell instead of evaluating it.
 */

export type Sheet = {
  /** The header row, as written. */
  headers: string[]
  /** Body rows, padded to the header's width so index access is total. */
  rows: string[][]
  /** 1-based line of the header row in the source file, for problem reporting. */
  headerLine: number
  detected: { format: 'csv' | 'xlsx'; delimiter?: string; sheetName?: string }
}

export type SheetResult = { ok: true; sheet: Sheet } | { ok: false; error: string }

/**
 * Refused rather than truncated.
 *
 * A file cut off at the limit imports most of a catalogue and says it
 * succeeded, which is the kind of half-done that costs a data repair. The bank
 * importer draws the same line for the same reason.
 */
export const MAX_ROWS = 50_000

/** How far into a file to look for the header before giving up. */
const HEADER_SCAN_LINES = 30

export function readCsv(text: string, aliases: ReadonlySet<string>): SheetResult {
  // A BOM survives into the first heading and stops it matching any alias.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  const found = findHeaderRow(
    lines.map((line) => (line.trim() ? splitCsvLine(line, sniffDelimiter(line)) : [])),
    aliases,
  )
  if (found === -1) return { ok: false, error: headerMiss(aliases) }

  const delimiter = sniffDelimiter(lines[found])
  const headers = splitCsvLine(lines[found], delimiter)

  const rows: string[][] = []
  for (let i = found + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    if (rows.length >= MAX_ROWS) return { ok: false, error: tooBig() }
    rows.push(pad(splitCsvLine(lines[i], delimiter), headers.length))
  }

  return {
    ok: true,
    sheet: { headers, rows, headerLine: found + 1, detected: { format: 'csv', delimiter } },
  }
}

export function readXlsx(buffer: ArrayBuffer | Buffer, aliases: ReadonlySet<string>): SheetResult {
  let book: XLSX.WorkBook
  try {
    book = XLSX.read(buffer instanceof Buffer ? buffer : Buffer.from(new Uint8Array(buffer)), {
      type: 'buffer',
      // Everything below is off because this file came from outside. Formula
      // and HTML parsing are where the known advisories live, and a formula's
      // cached text is what the user saw in the cell anyway.
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      sheetStubs: false,
      dense: true,
    })
  } catch {
    return { ok: false, error: 'That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.' }
  }

  const sheetName = book.SheetNames[0]
  if (!sheetName) return { ok: false, error: 'That workbook has no sheets in it.' }

  const sheet = book.Sheets[sheetName]
  // raw:false gives the FORMATTED text — see the note on barcodes above.
  const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })

  const cleaned = grid.map((row) => (row ?? []).map((cell) => String(cell ?? '').trim()))
  const found = findHeaderRow(cleaned, aliases)
  if (found === -1) return { ok: false, error: headerMiss(aliases) }

  const headers = cleaned[found]
  const rows: string[][] = []
  for (let i = found + 1; i < cleaned.length; i++) {
    if (cleaned[i].every((c) => !c)) continue
    if (rows.length >= MAX_ROWS) return { ok: false, error: tooBig() }
    rows.push(pad(cleaned[i], headers.length))
  }

  return {
    ok: true,
    sheet: { headers, rows, headerLine: found + 1, detected: { format: 'xlsx', sheetName } },
  }
}

/**
 * Reads whichever kind of file this is, by extension.
 *
 * The browser hands `File`; the caller decides how it reached here. CSV is read
 * as text, XLSX as bytes — which is why the two paths exist at all, and why the
 * bank importer's `file.text()` trick could not simply be reused.
 */
export async function readFile(file: File, aliases: ReadonlySet<string>): Promise<SheetResult> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.ods')) {
    return readXlsx(await file.arrayBuffer(), aliases)
  }
  if (name.endsWith('.csv') || name.endsWith('.txt') || name.endsWith('.tsv')) {
    return readCsv(await file.text(), aliases)
  }
  return {
    ok: false,
    error: `${file.name} is not a spreadsheet. Upload a .csv or .xlsx file.`,
  }
}

/**
 * Finds the header wherever it is.
 *
 * Exports lead with preamble constantly — a title, the store's name, a blank
 * row, then the real headings. So rather than assuming row one, every row in
 * reach is scored by how many of its cells look like a heading this import
 * knows, and the best scoring row wins. A file whose best row recognises
 * nothing has no header worth using, and that is reported rather than guessed
 * around.
 */
function findHeaderRow(grid: readonly string[][], aliases: ReadonlySet<string>): number {
  let best = -1
  let bestScore = 0

  for (let i = 0; i < Math.min(grid.length, HEADER_SCAN_LINES); i++) {
    const row = grid[i]
    if (!row?.length) continue
    const score = row.filter((cell) => cell && aliases.has(normaliseHeader(cell))).length
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }

  return bestScore > 0 ? best : -1
}

/** Every alias across a spec's fields, for the header scan. */
export function aliasSet(fields: readonly { aliases: readonly string[] }[]): Set<string> {
  const out = new Set<string>()
  for (const field of fields) {
    for (const alias of field.aliases) out.add(normaliseHeader(alias))
  }
  return out
}

function pad(row: readonly string[], width: number): string[] {
  const out = row.slice(0, width).map((c) => (c ?? '').trim())
  while (out.length < width) out.push('')
  return out
}

function headerMiss(aliases: ReadonlySet<string>): string {
  return aliases.size > 0
    ? 'No heading row was recognised in the first 30 lines. Check the file has a row of column headings, and download the template to see the names this import knows.'
    : 'No heading row was recognised in that file.'
}

function tooBig(): string {
  return `That file has more than ${MAX_ROWS.toLocaleString('en-ZA')} rows. Split it and import the parts separately.`
}
