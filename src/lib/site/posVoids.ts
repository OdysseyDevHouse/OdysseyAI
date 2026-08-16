import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery } from '../siteDb'

/**
 * Voids taken off a draft sale — the till's record of what came off the screen
 * before anybody paid.
 *
 * ── VOID IS NOT CANCEL ─────────────────────────────────────────────────────
 *
 * A CANCEL reverses a finalised sale: stock returns, money comes back, the
 * document keeps its number and goes to status cancelled. That lives on
 * sales_documents (cancel_reason_id) and none of it is here.
 *
 * A VOID takes something off a sale that was never finalised. Nothing posted,
 * so there is nothing to reverse — and, critically, usually no row to write a
 * reason onto. A retail counter sale exists only in the browser until it is
 * tendered, so `documentId` is null for most of what this records.
 *
 * That is the whole argument for the table: an honest mis-scan and a cashier
 * ringing goods up, taking the cash and voiding the line leave an IDENTICAL
 * absence in sales_documents. This is the only place the two can be told apart.
 *
 * ── WRITES NEVER THROW ─────────────────────────────────────────────────────
 *
 * Same rule as the activity log, for the same reason. The void has already
 * happened on the cashier's screen; a failed audit write must not roll it back
 * or block the sale. Losing the row is bad, holding a customer at the counter
 * over it is worse. Callers get `false` and decide for themselves — the till
 * deliberately does not tell the cashier, who did not ask for a trail.
 */

type Row = RowDataPacket & Record<string, unknown>

/**
 * What the cashier did, which is not the same as what the reducer did.
 *
 * A minus press on a single-unit line REMOVES that line (see `stepQty`), but it
 * is still an `item` void — item is the gesture. Filing it as `line` would
 * inflate line voids on precisely those shops that sell single units.
 */
export type VoidType = 'item' | 'line' | 'sale'

export type VoidEventInput = {
  voidType: VoidType
  /** Ties a `sale` rollup to the `line` rows written with it. */
  groupId?: string | null
  reasonId: number
  /** Kept beside the id so a renamed or deleted reason still reads. */
  reasonCode: string | null
  note?: string | null
  documentId?: number | null
  productId?: number | null
  productCode?: string | null
  description: string
  qty: number
  /** VAT in, before line discount — what the customer would have been asked. */
  valueIncl: number
  /** When the cashier did it. Differs from arrival time on an offline till. */
  voidedAt?: Date | null
}

export type VoidActor = {
  userId: number | null
  userName: string | null
  terminalId?: number | null
  terminalCode?: string | null
  shiftId?: number | null
}

/**
 * Records one or more voids.
 *
 * Batched deliberately: abandoning a basket of four writes five rows (one
 * `sale`, four `line`) and they must arrive together or not at all — a partial
 * write would leave a rollup with no lines under it, which reads as a voided
 * empty basket. One multi-row INSERT also means one round trip from a till that
 * may be on a phone tether.
 */
export async function recordVoidEvents(
  siteId: number,
  actor: VoidActor,
  events: VoidEventInput[],
): Promise<boolean> {
  if (events.length === 0) return true

  const values: unknown[] = []
  const placeholders = events
    .map((e) => {
      values.push(
        e.voidType,
        e.groupId ?? null,
        e.reasonId,
        e.reasonCode ?? null,
        e.note?.trim() || null,
        e.documentId ?? null,
        e.productId ?? null,
        e.productCode ?? null,
        /* Never empty: the report shows this as the row label, and a blank cell
           there is indistinguishable from a broken join. */
        e.description.trim() || 'Item',
        e.qty,
        e.valueIncl,
        actor.userId ?? null,
        actor.userName ?? null,
        actor.terminalId ?? null,
        actor.terminalCode ?? null,
        actor.shiftId ?? null,
        e.voidedAt ?? new Date(),
      )
      return '(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
    })
    .join(',')

  try {
    await siteExecute(
      siteId,
      `INSERT INTO pos_void_events
         (void_type, group_id, reason_id, reason_code, note, document_id,
          product_id, product_code, description, qty, value_incl,
          user_id, user_name, terminal_id, terminal_code, shift_id, voided_at)
       VALUES ${placeholders}`,
      values,
    )
    return true
  } catch {
    /* Swallowed by design — see WRITES NEVER THROW. The void stands either way;
       the cashier has already seen the line leave the screen. */
    return false
  }
}

/** One line of the void report, as the summary screen shows it. */
export type VoidSummaryRow = {
  reasonId: number | null
  reasonCode: string
  reasonName: string
  voidType: VoidType
  events: number
  qty: number
  value: number
}

/**
 * Voids in a period, grouped by reason and kind.
 *
 * `sale` rows are EXCLUDED from the value total by every caller that sums, and
 * that is not an oversight: an abandoned basket writes both a `sale` rollup and
 * a `line` row per line, so counting both doubles it. They are returned as
 * their own `voidType` group so the count of abandoned baskets stays visible
 * without contaminating the money.
 *
 * Falls back to the stored `reason_code` when the reason itself has been
 * deleted, so a retired vocabulary never blanks a historical report.
 */
export async function voidSummary(
  siteId: number,
  from: string,
  to: string,
): Promise<VoidSummaryRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT v.reason_id,
            COALESCE(r.code, v.reason_code, 'NOT-RECORDED') AS reason_code,
            COALESCE(r.name, v.reason_code, 'Not recorded') AS reason_name,
            v.void_type,
            COUNT(*)          AS events,
            SUM(v.qty)        AS qty,
            SUM(v.value_incl) AS value
       FROM pos_void_events v
       LEFT JOIN sales_void_reasons r ON r.id = v.reason_id
      WHERE v.voided_at >= ? AND v.voided_at < ?
      GROUP BY v.reason_id, reason_code, reason_name, v.void_type
      ORDER BY value DESC`,
    [from, to],
  )

  return rows.map((r) => ({
    reasonId: r.reason_id === null ? null : Number(r.reason_id),
    reasonCode: String(r.reason_code),
    reasonName: String(r.reason_name),
    voidType: String(r.void_type) as VoidType,
    events: Number(r.events),
    qty: Number(r.qty ?? 0),
    value: Number(r.value ?? 0),
  }))
}
