import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute } from '../siteDb'

/**
 * The reasons a sale is voided and the reasons goods come back.
 *
 * ── WHY THESE ARE ROWS ─────────────────────────────────────────────────────
 *
 * Both events have always demanded a reason — VoidModal and RefundPad each
 * refuse to submit without one, and so do voidDocument and createCreditNote.
 * The discipline was never the problem. The problem was that the answer was
 * free text, so "damaged", "Damaged" and "dmgd" were three different reasons and
 * no report could add them up. A void-history report could list reasons; it
 * could not tell you what you were losing to voids and why.
 *
 * ── TWO LISTS, NOT ONE ─────────────────────────────────────────────────────
 *
 * The vocabularies do not overlap. Faulty is never why a cashier voids; rang up
 * twice is never why a customer comes back. One table with a scope column would
 * spend its life being filtered back into these two, and a mis-set scope puts
 * the wrong word in front of a cashier mid-sale. They are separate tables with
 * one shared shape, which is why this file is generic over that shape rather
 * than written twice.
 *
 * ── THE NOTE STAYS ─────────────────────────────────────────────────────────
 *
 * The picker answers "which of the things that happen was this" and the note
 * answers "what happened this time". Only the first is groupable, so only the
 * first is required. `allowsNote` decides per reason whether the note box is
 * offered at all: WRONG-ITEM says everything already, OTHER never does.
 */

type Row = RowDataPacket & Record<string, unknown>

/** Which list a reason belongs to. Decides the table and nothing else. */
export type ReasonKind = 'void' | 'return'

const TABLE: Record<ReasonKind, string> = {
  void: 'sales_void_reasons',
  return: 'sales_return_reasons',
}

/**
 * The column on sales_documents holding the chosen reason, per kind.
 *
 * Both live on the same table because a credit note IS a sales_documents row
 * (doc_type credit_sale). Only one is ever set on a given row.
 */
const DOCUMENT_COLUMN: Record<ReasonKind, string> = {
  void: 'cancel_reason_id',
  return: 'return_reason_id',
}

export type SalesReason = {
  id: number
  code: string
  name: string
  /** Whether the till offers a free-text note beside this reason. */
  allowsNote: boolean
  /**
   * Returns only. Whether goods back for this reason can be sold again.
   * Always true on a void reason, where it has no meaning.
   */
  restocks: boolean
  isActive: boolean
  sortOrder: number
  /** Documents naming it. Shown before offering to retire one. */
  useCount: number
}

function mapReason(r: Row): SalesReason {
  return {
    id: Number(r.id),
    code: String(r.code),
    name: String(r.name),
    allowsNote: !!r.allows_note,
    restocks: r.restocks === undefined ? true : !!r.restocks,
    isActive: !!r.is_active,
    sortOrder: Number(r.sort_order ?? 0),
    useCount: Number(r.use_count ?? 0),
  }
}

export async function listSalesReasons(
  siteId: number,
  kind: ReasonKind,
  includeInactive = false,
): Promise<SalesReason[]> {
  // `restocks` only exists on the returns table, so it is selected as a literal
  // for voids rather than branching the mapper on which list it came from.
  const restocks = kind === 'return' ? 'r.restocks' : '1 AS restocks'
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT r.id, r.code, r.name, r.allows_note, ${restocks}, r.is_active, r.sort_order,
            (SELECT COUNT(*) FROM sales_documents d
              WHERE d.${DOCUMENT_COLUMN[kind]} = r.id) AS use_count
       FROM ${TABLE[kind]} r
      ${includeInactive ? '' : 'WHERE r.is_active = 1'}
      ORDER BY r.sort_order ASC, r.name ASC`,
  )
  return rows.map(mapReason)
}

export type SalesReasonInput = {
  code: string
  name: string
  allowsNote?: boolean
  restocks?: boolean
  isActive?: boolean
  sortOrder?: number
}

export function validateSalesReason(input: SalesReasonInput): string | null {
  const code = input.code.trim().toUpperCase()
  if (!/^[A-Z0-9-]{2,24}$/.test(code)) {
    return 'A reason code is 2 to 24 letters, digits or hyphens.'
  }
  if (!input.name.trim()) return 'Give the reason a name.'
  return null
}

export async function saveSalesReason(
  siteId: number,
  kind: ReasonKind,
  input: SalesReasonInput,
  id?: number,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const invalid = validateSalesReason(input)
  if (invalid) return { ok: false, error: invalid }

  const code = input.code.trim().toUpperCase()
  const clash = await siteQueryOne<Row>(
    siteId,
    `SELECT id FROM ${TABLE[kind]} WHERE code = ? AND id <> ? LIMIT 1`,
    [code, id ?? 0],
  )
  if (clash) return { ok: false, error: `Another reason already uses the code ${code}.` }

  const name = input.name.trim().slice(0, 120)
  const allowsNote = input.allowsNote === false ? 0 : 1
  const isActive = input.isActive === false ? 0 : 1
  const sortOrder = input.sortOrder ?? 0

  if (kind === 'return') {
    const restocks = input.restocks === false ? 0 : 1
    if (id) {
      await siteExecute(
        siteId,
        `UPDATE sales_return_reasons
            SET code = ?, name = ?, allows_note = ?, restocks = ?, is_active = ?, sort_order = ?
          WHERE id = ?`,
        [code, name, allowsNote, restocks, isActive, sortOrder, id],
      )
      return { ok: true, id }
    }
    const res = await siteExecute(
      siteId,
      `INSERT INTO sales_return_reasons (code, name, allows_note, restocks, is_active, sort_order)
       VALUES (?,?,?,?,?,?)`,
      [code, name, allowsNote, restocks, isActive, sortOrder],
    )
    return { ok: true, id: res.insertId }
  }

  if (id) {
    await siteExecute(
      siteId,
      `UPDATE sales_void_reasons
          SET code = ?, name = ?, allows_note = ?, is_active = ?, sort_order = ?
        WHERE id = ?`,
      [code, name, allowsNote, isActive, sortOrder, id],
    )
    return { ok: true, id }
  }
  const res = await siteExecute(
    siteId,
    `INSERT INTO sales_void_reasons (code, name, allows_note, is_active, sort_order)
     VALUES (?,?,?,?,?)`,
    [code, name, allowsNote, isActive, sortOrder],
  )
  return { ok: true, id: res.insertId }
}

/**
 * Retires a reason, or deletes it when no document has ever named it.
 *
 * The same rule as an adjustment reason: history naming it has to keep reading
 * correctly, so a used reason is deactivated rather than removed.
 */
export async function deleteSalesReason(
  siteId: number,
  kind: ReasonKind,
  id: number,
): Promise<{ ok: true; retired: boolean } | { ok: false; error: string }> {
  const used = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS n FROM sales_documents WHERE ${DOCUMENT_COLUMN[kind]} = ?`,
    [id],
  )
  if (Number(used?.n ?? 0) > 0) {
    await siteExecute(siteId, `UPDATE ${TABLE[kind]} SET is_active = 0 WHERE id = ?`, [id])
    return { ok: true, retired: true }
  }
  await siteExecute(siteId, `DELETE FROM ${TABLE[kind]} WHERE id = ?`, [id])
  return { ok: true, retired: false }
}

/**
 * The reason the system itself uses when it credits an invoice to correct it.
 *
 * An invoice correction reverses the original through the ordinary credit path,
 * so it must name a return reason — but nothing came back and no operator chose
 * anything. Borrowing OTHER would file corrections in the returns report as
 * goods returned, which is the exact mis-grouping these codes exist to end.
 */
export const CORRECTION_REASON_CODE = 'CORRECTION'

/**
 * Finds a reason by its code, for the paths where the system picks rather than
 * a person.
 *
 * Returns null when the site has deleted or renamed the code — callers decide
 * whether that is fatal. Deliberately ignores `is_active`: a site that retires
 * CORRECTION should not thereby break invoice editing.
 */
export async function findSalesReasonByCode(
  siteId: number,
  kind: ReasonKind,
  code: string,
): Promise<SalesReason | null> {
  const restocks = kind === 'return' ? 'restocks' : '1 AS restocks'
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, code, name, allows_note, ${restocks}, is_active, sort_order
       FROM ${TABLE[kind]} WHERE code = ? LIMIT 1`,
    [code],
  )
  return row ? mapReason(row) : null
}

/**
 * Resolves a chosen reason id to a row, refusing anything that is not a live
 * reason of that kind.
 *
 * Every write path calls this rather than trusting the id it was handed. The id
 * arrives from a client — the till, a back-office form, or an offline payload
 * replayed hours later — so "does this name a real, live reason" is a question
 * the server has to answer for itself.
 *
 * ── WHAT THIS CANNOT CATCH ────────────────────────────────────────────────
 *
 * The two tables have independent AUTO_INCREMENTs, so their id ranges overlap:
 * void 1 is WRONG-ITEM and return 1 is FAULTY. A caller that passes a RETURN id
 * to a void therefore resolves cleanly against the void table and stores the
 * wrong reason — nothing here can tell the two apart, because a bare integer
 * carries no information about where it came from.
 *
 * The defence is the TYPE, not this function. `VoidReasonInput` and
 * `CreditNoteInput` are distinct shapes reached through distinct pickers, each
 * fed a list loaded for one kind, so a crossed id means a caller wired the
 * wrong list to the wrong modal — which is a compile-time-shaped mistake, not
 * something a user can do. Keep it that way: never let one screen hold both
 * lists in one variable, and never resolve a reason from a raw id typed in.
 */
export async function requireSalesReason(
  siteId: number,
  kind: ReasonKind,
  id: number | null | undefined,
  /**
   * Accepts a retired reason. Only for paths where the system chose the code
   * rather than a person — see CORRECTION_REASON_CODE.
   */
  allowRetired = false,
): Promise<{ ok: true; reason: SalesReason } | { ok: false; error: string }> {
  const label = kind === 'void' ? 'void' : 'return'
  if (!id) return { ok: false, error: `Choose a ${label} reason.` }

  const restocks = kind === 'return' ? 'restocks' : '1 AS restocks'
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT id, code, name, allows_note, ${restocks}, is_active, sort_order
       FROM ${TABLE[kind]} WHERE id = ? LIMIT 1`,
    [id],
  )
  if (!row) return { ok: false, error: `That ${label} reason no longer exists.` }

  const reason = mapReason(row)
  // A retired reason is refused on a NEW document but stays readable on every
  // old one — that is the whole point of retiring rather than deleting. An
  // offline sale queued before the reason was retired lands here, which is why
  // the message says what to do rather than just refusing.
  if (!reason.isActive && !allowRetired) {
    return { ok: false, error: `${reason.name} has been retired. Choose another ${label} reason.` }
  }
  return { ok: true, reason }
}
