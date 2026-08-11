import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { formatNumber, numberValueOf, type NumberSegments } from '../numberFormat'

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

/**
 * The site-wide sequence: the row every document has always numbered from.
 *
 * Zero rather than null because it is half of the primary key, and MySQL cannot
 * have a nullable column in one. Every caller that is not a till sale passes
 * this, which is twelve of the thirteen.
 */
export const SITE_SEQUENCE = 0

export type DocSequence = {
  docType: string
  /** 0 for the site-wide sequence, else the till that owns this one. */
  terminalId: number
  prefix: string
  nextNumber: number
  lastIssuedNumber: number | null
  padding: number
  resetPeriod: 'none' | 'yearly'
  periodKey: string | null
  lastIssuedAt: Date | null
}

/**
 * The store and till segments of a number, when it carries them.
 *
 * Defined in @/lib/numberFormat, beside the formatter that consumes it, so the
 * offline till can use both without importing this server-only module.
 */
export type { NumberSegments } from '../numberFormat'

type Row = RowDataPacket & Record<string, unknown>

function mapSequence(r: Row): DocSequence {
  return {
    docType: String(r.doc_type),
    terminalId: Number(r.terminal_id ?? SITE_SEQUENCE),
    prefix: String(r.prefix ?? ''),
    nextNumber: Number(r.next_number),
    lastIssuedNumber: r.last_issued_number === null ? null : Number(r.last_issued_number),
    padding: Number(r.padding),
    resetPeriod: String(r.reset_period) as 'none' | 'yearly',
    periodKey: (r.period_key as string | null) ?? null,
    lastIssuedAt: (r.last_issued_at as Date | null) ?? null,
  }
}

/**
 * The site-wide sequences — one per document type.
 *
 * Deliberately excludes per-till rows: this feeds the numbering setup screen's
 * main table, where a store with five tills would otherwise see six "Tax
 * invoices" lines with no way to tell them apart.
 */
export async function listSequences(siteId: number): Promise<DocSequence[]> {
  const rows = await siteQuery<Row>(
    siteId,
    'SELECT * FROM document_sequences WHERE terminal_id = ? ORDER BY doc_type',
    [SITE_SEQUENCE],
  )
  return rows.map(mapSequence)
}

/** Every per-till sequence for one document type, lowest till first. */
export async function listTerminalSequences(
  siteId: number,
  docType = 'invoice',
): Promise<DocSequence[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM document_sequences
      WHERE doc_type = ? AND terminal_id <> ?
      ORDER BY terminal_id`,
    [docType, SITE_SEQUENCE],
  )
  return rows.map(mapSequence)
}

export async function getSequence(
  siteId: number,
  docType: string,
  terminalId = SITE_SEQUENCE,
): Promise<DocSequence | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM document_sequences WHERE doc_type = ? AND terminal_id = ? LIMIT 1',
    [docType, terminalId],
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
  /**
   * Which till's sequence to draw from. SITE_SEQUENCE (0) — the default — for
   * every document that is not rung up at a till, which is all but one caller.
   *
   * A till may own its own sequence so it can keep numbering while it cannot
   * reach the database at all. The lock this statement takes is then on that
   * till's row rather than the shared one, which additionally means two tills
   * finalising at the same moment no longer block each other.
   */
  terminalId = SITE_SEQUENCE,
  /**
   * The store and till segments. Omitted for a site-wide number, whose shape is
   * then byte-identical to what it has always been.
   */
  segments?: NumberSegments,
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
      WHERE doc_type = ? AND terminal_id = ?`,
    [periodKey, periodKey, periodKey, docType, terminalId] as never,
  )

  // No row means this doc type has no sequence for this till. Throw rather than
  // creating one on the fly: a sequence appearing from nowhere is exactly how a
  // duplicate number gets issued after someone deletes a row by hand.
  //
  // Naming the till matters more than it looks. Falling back to the site-wide
  // sequence would be the "helpful" thing to do and is the wrong thing: it would
  // drop an unregistered till's sale into the middle of the shared invoice run,
  // silently, and nobody would find out until the numbers were reconciled.
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new Error(
      terminalId === SITE_SEQUENCE
        ? `No numbering sequence is configured for "${docType}".`
        : `No numbering sequence is configured for "${docType}" on till ${terminalId}.`,
    )
  }

  // Read back on the SAME connection, inside the same transaction, so this sees
  // its own uncommitted write. The value is ours and nobody else's.
  const [rows] = await tx.execute(
    `SELECT prefix, last_issued_number, padding, period_key
       FROM document_sequences WHERE doc_type = ? AND terminal_id = ?`,
    [docType, terminalId] as never,
  )
  const row = (rows as Row[])[0]
  if (!row) throw new Error(`Numbering sequence for "${docType}" vanished mid-transaction.`)

  return formatNumber(
    String(row.prefix ?? ''),
    Number(row.last_issued_number),
    Number(row.padding),
    row.period_key === null ? null : String(row.period_key),
    segments,
  )
}

/**
 * Adopts a number a till already printed, and moves its sequence past it.
 *
 * An offline sale was handed to a customer on a slip bearing a specific number, so
 * that number is not ours to choose. This does not allocate — it catches the
 * sequence up.
 *
 * GREATEST is what makes it safe against out-of-order sync: sales arriving 97, 98,
 * 99 and a retry of 97 all leave the sequence at 100, whatever order they land in.
 * The number itself is protected by uq_doc_number, so a genuine duplicate is
 * refused by the database rather than trusted from the client.
 */
export async function adoptDocumentNumber(
  tx: PoolConnection,
  docType: string,
  terminalId: number,
  numberValue: number,
): Promise<void> {
  const [result] = await tx.execute(
    `UPDATE document_sequences
        SET last_issued_number = GREATEST(COALESCE(last_issued_number, 0), ?),
            next_number        = GREATEST(next_number, ? + 1),
            last_issued_at     = NOW()
      WHERE doc_type = ? AND terminal_id = ?`,
    [numberValue, numberValue, docType, terminalId] as never,
  )
  if ((result as { affectedRows: number }).affectedRows === 0) {
    throw new Error(`No numbering sequence is configured for "${docType}" on till ${terminalId}.`)
  }
}

/* formatNumber and numberValueOf moved to @/lib/numberFormat so the OFFLINE till
   can format its own numbers — this module is server-only, and a second
   implementation in the browser is how two number SHAPES end up in one invoice
   register. Re-exported so every existing import keeps working. */
export { formatNumber, numberValueOf } from '../numberFormat'

/** What the next number WOULD be, for the setup screen. Claims nothing. */
export function previewNext(
  sequence: DocSequence,
  now = new Date(),
  segments?: NumberSegments,
): string {
  const periodKey = String(now.getFullYear())
  const resets = sequence.resetPeriod === 'yearly' && (sequence.periodKey ?? '') !== periodKey
  return formatNumber(
    sequence.prefix,
    resets ? 1 : sequence.nextNumber,
    sequence.padding,
    sequence.resetPeriod === 'yearly' ? periodKey : null,
    segments,
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
  terminalId = SITE_SEQUENCE,
): Promise<SaveResult> {
  const invalid = validateSequence(input)
  if (invalid) return { ok: false, error: invalid }

  const existing = await getSequence(siteId, docType, terminalId)
  if (!existing) return { ok: false, error: 'That sequence does not exist.' }

  if (input.nextNumber < existing.nextNumber) {
    return {
      ok: false,
      error: `The next number cannot go backwards — it is already at ${existing.nextNumber}. Numbers below that have been issued.`,
    }
  }

  /* Changing the prefix after numbers have been issued under the old one is
     refused: the two runs then share a counter, so INV000041 and ABC000041 are
     both "invoice 41" and the next reprint of either is ambiguous. Under per-till
     numbering it is worse — the store and till segments are what make a number
     unique across a group, and a prefix change can walk one till's run onto
     another's. */
  if (
    input.prefix.trim() !== existing.prefix &&
    existing.lastIssuedNumber !== null &&
    existing.lastIssuedNumber > 0
  ) {
    return {
      ok: false,
      error: `The prefix cannot change — ${existing.lastIssuedNumber} document(s) have already been issued as "${existing.prefix}". Those numbers are on customers' invoices.`,
    }
  }

  await siteExecute(
    siteId,
    `UPDATE document_sequences
        SET prefix = ?, next_number = ?, padding = ?, reset_period = ?
      WHERE doc_type = ? AND terminal_id = ?`,
    [
      input.prefix.trim(),
      input.nextNumber,
      input.padding,
      input.resetPeriod,
      docType,
      terminalId,
    ],
  )
  return { ok: true }
}

/* ── Master-data codes ──────────────────────────────────────────────────────
 *
 * Customer, supplier and product codes reuse the sequence machinery above but
 * NOT its rules. See sql/site/062_master_data_codes.sql for why: a document
 * number is a legal artefact that must be accounted for, a master-data code is
 * an internal reference where a gap costs nothing.
 *
 * Three consequences follow from that, and each is a deliberate departure from
 * the document path:
 *
 * 1. It opens its own connection. nextDocumentNumber must join the caller's
 *    transaction so the number and the document commit together; here the
 *    opposite is wanted. A customer whose INSERT fails on a duplicate email
 *    should not roll the counter back into a value the next save will collide
 *    with, and holding the sequence lock across a whole product save — which
 *    resolves VAT and writes properties — would serialise every till adding a
 *    customer.
 *
 * 2. A clash is skipped, not fatal. The counter starts at 1 on a store that
 *    already types codes by hand, so CUST00001 may well exist. Refusing to
 *    save would strand the user on a form with an error they cannot act on;
 *    stepping past the taken code is what they would do themselves.
 *
 * 3. It never throws. A missing sequence row means a site migrated before this
 *    existed. Returning null lets the caller fall back to whatever the user
 *    typed, rather than making an unrelated screen fail to save.
 */

/** Which table each master-data code must be unique in. */
const CODE_TABLES: Record<string, string> = {
  customer: 'customers',
  supplier: 'suppliers',
  product: 'products',
}

export type CodeDocType = 'customer' | 'supplier' | 'product'

/**
 * Claims the next free code for a customer, supplier or product.
 *
 * Returns null when the sequence is missing or every candidate in a reasonable
 * window is taken — the caller then keeps whatever code the user supplied.
 *
 * The loop bound is the point of the design: without it, a store that has
 * hand-typed PRD00001..PRD09000 would spin the counter forward one query at a
 * time on every save. Twenty attempts nudges past the odd collision; more than
 * that means the numbering does not fit the data, and asking the user to
 * choose a prefix beats silently hammering the database.
 */
export async function nextMasterCode(
  siteId: number,
  docType: CodeDocType,
): Promise<string | null> {
  const table = CODE_TABLES[docType]
  if (!table) return null

  for (let attempt = 0; attempt < 20; attempt++) {
    const code = await claimCode(siteId, docType)
    if (!code) return null

    const taken = await siteQueryOne<RowDataPacket & { id: number }>(
      siteId,
      `SELECT id FROM ${table} WHERE code = ? LIMIT 1`,
      [code],
    )
    if (!taken) return code
  }
  return null
}

/**
 * One atomic claim.
 *
 * ── WHY THIS NEEDS ITS OWN TRANSACTION ───────────────────────────────────
 *
 * The UPDATE alone is atomic, but the value it wrote is read by a SECOND
 * statement — and `last_issued_number` is a column, not a per-session value
 * like LAST_INSERT_ID. On a pooled connection with no transaction, each
 * statement commits as it runs, so two concurrent claims interleave as:
 *
 *   A: UPDATE (last_issued = 13)
 *   B: UPDATE (last_issued = 14)
 *   A: SELECT -> 14        ← A reads B's write
 *   B: SELECT -> 14        ← and so does B
 *
 * Both then return CUST0014, the uniqueness re-check in nextMasterCode sees
 * nothing taken yet for either, and the second INSERT dies on the unique
 * index. A concurrency test caught exactly this; it is invisible sequentially.
 *
 * Wrapping both statements in one transaction fixes it: the UPDATE takes the
 * exclusive row lock and holds it until COMMIT, so B's UPDATE blocks until A
 * has read its own value back. This is the same discipline as
 * nextDocumentNumber — which gets it for free by joining the caller's
 * transaction — expressed here, where there is no caller transaction to join.
 *
 * A short, dedicated transaction rather than the caller's: see the module note
 * above on why a master-data code must NOT roll back with the row it names.
 */
async function claimCode(siteId: number, docType: string): Promise<string | null> {
  return siteTransaction(siteId, async (tx) => {
    // terminal_id is pinned to the site-wide row rather than left off. A
    // master-data code is never per-till, and an unqualified WHERE on a table
    // whose primary key now has two columns is the kind of statement that starts
    // matching more rows than it meant to the moment someone adds one.
    const [result] = await tx.execute(
      `UPDATE document_sequences
          SET last_issued_number = next_number,
              next_number = next_number + 1,
              last_issued_at = NOW()
        WHERE doc_type = ? AND terminal_id = ?`,
      [docType, SITE_SEQUENCE] as never,
    )
    if ((result as { affectedRows: number }).affectedRows === 0) return null

    const [rows] = await tx.execute(
      `SELECT prefix, last_issued_number, padding
         FROM document_sequences WHERE doc_type = ? AND terminal_id = ?`,
      [docType, SITE_SEQUENCE] as never,
    )
    const row = (rows as Row[])[0]
    if (!row) return null

    // No period key: these codes never carry a year. A customer created in
    // 2026 is not a different customer in 2027, and CUST-2026-00001 would
    // suggest the account itself expires.
    return formatNumber(
      String(row.prefix ?? ''),
      Number(row.last_issued_number),
      Number(row.padding),
      null,
    )
  })
}

/**
 * What the next code WOULD be. Claims nothing, so an abandoned form burns no
 * codes — the real one is taken on save.
 *
 * Because it claims nothing, two people opening New Customer at the same
 * moment both see the same preview and the second one saves under the next
 * code up. That is the right trade: showing a code the user cannot rely on is
 * a smaller problem than punching a hole in the numbering for every form
 * somebody opened and thought better of.
 */
export async function previewMasterCode(
  siteId: number,
  docType: CodeDocType,
): Promise<string | null> {
  const sequence = await getSequence(siteId, docType)
  if (!sequence) return null
  return formatNumber(sequence.prefix, sequence.nextNumber, sequence.padding, null)
}

export type SequenceCheck = {
  docType: string
  /** 0 for the site-wide run, else the till whose own run this is. */
  terminalId: number
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

/**
 * Document types that live in neither sales_documents nor purchase_documents.
 *
 * Without an entry here a type defaults to sales_documents, where its numbers do
 * not exist — so every one it ever issued is reported as MISSING, which is the
 * one figure this function exists to prove is zero. A stock take is the first
 * such type; anything else with its own table needs a line here too.
 *
 * Each table must carry document_number, id and a status whose void value is
 * 'cancelled', which is what the counting query below assumes.
 */
const OWN_TABLE_TYPES: Record<string, string> = {
  stock_take: 'stock_takes',
  stock_transfer: 'stock_transfers',
  stock_adjustment: 'stock_adjustments',
  manufacturing_order: 'manufacturing_orders',
}

export async function verifySequence(
  siteId: number,
  docType: string,
  terminalId = SITE_SEQUENCE,
  /**
   * The literal prefix this till's numbers begin with, e.g. 'INV_01_02_'.
   *
   * Required for a per-till check and meaningless for a site-wide one. Passed in
   * because the store segment lives in `settings`, which this module has no
   * business reading — see numberSegmentsFor() in numbering.ts.
   */
  numberPrefix?: string,
): Promise<SequenceCheck> {
  const sequence = await getSequence(siteId, docType, terminalId)
  const issued = sequence?.lastIssuedNumber ?? 0

  // Purchasing has its own documents table — the two sides of the trade face
  // opposite ways and were deliberately not merged. Checking the wrong one
  // would report every purchase number as missing.
  const table =
    OWN_TABLE_TYPES[docType] ??
    (PURCHASE_TYPES.has(docType) ? 'purchase_documents' : 'sales_documents')

  /*
   * Counting is scoped to the run being checked, and the discriminator is the
   * NUMBER'S SHAPE rather than the document's terminal.
   *
   * That distinction is the whole correctness of this function. Every invoice ever
   * rung up at a till carries a terminal_id — 97,013 of them on the first store
   * this ran against — and every one was numbered from the shared sequence.
   * Splitting on `terminal_id IS NULL` would move the entire trading history out of
   * the site-wide run and report it as ~97,000 missing invoices.
   *
   * INSTR rather than `NOT LIKE '%\_%'`, and this is not a style preference: an
   * underscore is a LIKE wildcard, the escape has to survive being a JavaScript
   * string first, and a single backslash written here reaches SQL as a bare `_` —
   * the pattern degrades to "any non-empty string" and the clause excludes
   * EVERYTHING. Measured: it reported all 97,152 invoices as missing.
   */
  const perTill = table === 'sales_documents' && terminalId !== SITE_SEQUENCE
  if (perTill && !numberPrefix) {
    throw new Error(
      "verifySequence needs the till's number prefix to know which numbers belong to it.",
    )
  }

  /*
   * A type with its OWN table needs no doc_type predicate, and must not be given
   * one: stock_takes has no such column, because the whole table is one type.
   * Filtering on it would not narrow the count, it would fail the query.
   */
  const ownTable = OWN_TABLE_TYPES[docType] !== undefined

  const where =
    (ownTable ? 'document_number IS NOT NULL' : 'doc_type = ? AND document_number IS NOT NULL') +
    (table === 'sales_documents'
      ? perTill
        ? ' AND LEFT(document_number, CHAR_LENGTH(?)) = ?'
        : " AND INSTR(document_number, '_') = 0"
      : '')
  const params: (string | number)[] = ownTable
    ? []
    : perTill
      ? [docType, numberPrefix!, numberPrefix!]
      : [docType]

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*)                                            AS total,
            SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS voided
       FROM ${table}
      WHERE ${where}`,
    params,
  )

  /*
   * FIRST and LAST come from the ends of the run BY ID, not from MIN/MAX on the
   * number. MIN(document_number) is the lowest STRING, which stopped being the
   * earliest invoice the moment numbers gained segments — 'INV_01_02_000097' sorts
   * below 'INV_01_10_000001'. Two one-row queries rather than one over the whole
   * run: this is read by a setup screen on a table with millions of rows.
   */
  const [first, last] = await Promise.all([
    siteQueryOne<Row>(
      siteId,
      `SELECT document_number FROM ${table} WHERE ${where} ORDER BY id LIMIT 1`,
      params,
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT document_number FROM ${table} WHERE ${where} ORDER BY id DESC LIMIT 1`,
      params,
    ),
  ])

  const total = Number(row?.total ?? 0)
  const voided = Number(row?.voided ?? 0)

  return {
    docType,
    terminalId,
    issued,
    live: total - voided,
    voided,
    missing: Math.max(issued - total, 0),
    firstNumber: (first?.document_number as string | null) ?? null,
    lastNumber: (last?.document_number as string | null) ?? null,
  }
}
