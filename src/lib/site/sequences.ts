import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'

/**
 * Document numbering.
 *
 * ── THE CRUX ─────────────────────────────────────────────────────────────
 *
 * A naive `SELECT next_number` then `UPDATE` DOUBLE-ISSUES in production — and
 * not rarely. Under MySQL's default REPEATABLE READ a plain SELECT is a
 * consistent non-locking read, so it takes no lock at all: two tills read 41,
 * both write 42, and both print INV000041. It never shows up in single-user
 * testing.
 *
 * The fix used here is an atomic `UPDATE … SET next_number = next_number + 1`
 * followed by a read ON THE SAME CONNECTION. The UPDATE itself takes the
 * exclusive row lock, and there is no unlocked variant of it to accidentally
 * write — unlike `SELECT … FOR UPDATE`, which is one well-meaning refactor away
 * from silently degrading into the broken version.
 *
 * `LAST_INSERT_ID(expr)` would also work and is the classic MySQL trick, but it
 * clobbers the session's insert id — a real hazard inside a finalise
 * transaction that has just INSERTed the document header and needs res.insertId.
 *
 * ── TWO CONSEQUENCES THAT DICTATE THE CODE SHAPE ─────────────────────────
 *
 * 1. The lock is held until COMMIT, which serialises the rest of the finalise
 *    for that document type. So issue the number as the LAST write before
 *    commit — after stock, ledger and tenders. Issuing it first would hold the
 *    sequence lock across every other write and turn a busy shop into a queue.
 *
 * 2. nextDocumentNumber takes the CALLER'S open connection and never opens its
 *    own. A separate transaction would commit the number independently of the
 *    document, which is the only way an unexplainable hole can appear.
 *
 * ── GAPS ─────────────────────────────────────────────────────────────────
 *
 * A rolled-back finalise leaves NO gap: the sequence update rolls back with
 * everything else. A committed document that is later voided keeps its number
 * and its row — that is an EXPLAINABLE gap, which is what the law actually
 * requires. SARS does not demand no number is ever cancelled; it demands you
 * can produce the document for every number.
 */

export type DocSequence = {
  docType: string
  prefix: string
  nextNumber: number
  lastIssuedNumber: number | null
  padding: number
  resetPeriod: 'none' | 'yearly'
  periodKey: string | null
  lastIssuedAt: Date | null
}

type Row = RowDataPacket & Record<string, unknown>

function mapSequence(r: Row): DocSequence {
  return {
    docType: String(r.doc_type),
    prefix: String(r.prefix ?? ''),
    nextNumber: Number(r.next_number),
    lastIssuedNumber: r.last_issued_number === null ? null : Number(r.last_issued_number),
    padding: Number(r.padding),
    resetPeriod: String(r.reset_period) as 'none' | 'yearly',
    periodKey: (r.period_key as string | null) ?? null,
    lastIssuedAt: (r.last_issued_at as Date | null) ?? null,
  }
}

export async function listSequences(siteId: number): Promise<DocSequence[]> {
  const rows = await siteQuery<Row>(siteId, 'SELECT * FROM document_sequences ORDER BY doc_type')
  return rows.map(mapSequence)
}

export async function getSequence(siteId: number, docType: string): Promise<DocSequence | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM document_sequences WHERE doc_type = ? LIMIT 1',
    [docType],
  )
  return row ? mapSequence(row) : null
}

/**
 * Claims the next number for a document type.
 *
 * MUST be called with the connection from the surrounding siteTransaction — see
 * the module comment. Throws rather than returning an error union: this is
 * called deep inside a posting transaction where the only sane response to
 * "the sequence is missing" is to roll the whole thing back.
 */
export async function nextDocumentNumber(
  tx: PoolConnection,
  docType: string,
  now = new Date(),
): Promise<string> {
  const periodKey = String(now.getFullYear())

  // ONE statement. It takes the exclusive lock on the primary-key row; a
  // concurrent finalise blocks HERE until this transaction commits.
  //
  // The CASE is the yearly reset: an issue in a new period restarts at 1 and
  // stamps the period, atomically, so two tills crossing midnight on 1 January
  // cannot both perform "the" reset.
  // NOTE the order of the SET clauses. MySQL evaluates them LEFT TO RIGHT, so a
  // later clause reading `next_number` sees the value an earlier clause already
  // wrote. `last_issued_number` must therefore be assigned FIRST, while
  // next_number still holds the value being consumed — otherwise every document
  // is numbered one ahead of itself, which is exactly the bug the sequential
  // test caught.
  const [result] = await tx.execute(
    `UPDATE document_sequences
        SET last_issued_number = CASE
              WHEN reset_period = 'yearly' AND COALESCE(period_key, '') <> ? THEN 1
              ELSE next_number
            END,
            next_number = CASE
              WHEN reset_period = 'yearly' AND COALESCE(period_key, '') <> ? THEN 2
              ELSE next_number + 1
            END,
            period_key = CASE WHEN reset_period = 'yearly' THEN ? ELSE period_key END,
            last_issued_at = NOW()
      WHERE doc_type = ?`,
    [periodKey, periodKey, periodKey, docType] as never,
  )

  // No row means the doc type has no sequence. Throw rather than creating one
  // on the fly: a sequence appearing from nowhere is exactly how a duplicate
  // number gets issued after someone deletes a row by hand.
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new Error(`No numbering sequence is configured for "${docType}".`)
  }

  // Read back on the SAME connection, inside the same transaction, so this sees
  // its own uncommitted write. The value is ours and nobody else's.
  const [rows] = await tx.execute(
    'SELECT prefix, last_issued_number, padding, period_key FROM document_sequences WHERE doc_type = ?',
    [docType] as never,
  )
  const row = (rows as Row[])[0]
  if (!row) throw new Error(`Numbering sequence for "${docType}" vanished mid-transaction.`)

  return formatNumber(
    String(row.prefix ?? ''),
    Number(row.last_issued_number),
    Number(row.padding),
    row.period_key === null ? null : String(row.period_key),
  )
}

/**
 * INV000041, or INV-2026-000041 when the sequence resets yearly.
 *
 * The year goes in the number when the counter restarts, because otherwise
 * invoice 41 of this year and invoice 41 of last year are the same string —
 * which breaks the unique index and, worse, breaks the customer's reference.
 */
export function formatNumber(
  prefix: string,
  number: number,
  padding: number,
  periodKey: string | null,
): string {
  const digits = String(number).padStart(Math.max(padding, 1), '0')
  if (periodKey) return `${prefix}-${periodKey}-${digits}`
  return `${prefix}${digits}`
}

/** What the next number WOULD be, for the setup screen. Claims nothing. */
export function previewNext(sequence: DocSequence, now = new Date()): string {
  const periodKey = String(now.getFullYear())
  const resets = sequence.resetPeriod === 'yearly' && (sequence.periodKey ?? '') !== periodKey
  return formatNumber(
    sequence.prefix,
    resets ? 1 : sequence.nextNumber,
    sequence.padding,
    sequence.resetPeriod === 'yearly' ? periodKey : null,
  )
}

export type SaveResult = { ok: true } | { ok: false; error: string }

export function validateSequence(input: {
  prefix: string
  nextNumber: number
  padding: number
}): string | null {
  if (input.prefix.length > 12) return 'Prefix must be 12 characters or fewer.'
  // A prefix with a digit in it makes the number ambiguous to read and to
  // parse: is INV2000041 invoice 2000041 or invoice 41 of prefix INV2?
  if (!/^[A-Za-z-]*$/.test(input.prefix)) return 'Prefix may contain only letters and hyphens.'
  if (!Number.isInteger(input.nextNumber) || input.nextNumber < 1) {
    return 'The next number must be 1 or more.'
  }
  if (!Number.isInteger(input.padding) || input.padding < 1 || input.padding > 10) {
    return 'Padding must be between 1 and 10 digits.'
  }
  return null
}

/**
 * Changes a sequence's settings.
 *
 * `nextNumber` may only be moved FORWARD. Moving it back would re-issue numbers
 * that already exist — the unique index would refuse the insert, but only at
 * finalise, which means the sale fails at the till in front of a customer
 * rather than here in setup.
 */
export async function updateSequence(
  siteId: number,
  docType: string,
  input: { prefix: string; nextNumber: number; padding: number; resetPeriod: 'none' | 'yearly' },
): Promise<SaveResult> {
  const invalid = validateSequence(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getSequence(siteId, docType)
  if (!existing) return { ok: false, error: 'That sequence does not exist.' }

  if (input.nextNumber < existing.nextNumber) {
    return {
      ok: false,
      error: `The next number cannot go backwards — it is already at ${existing.nextNumber}. Numbers below that have been issued.`,
    }
  }

  await siteExecute(
    siteId,
    `UPDATE document_sequences
        SET prefix = ?, next_number = ?, padding = ?, reset_period = ?
      WHERE doc_type = ?`,
    [input.prefix.trim(), input.nextNumber, input.padding, input.resetPeriod, docType],
  )
  return { ok: true }
}

export type SequenceCheck = {
  docType: string
  issued: number
  live: number
  voided: number
  /** Numbers the sequence says it issued but no document carries. Must be zero. */
  missing: number
  firstNumber: string | null
  lastNumber: string | null
}

/**
 * Proves no invoice number was skipped or reused.
 *
 * Classifies rather than just counting, because "there is a gap" is not itself
 * a problem — a voided document is a legitimate, explainable gap. Only
 * `missing` matters: a number the sequence issued with no row to show for it.
 * By construction it should always be zero, since the number and the document
 * are written in the same transaction.
 */
/** Which table a document type lives in. Sales and purchasing are separate. */
const PURCHASE_TYPES = new Set(['purchase_order', 'grv', 'supplier_return'])

export async function verifySequence(siteId: number, docType: string): Promise<SequenceCheck> {
  const sequence = await getSequence(siteId, docType)
  const issued = sequence?.lastIssuedNumber ?? 0

  // Purchasing has its own documents table — the two sides of the trade face
  // opposite ways and were deliberately not merged. Checking the wrong one
  // would report every purchase number as missing.
  const table = PURCHASE_TYPES.has(docType) ? 'purchase_documents' : 'sales_documents'

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*)                                              AS total,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END)      AS voided,
            MIN(document_number)                                  AS first_number,
            MAX(document_number)                                  AS last_number
       FROM ${table}
      WHERE doc_type = ? AND document_number IS NOT NULL`,
    [docType],
  )

  const total = Number(row?.total ?? 0)
  const voided = Number(row?.voided ?? 0)

  return {
    docType,
    issued,
    live: total - voided,
    voided,
    missing: Math.max(issued - total, 0),
    firstNumber: (row?.first_number as string | null) ?? null,
    lastNumber: (row?.last_number as string | null) ?? null,
  }
}
