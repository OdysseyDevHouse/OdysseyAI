import 'server-only'
import { createHash } from 'node:crypto'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { autoMatch } from './cashbook'

/**
 * Reading a bank statement into the cashbook.
 *
 * ── WHY THIS IS HARDER THAN IT LOOKS ─────────────────────────────────────
 *
 * There is no standard. FNB, Absa, Standard Bank, Nedbank and Capitec each
 * export a different CSV: different column names, different date formats,
 * some with one signed Amount column and some with separate Debit and Credit
 * columns, several with preamble lines before the header. A parser that assumes
 * one shape works for exactly one bank.
 *
 * So the CSV reader SNIFFS: it finds the header row wherever it is, maps
 * columns by recognising their names, and detects the date format from the data
 * rather than being told. Everything it cannot work out is reported as a
 * problem on that row instead of being guessed at, because a silently misread
 * statement is worse than one that refuses to import.
 *
 * ── IDEMPOTENCE ──────────────────────────────────────────────────────────
 *
 * Statements overlap. Someone downloads 1–31 March, then 15 March–15 April, and
 * the middle fortnight arrives twice. Every row therefore carries an
 * `import_key` — the bank's own id where the format has one (OFX FITID),
 * otherwise a hash of the fields that identify the line — and a UNIQUE index
 * makes the second import of a row a no-op rather than a duplicate.
 */

export type ParsedRow = {
  /** yyyy-mm-dd. */
  date: string
  /** Signed: positive into the account. */
  amount: number
  description: string | null
  reference: string | null
  /** The bank's own unique id, where the format provides one. */
  fitId?: string | null
  /** 1-based, for reporting problems against the source file. */
  lineNumber: number
}

export type ParseProblem = { lineNumber: number; line: string; reason: string }

export type ParseResult = {
  rows: ParsedRow[]
  problems: ParseProblem[]
  /** What the sniffer decided, shown before importing so a wrong guess is visible. */
  detected: {
    format: 'csv' | 'ofx'
    dateFormat: string | null
    columns: Record<string, string | null>
  }
  periodFrom: string | null
  periodTo: string | null
}

/* ── CSV ─────────────────────────────────────────────────────────────────── */

/** Column aliases, lower-cased and stripped, in the order they are tried. */
const COLUMN_ALIASES: Record<string, string[]> = {
  date: ['date', 'transactiondate', 'txndate', 'postingdate', 'effectivedate', 'valuedate', 'datum'],
  amount: ['amount', 'transactionamount', 'value', 'bedrag'],
  debit: ['debit', 'debitamount', 'withdrawal', 'withdrawals', 'moneyout', 'paidout'],
  credit: ['credit', 'creditamount', 'deposit', 'deposits', 'moneyin', 'paidin'],
  balance: ['balance', 'runningbalance', 'closingbalance', 'saldo'],
  description: ['description', 'details', 'narrative', 'transactiondescription', 'particulars', 'memo', 'beskrywing'],
  reference: ['reference', 'ref', 'yourreference', 'theirreference', 'paymentreference', 'chequenumber'],
}

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Splits one CSV line, honouring quotes.
 *
 * Bank descriptions contain commas constantly ('PAYMENT TO SMITH, T'), so a
 * naive split on ',' shifts every later column on those rows — which shows up
 * as a date in the amount field, or worse, an amount that parses but is wrong.
 */
export function splitCsvLine(line: string, delimiter = ','): string[] {
  const out: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '"') {
      // A doubled quote inside a quoted field is one literal quote.
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (char === delimiter && !inQuotes) {
      out.push(current.trim())
      current = ''
    } else {
      current += char
    }
  }
  out.push(current.trim())
  return out
}

/** Semicolon and tab exports exist. Picks whichever appears most in the header. */
function sniffDelimiter(line: string): string {
  const counts = [
    { d: ',', n: (line.match(/,/g) ?? []).length },
    { d: ';', n: (line.match(/;/g) ?? []).length },
    { d: '\t', n: (line.match(/\t/g) ?? []).length },
  ]
  return counts.sort((a, b) => b.n - a.n)[0].n > 0 ? counts.sort((a, b) => b.n - a.n)[0].d : ','
}

/**
 * Parses a date without guessing between ambiguous formats.
 *
 * 03/04/2026 is 3 April in South Africa and 4 March in the United States, and
 * no amount of cleverness resolves that from one row. So the format is decided
 * once for the whole file by looking for a day > 12 somewhere in it — the only
 * unambiguous evidence available — and defaulting to day-first, which is what
 * every South African bank exports.
 */
export function detectDateFormat(samples: readonly string[]): string | null {
  let sawIso = false
  let dayFirstProof = false
  let monthFirstProof = false

  for (const raw of samples) {
    const value = raw.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      sawIso = true
      continue
    }
    const parts = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
    if (!parts) continue
    const first = Number(parts[1])
    const second = Number(parts[2])
    if (first > 12) dayFirstProof = true
    if (second > 12) monthFirstProof = true
  }

  if (sawIso && !dayFirstProof && !monthFirstProof) return 'yyyy-mm-dd'
  if (monthFirstProof && !dayFirstProof) return 'mm/dd/yyyy'
  return 'dd/mm/yyyy'
}

export function parseDate(value: string, format: string | null): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`

  // '15 Mar 2026' and '15-Mar-26' both appear in the wild.
  const named = trimmed.match(/^(\d{1,2})[\s/.-]([A-Za-z]{3,})[\s/.-](\d{2,4})/)
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()]
    if (month) return `${expandYear(named[3])}-${month}-${pad(named[1])}`
  }

  const numeric = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/)
  if (numeric) {
    const [, a, b, y] = numeric
    const day = format === 'mm/dd/yyyy' ? b : a
    const month = format === 'mm/dd/yyyy' ? a : b
    if (Number(month) < 1 || Number(month) > 12) return null
    if (Number(day) < 1 || Number(day) > 31) return null
    return `${expandYear(y)}-${pad(month)}-${pad(day)}`
  }

  return null
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

function pad(value: string | number): string {
  return String(value).padStart(2, '0')
}

/** Two-digit years: 70-99 are 1900s, everything else 2000s. */
function expandYear(value: string): string {
  if (value.length === 4) return value
  const n = Number(value)
  return n >= 70 ? `19${pad(n)}` : `20${pad(n)}`
}

/**
 * Parses an amount the way banks write them.
 *
 * Handles thousands separators, a trailing minus ('1234.56-' from older
 * systems), parenthesised negatives, and currency symbols. Comma-as-decimal is
 * deliberately NOT guessed at globally: '1,234' is a thousand-something in one
 * locale and 1.234 in another. It is treated as a decimal separator only when
 * the string has no dot AND exactly two digits follow the last comma, which is
 * the one case that cannot mean thousands.
 */
export function parseAmount(value: string): number | null {
  let text = value.trim().replace(/[R$€£\s]/g, '')
  if (!text) return null

  let negative = false
  if (/^\(.*\)$/.test(text)) {
    negative = true
    text = text.slice(1, -1)
  }
  if (text.endsWith('-')) {
    negative = true
    text = text.slice(0, -1)
  }
  if (text.startsWith('-')) {
    negative = true
    text = text.slice(1)
  }
  if (text.startsWith('+')) text = text.slice(1)

  // Comma is the decimal separator when two digits follow the LAST comma and
  // that comma sits after any dot — '1.234.567,89' and '1234,56'. Otherwise
  // commas are thousands separators and the dot is decimal. Deciding by
  // position rather than by presence is what tells the two apart.
  const lastComma = text.lastIndexOf(',')
  const lastDot = text.lastIndexOf('.')
  if (lastComma > lastDot && /,\d{2}$/.test(text)) {
    text = text.replace(/\./g, '').replace(',', '.')
  } else {
    text = text.replace(/,/g, '')
  }

  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null

  const amount = Number(text)
  if (!Number.isFinite(amount)) return null
  return negative ? -amount : amount
}

/**
 * Reads a bank CSV export.
 *
 * The header is located by scanning for the first line that maps to both a date
 * and some kind of amount column, so preamble lines ('Statement for account
 * 62xxxxx', blank rows) are skipped without needing to be described.
 */
export function parseBankCsv(text: string): ParseResult {
  const lines = text.split(/\r?\n/)
  const problems: ParseProblem[] = []

  let headerIndex = -1
  let columns: Record<string, number> = {}
  let delimiter = ','

  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (!lines[i].trim()) continue
    const candidateDelimiter = sniffDelimiter(lines[i])
    const cells = splitCsvLine(lines[i], candidateDelimiter).map(normaliseHeader)
    const mapped = mapColumns(cells)
    if (mapped.date !== undefined && (mapped.amount !== undefined ||
        mapped.debit !== undefined || mapped.credit !== undefined)) {
      headerIndex = i
      columns = mapped
      delimiter = candidateDelimiter
      break
    }
  }

  if (headerIndex === -1) {
    return {
      rows: [],
      problems: [
        {
          lineNumber: 1,
          line: lines[0] ?? '',
          reason:
            'Could not find a header row with a date and an amount. Check this is a statement export rather than a summary.',
        },
      ],
      detected: { format: 'csv', dateFormat: null, columns: {} },
      periodFrom: null,
      periodTo: null,
    }
  }

  const body = lines.slice(headerIndex + 1).map((line, index) => ({
    line,
    lineNumber: headerIndex + 2 + index,
  }))

  const dateSamples = body
    .filter((b) => b.line.trim())
    .map((b) => splitCsvLine(b.line, delimiter)[columns.date] ?? '')
  const dateFormat = detectDateFormat(dateSamples)

  const rows: ParsedRow[] = []

  for (const { line, lineNumber } of body) {
    if (!line.trim()) continue
    const cells = splitCsvLine(line, delimiter)

    // Trailing summary lines ('Closing balance,,,,9999.00') carry an amount in
    // a real column but no date, so they must be recognised and dropped rather
    // than imported as a transaction dated nowhere. A row whose date cell holds
    // words rather than anything date-shaped is a label, not a failed parse —
    // reporting it as a problem would cry wolf on nearly every bank file.
    const rawDate = cells[columns.date] ?? ''
    const date = parseDate(rawDate, dateFormat)
    if (!date) {
      const looksLikeADate = /\d/.test(rawDate)
      if (rawDate.trim() && looksLikeADate) {
        problems.push({ lineNumber, line, reason: `Could not read "${rawDate}" as a date.` })
      }
      continue
    }

    const amount = readAmount(cells, columns)
    if (amount === null) {
      problems.push({ lineNumber, line, reason: 'Could not read an amount on this row.' })
      continue
    }
    if (round(amount, 2) === 0) continue

    rows.push({
      date,
      amount: round(amount, 2),
      description: pick(cells, columns.description),
      reference: pick(cells, columns.reference),
      lineNumber,
    })
  }

  const dates = rows.map((r) => r.date).sort()

  return {
    rows,
    problems,
    detected: {
      format: 'csv',
      dateFormat,
      columns: Object.fromEntries(
        Object.entries(columns).map(([key, index]) => [
          key,
          index === undefined ? null : (splitCsvLine(lines[headerIndex], delimiter)[index] ?? null),
        ]),
      ),
    },
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
  }
}

function mapColumns(cells: string[]): Record<string, number> {
  const mapped: Record<string, number> = {}
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = cells.findIndex((cell) => aliases.includes(cell))
    if (index >= 0) mapped[key] = index
  }
  return mapped
}

/**
 * The amount, from whichever shape this bank uses.
 *
 * A single signed Amount column is preferred when present. Otherwise Debit and
 * Credit are combined — and debit is forced NEGATIVE regardless of how it was
 * written, because some banks put a minus in the debit column and others do
 * not, and taking them at face value flips half the statement.
 */
function readAmount(cells: string[], columns: Record<string, number>): number | null {
  if (columns.amount !== undefined) {
    const amount = parseAmount(cells[columns.amount] ?? '')
    if (amount !== null) return amount
  }

  const debit = columns.debit !== undefined ? parseAmount(cells[columns.debit] ?? '') : null
  const credit = columns.credit !== undefined ? parseAmount(cells[columns.credit] ?? '') : null

  if (debit !== null && debit !== 0) return -Math.abs(debit)
  if (credit !== null && credit !== 0) return Math.abs(credit)
  return null
}

function pick(cells: string[], index: number | undefined): string | null {
  if (index === undefined) return null
  const value = cells[index]?.trim()
  return value ? value : null
}

/* ── OFX ─────────────────────────────────────────────────────────────────── */

/**
 * Reads an OFX/QFX file.
 *
 * OFX is SGML rather than XML — tags are frequently unclosed — so this reads it
 * with targeted regexes over each <STMTTRN> block rather than a parser that
 * would reject the input. Crude, but it matches how the format is actually
 * emitted, and the fields needed are few and well-known.
 *
 * The great advantage of OFX is FITID: the bank's own unique id for the line,
 * which makes duplicate detection exact rather than heuristic.
 */
export function parseBankOfx(text: string): ParseResult {
  const problems: ParseProblem[] = []
  const rows: ParsedRow[] = []

  const blocks = text.match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) ?? []

  blocks.forEach((block, index) => {
    const tag = (name: string): string | null => {
      const match = block.match(new RegExp(`<${name}>([^<\r\n]*)`, 'i'))
      return match ? match[1].trim() : null
    }

    const rawDate = tag('DTPOSTED')
    // OFX dates are YYYYMMDD, optionally followed by a time and timezone.
    const date = rawDate?.match(/^(\d{4})(\d{2})(\d{2})/)
    const amount = rawDate ? parseAmount(tag('TRNAMT') ?? '') : null

    if (!date || amount === null) {
      problems.push({
        lineNumber: index + 1,
        line: block.slice(0, 120),
        reason: 'That transaction block has no readable date or amount.',
      })
      return
    }
    if (round(amount, 2) === 0) return

    rows.push({
      date: `${date[1]}-${date[2]}-${date[3]}`,
      amount: round(amount, 2),
      description: tag('NAME') ?? tag('MEMO'),
      reference: tag('CHECKNUM') ?? tag('REFNUM'),
      fitId: tag('FITID'),
      lineNumber: index + 1,
    })
  })

  const dates = rows.map((r) => r.date).sort()

  return {
    rows,
    problems,
    detected: { format: 'ofx', dateFormat: 'yyyymmdd', columns: {} },
    periodFrom: dates[0] ?? null,
    periodTo: dates[dates.length - 1] ?? null,
  }
}

/** Picks the reader by content rather than by file extension, which lies. */
export function parseStatement(text: string): ParseResult {
  return /<STMTTRN>/i.test(text) || /<OFX>/i.test(text) ? parseBankOfx(text) : parseBankCsv(text)
}

/* ── Importing ───────────────────────────────────────────────────────────── */

/**
 * The stable identity of a statement line.
 *
 * FITID when the bank gave one. Otherwise a hash of date, amount, description
 * and reference — the fields that together identify a line well enough that a
 * genuine second identical transaction is vanishingly rare, and re-importing an
 * overlapping period is safe.
 *
 * The account id is included so two accounts at the same bank cannot collide.
 */
export function importKeyFor(bankAccountId: number, row: ParsedRow): string {
  if (row.fitId) return `fit:${bankAccountId}:${row.fitId}`.slice(0, 120)

  const material = [
    bankAccountId,
    row.date,
    row.amount.toFixed(2),
    (row.description ?? '').toUpperCase().replace(/\s+/g, ' ').trim(),
    (row.reference ?? '').toUpperCase().trim(),
  ].join('|')

  return `h:${createHash('sha1').update(material).digest('hex')}`
}

export type ImportBatch = {
  id: number
  bankAccountId: number
  filename: string | null
  format: 'csv' | 'ofx'
  periodFrom: string | null
  periodTo: string | null
  rowCount: number
  importedCount: number
  duplicateCount: number
  autoMatchedCount: number
  userName: string
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapBatch(r: Row): ImportBatch {
  return {
    id: Number(r.id),
    bankAccountId: Number(r.bank_account_id),
    filename: (r.filename as string | null) ?? null,
    format: String(r.format) as 'csv' | 'ofx',
    periodFrom: r.period_from === null ? null : String(r.period_from),
    periodTo: r.period_to === null ? null : String(r.period_to),
    rowCount: Number(r.row_count),
    importedCount: Number(r.imported_count),
    duplicateCount: Number(r.duplicate_count),
    autoMatchedCount: Number(r.auto_matched_count),
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

export async function listImportBatches(
  siteId: number,
  bankAccountId: number,
  limit = 20,
): Promise<ImportBatch[]> {
  const capped = Math.min(Math.max(limit, 1), 100)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM bank_import_batches WHERE bank_account_id = ?
      ORDER BY created_at DESC LIMIT ${capped}`,
    [bankAccountId],
  )
  return rows.map(mapBatch)
}

export type ImportResult =
  | {
      ok: true
      batchId: number
      imported: number
      duplicates: number
      autoMatched: number
      problems: ParseProblem[]
    }
  | { ok: false; error: string }

/**
 * Imports parsed rows into an account.
 *
 * Every row is inserted with INSERT IGNORE against the unique import key, so a
 * re-imported overlap silently does nothing rather than duplicating. The
 * balance is moved ONCE, by the sum of what was actually inserted — which is
 * why the inserted ids are collected rather than counted.
 *
 * Auto-matching runs afterwards, outside the insert transaction, for the reason
 * postTransaction() defers its own auto-allocation: a matching failure must
 * never roll back an import that otherwise succeeded.
 */
export async function importStatement(
  siteId: number,
  actor: Actor,
  input: {
    bankAccountId: number
    parsed: ParseResult
    filename?: string | null
    /** Link what is unambiguous straight after importing. */
    autoMatch?: boolean
  },
): Promise<ImportResult> {
  const { parsed } = input
  if (parsed.rows.length === 0) {
    return { ok: false, error: 'There are no transactions in that file to import.' }
  }
  if (parsed.rows.length > 5000) {
    return { ok: false, error: 'That file has more than 5000 transactions. Split it by month.' }
  }

  const account = await siteQueryOne<Row>(
    siteId,
    "SELECT id, code, status FROM bank_accounts WHERE id = ? LIMIT 1",
    [input.bankAccountId],
  )
  if (!account) return { ok: false, error: 'That account no longer exists.' }
  if (String(account.status) === 'closed') return { ok: false, error: 'That account is closed.' }

  const outcome = await siteTransaction(siteId, async (tx) => {
    const [batchRes] = await tx.execute(
      `INSERT INTO bank_import_batches
         (bank_account_id, filename, format, period_from, period_to, row_count, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?)`,
      [
        input.bankAccountId,
        input.filename?.slice(0, 255) ?? null,
        parsed.detected.format,
        parsed.periodFrom,
        parsed.periodTo,
        parsed.rows.length,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )
    const batchId = (batchRes as { insertId: number }).insertId

    let imported = 0
    let movedTotal = 0

    for (const row of parsed.rows) {
      const [res] = await tx.execute(
        `INSERT IGNORE INTO bank_transactions
           (bank_account_id, txn_date, amount_signed, description, reference,
            source, import_key, import_batch_id, user_id, user_name)
         VALUES (?,?,?,?,?, 'import', ?,?,?,?)`,
        [
          input.bankAccountId,
          row.date,
          row.amount.toFixed(4),
          row.description?.slice(0, 255) ?? null,
          row.reference?.slice(0, 120) ?? null,
          importKeyFor(input.bankAccountId, row),
          batchId,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      // affectedRows is 0 when IGNORE suppressed a duplicate key.
      if ((res as { affectedRows: number }).affectedRows > 0) {
        imported++
        movedTotal = round(movedTotal + row.amount, 2)
      }
    }

    if (movedTotal !== 0) {
      await tx.execute('UPDATE bank_accounts SET balance = balance + ? WHERE id = ?', [
        movedTotal.toFixed(4),
        input.bankAccountId,
      ] as never)
    }

    const duplicates = parsed.rows.length - imported

    await tx.execute(
      'UPDATE bank_import_batches SET imported_count = ?, duplicate_count = ? WHERE id = ?',
      [imported, duplicates, batchId] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: input.bankAccountId,
      action: 'import',
      detail: `Imported ${imported} line${imported === 1 ? '' : 's'} from ${input.filename ?? 'a statement'}${duplicates ? `, ${duplicates} already present` : ''}`,
    })

    return { batchId, imported, duplicates }
  })

  let autoMatched = 0
  if (input.autoMatch !== false && outcome.imported > 0) {
    const result = await autoMatch(siteId, actor, input.bankAccountId, {
      from: parsed.periodFrom ?? undefined,
      to: parsed.periodTo ?? undefined,
    })
    autoMatched = result.matched
    if (autoMatched > 0) {
      await siteExecute(
        siteId,
        'UPDATE bank_import_batches SET auto_matched_count = ? WHERE id = ?',
        [autoMatched, outcome.batchId],
      )
    }
  }

  return {
    ok: true,
    batchId: outcome.batchId,
    imported: outcome.imported,
    duplicates: outcome.duplicates,
    autoMatched,
    problems: parsed.problems,
  }
}

/**
 * Undoes an import.
 *
 * The wrong account and a misread date format are both only obvious afterwards,
 * which is what makes this a requirement rather than a nicety. Refuses once any
 * of the batch's rows has been reconciled: those figures are agreed, and
 * removing them would change a reconciliation that was signed off.
 */
export async function undoImport(
  siteId: number,
  actor: Actor,
  batchId: number,
): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const batch = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM bank_import_batches WHERE id = ? LIMIT 1',
    [batchId],
  )
  if (!batch) return { ok: false, error: 'That import no longer exists.' }

  const blocked = await siteQueryOne<Row>(
    siteId,
    "SELECT COUNT(*) AS n FROM bank_transactions WHERE import_batch_id = ? AND status = 'reconciled'",
    [batchId],
  )
  if (Number(blocked?.n ?? 0) > 0) {
    return {
      ok: false,
      error: `${blocked?.n} line${Number(blocked?.n) === 1 ? ' is' : 's are'} part of a completed reconciliation. Reopen it before undoing this import.`,
    }
  }

  const removed = await siteTransaction(siteId, async (tx) => {
    const [sumRows] = await tx.query(
      "SELECT COALESCE(SUM(amount_signed), 0) AS moved, COUNT(*) AS n FROM bank_transactions WHERE import_batch_id = ? AND status <> 'void'",
      [batchId] as never,
    )
    const moved = toNum((sumRows as Row[])[0]?.moved)
    const count = Number((sumRows as Row[])[0]?.n ?? 0)

    // Links cascade from the transaction rows, so matched-then-undone imports
    // clean up after themselves rather than leaving orphaned links.
    await tx.execute('DELETE FROM bank_transactions WHERE import_batch_id = ?', [batchId] as never)

    if (moved !== 0) {
      await tx.execute('UPDATE bank_accounts SET balance = balance - ? WHERE id = ?', [
        moved.toFixed(4),
        Number(batch.bank_account_id),
      ] as never)
    }

    await tx.execute('DELETE FROM bank_import_batches WHERE id = ?', [batchId] as never)

    await logActivityTx(tx, actor, {
      entity: 'bank',
      entityId: Number(batch.bank_account_id),
      action: 'undo_import',
      detail: `Removed ${count} imported line${count === 1 ? '' : 's'} from ${batch.filename ?? 'a statement'}`,
    })

    return count
  })

  return { ok: true, removed }
}
