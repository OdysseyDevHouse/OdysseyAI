import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { toNum } from '../decimals'

/**
 * The floor: which tables exist, and which of them has a bill open.
 *
 * ── A TABLE HOLDS A SAVED SALE, NOT A BILL OF ITS OWN ─────────────────────
 *
 * `pos_tables.document_id` points at an ordinary `sales_documents` row with
 * `status = 'saved'` — the same mechanism the retail till already uses to park a
 * basket. That is deliberate and it is the single most important decision in this
 * file: a restaurant does not need different arithmetic, it needs a different way of
 * FINDING the basket it left open.
 *
 * So there is no second kind of unfinished sale, no second set of lines, and no
 * second posting path. A table's bill is finalised by `finaliseDocument`, exactly as
 * a counter sale is, and every rule about specials, VAT, rounding and stock applies
 * without being restated.
 *
 * ── OCCUPANCY IS DERIVED, NEVER STORED ────────────────────────────────────
 *
 * There is no `status` column. A table with a document is occupied; one without is
 * free. A status column would be a second source of truth for the same fact, and it
 * would fall out of step the first time a bill was paid or voided from the back
 * office — leaving a table nobody could seat and no way to see why.
 */

type Row = RowDataPacket & Record<string, unknown>

export type PosTable = {
  id: number
  code: string
  name: string
  section: string
  seats: number
  sortOrder: number
  isActive: boolean
  /** The open bill, or null when the table is free. */
  documentId: number | null
  /** When the bill was asked for. Null unless it has been. */
  billAskedAt: Date | null
  /* ── Derived, for the gate ──────────────────────────────────────────── */
  /** 'free' | 'open' | 'bill' — computed, never stored. See the module note. */
  state: TableState
  /** What is on the bill so far. Zero on a free table. */
  totalIncl: number
  /** How many lines, which is what a waiter recognises a table's bill by. */
  lineCount: number
  /** When the basket was opened, so the gate can show how long they have been sat. */
  openedAt: Date | null
}

export type TableState = 'free' | 'open' | 'bill'

function mapTable(r: Row): PosTable {
  const documentId = r.document_id === null ? null : Number(r.document_id)
  const billAskedAt = (r.bill_asked_at as Date | null) ?? null

  /*
   * Whether the JOINED document is still an open bill — not merely whether the pointer
   * is set.
   *
   * These come apart the moment a bill is paid or voided anywhere but the table screen:
   * `document_id` still points at it while the join (which filters `status = 'saved'`)
   * finds nothing. Reading the pointer alone left a settled table stuck reading "bill
   * asked" forever, with a waiter sent to collect money that was already in the drawer.
   *
   * `total_incl` comes from the joined row, so its presence IS the join result — no
   * extra column needed, and it cannot disagree with the totals shown beside it.
   */
  const hasOpenBill = documentId !== null && r.total_incl !== null && r.total_incl !== undefined

  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name ?? ''),
    section: String(r.section ?? ''),
    seats: Number(r.seats ?? 0),
    sortOrder: Number(r.sort_order ?? 0),
    isActive: !!r.is_active,
    /*
     * The OPEN bill, or null — not the raw pointer.
     *
     * A settled table still carries its pointer until something clears it, and every
     * caller here means "is there a bill to act on": `deactivateTable` would otherwise
     * refuse to retire a table whose bill was paid last week, and the gate would offer
     * to resume a basket that is already an invoice.
     *
     * `freeTableForDocument` is the one thing that needs the raw value, and it works by
     * matching on the column directly rather than reading this.
     */
    documentId: hasOpenBill ? documentId : null,
    /* Cleared alongside it, for the same reason: "asked for the bill" is meaningless
       once there is no bill. */
    billAskedAt: hasOpenBill ? billAskedAt : null,
    /* Three states, from the JOIN rather than the pointer — see hasOpenBill above.
       'bill' outranks 'open' because a table waiting to pay needs a waiter NOW and one
       still eating does not; on a busy floor that difference is the whole reason to
       look at the screen. */
    state: !hasOpenBill ? 'free' : billAskedAt ? 'bill' : 'open',
    totalIncl: toNum(r.total_incl),
    lineCount: Number(r.line_count ?? 0),
    openedAt: (r.opened_at as Date | null) ?? null,
  }
}

/**
 * Every table, with what is on it.
 *
 * One query with the totals joined, rather than a list plus a lookup per table. A
 * forty-table floor would otherwise be forty-one round trips on a screen a waiter
 * reopens between every course.
 */
export async function listTables(siteId: number): Promise<PosTable[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.code, t.name, t.section, t.seats, t.sort_order, t.is_active,
            t.document_id, t.bill_asked_at,
            d.total_incl,
            d.created_at AS opened_at,
            (SELECT COUNT(*) FROM sales_document_lines l WHERE l.document_id = d.id) AS line_count
       FROM pos_tables t
       /* LEFT JOIN and a status filter TOGETHER: a document that has since been
          finalised or cancelled is no longer an open bill, and joining it in would
          show a table as occupied by a sale that is already on the books. */
       LEFT JOIN sales_documents d
              ON d.id = t.document_id AND d.status = 'saved'
      WHERE t.is_active = 1
      ORDER BY t.section, t.sort_order, t.code`,
  )
  return rows.map(mapTable)
}

export async function getTable(siteId: number, id: number): Promise<PosTable | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT t.id, t.code, t.name, t.section, t.seats, t.sort_order, t.is_active,
            t.document_id, t.bill_asked_at,
            d.total_incl, d.created_at AS opened_at,
            (SELECT COUNT(*) FROM sales_document_lines l WHERE l.document_id = d.id) AS line_count
       FROM pos_tables t
       LEFT JOIN sales_documents d ON d.id = t.document_id AND d.status = 'saved'
      WHERE t.id = ? LIMIT 1`,
    [id],
  )
  return row ? mapTable(row) : null
}

/** The table holding one document, if any. For freeing it after a sale posts. */
export async function tableForDocument(
  siteId: number,
  documentId: number,
): Promise<PosTable | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM pos_tables WHERE document_id = ? LIMIT 1`,
    [documentId],
  )
  return row ? getTable(siteId, Number(row.id)) : null
}

export type SaveResult = { ok: true } | { ok: false; error: string }

/**
 * Attaches a basket to a table.
 *
 * ── WHY THIS IS A TRANSACTION AND NOT AN UPDATE ───────────────────────────
 *
 * Two waiters can seat the same table in the same second. Read-then-write would let
 * both succeed and the second would silently take the first's bill — so the row is
 * locked, the occupancy re-checked inside the lock, and the loser told the table is
 * taken rather than quietly overwriting.
 *
 * `uq_table_document` is the backstop on the other axis: one basket cannot be on two
 * tables, which would let two waiters take payment for one bill.
 */
export async function seatTable(
  siteId: number,
  tableId: number,
  documentId: number,
): Promise<SaveResult> {
  return siteTransaction(siteId, async (tx) => {
    /*
     * The pointer AND whether what it points at is still an open bill.
     *
     * A settled table keeps its pointer until something clears it, so checking the
     * column alone would refuse the next party on a table whose bill was paid an hour
     * ago — a table nobody could seat, for no reason a waiter could see.
     *
     * The status is read here rather than trusted from a prior `getTable` call because
     * this is the locked read: anything checked outside the lock can change before the
     * write lands, which is the whole reason this is a transaction.
     */
    const [rows] = await tx.query(
      `SELECT t.document_id,
              (SELECT d.status FROM sales_documents d WHERE d.id = t.document_id) AS doc_status
         FROM pos_tables t WHERE t.id = ? FOR UPDATE`,
      [tableId],
    )
    const current = (rows as Row[])[0]
    if (!current) return { ok: false, error: 'That table no longer exists.' }

    const held = current.document_id === null ? null : Number(current.document_id)
    const stillOpen = current.doc_status === 'saved'
    if (held !== null && held !== documentId && stillOpen) {
      return { ok: false, error: 'Somebody has just opened a bill on that table.' }
    }

    await tx.execute(
      /* bill_asked_at cleared as well: seating a table is the start of a new sitting,
         and a stale "bill asked" from the last one would show the new party as waiting
         to pay before they had ordered. */
      `UPDATE pos_tables SET document_id = ?, bill_asked_at = NULL WHERE id = ?`,
      [documentId, tableId] as never,
    )
    return { ok: true }
  })
}

/**
 * Frees a table.
 *
 * Called when the bill is paid, and when a waiter abandons an empty basket. Does NOT
 * touch the document — a paid bill is a finalised invoice that must stay exactly where
 * it is, and an abandoned one is discarded by the same path the retail till uses.
 */
export async function freeTable(siteId: number, tableId: number): Promise<SaveResult> {
  await siteExecute(
    siteId,
    `UPDATE pos_tables SET document_id = NULL, bill_asked_at = NULL WHERE id = ?`,
    [tableId],
  )
  return { ok: true }
}

/**
 * Frees whichever table holds a document. Idempotent.
 *
 * The hook a sale posts through, so a table is released by the ACT of paying rather
 * than by the screen remembering to release it. A till that crashed between finalising
 * and freeing would otherwise leave a table nobody could seat, holding a bill that was
 * already on the books.
 */
export async function freeTableForDocument(siteId: number, documentId: number): Promise<void> {
  await siteExecute(
    siteId,
    `UPDATE pos_tables SET document_id = NULL, bill_asked_at = NULL WHERE document_id = ?`,
    [documentId],
  ).catch(() => {
    /* Swallowed on purpose: this runs after a sale has been posted, and failing the
       sale because a table could not be released would undo real money to tidy up a
       flag. A stuck table is visible on the gate and fixable in a tap. */
  })
}

/** Marks the bill as asked for, so the floor can see who is waiting to pay. */
export async function markBillAsked(siteId: number, tableId: number): Promise<SaveResult> {
  const result = await siteExecute(
    siteId,
    /* Only when a bill is actually open. Asking for the bill on a free table is
       meaningless, and letting it through would show an empty table as waiting. */
    `UPDATE pos_tables SET bill_asked_at = NOW()
      WHERE id = ? AND document_id IS NOT NULL AND bill_asked_at IS NULL`,
    [tableId],
  )
  if (result.affectedRows === 0) {
    return { ok: false, error: 'That table has no bill open.' }
  }
  return { ok: true }
}

/* ── Setup ───────────────────────────────────────────────────────────────── */

export type TableInput = {
  code: string
  name?: string
  section?: string
  seats?: number
}

export function validateTable(input: TableInput): string | null {
  const code = input.code?.trim() ?? ''
  if (!code) return 'A table needs a name or number.'
  if (code.length > 16) return 'Keep the table code to 16 characters or fewer.'
  if ((input.name ?? '').length > 60) return 'Keep the description to 60 characters or fewer.'
  if ((input.section ?? '').length > 40) return 'Keep the section name to 40 characters or fewer.'
  const seats = input.seats ?? 0
  if (!Number.isInteger(seats) || seats < 0 || seats > 99) {
    return 'Seats must be between 0 and 99.'
  }
  return null
}

export async function createTable(
  siteId: number,
  input: TableInput,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const invalid = validateTable(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM pos_tables WHERE code = ? LIMIT 1`,
    [code],
  )
  if (clash) return { ok: false, error: `There is already a table "${code}".` }

  /* Appended, and the position read inside the same statement — a floor built by
     typing six tables in a row must not have them all at sort_order 0, where they
     would then order lexically and put table 10 before table 2. */
  const result = await siteExecute(
    siteId,
    `INSERT INTO pos_tables (code, name, section, seats, sort_order)
     VALUES (?,?,?,?, (SELECT COALESCE(MAX(t.sort_order), -1) + 1 FROM pos_tables t))`,
    [code, (input.name ?? '').trim(), (input.section ?? '').trim(), input.seats ?? 0],
  )
  return { ok: true, id: result.insertId }
}

export async function updateTable(
  siteId: number,
  id: number,
  input: TableInput,
): Promise<SaveResult> {
  const invalid = validateTable(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim()
  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM pos_tables WHERE code = ? AND id <> ? LIMIT 1`,
    [code, id],
  )
  if (clash) return { ok: false, error: `There is already a table "${code}".` }

  const result = await siteExecute(
    siteId,
    `UPDATE pos_tables SET code = ?, name = ?, section = ?, seats = ? WHERE id = ?`,
    [code, (input.name ?? '').trim(), (input.section ?? '').trim(), input.seats ?? 0, id],
  )
  if (result.affectedRows === 0) return { ok: false, error: 'That table no longer exists.' }
  return { ok: true }
}

/**
 * Takes a table out of service.
 *
 * Deactivated, never deleted: its past bills are finalised invoices that must keep
 * resolving, and a table out of service for a week comes back with its history.
 * Refused while a bill is open — the alternative is a bill nobody can reach.
 */
export async function deactivateTable(siteId: number, id: number): Promise<SaveResult> {
  const table = await getTable(siteId, id)
  if (!table) return { ok: false, error: 'That table no longer exists.' }
  if (table.documentId !== null) {
    return { ok: false, error: 'Settle or clear the bill on that table first.' }
  }

  await siteExecute(siteId, `UPDATE pos_tables SET is_active = 0 WHERE id = ?`, [id])
  return { ok: true }
}
