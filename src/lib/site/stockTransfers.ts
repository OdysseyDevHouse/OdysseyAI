import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { markTransferred } from './serials'
import { guardPosting } from './periodLocks'
import type { Actor } from './activityLog'

/**
 * Moving stock between locations.
 *
 * ── THE PAIRED MOVEMENT RULE ───────────────────────────────────────────────
 *
 * Every posted line writes EXACTLY TWO movements, in one transaction:
 *
 *   transfer_out   -qty   against the FROM location
 *   transfer_in    +qty   against the TO location
 *
 * Equal and opposite, so the site total never moves — the business owns the
 * same goods, in a different room. That is what keeps all three invariants
 * true at once:
 *
 *   (A) Σ qty_change = products.stock_on_hand   — the two halves cancel
 *   (B) Σ per (product, location)               — each pile gets its own half
 *   (C) Σ piles = products.stock_on_hand        — unchanged on both sides
 *
 * A transfer writing only one half would break (C) instantly. They are never
 * separate, which is why this is the only function that writes them and why it
 * refuses to post anything it cannot post completely.
 *
 * ── WHAT A TRANSFER DOES NOT DO ────────────────────────────────────────────
 *
 * It does not touch average_cost. The goods are the same goods and no money
 * was spent; only a GRV moves cost, and that rule is not weakened here. The
 * cost is copied onto both movements so per-location valuation is answerable,
 * but it is a record of what the stock was worth, not a repricing.
 */

/**
 * `in_transit` and `received` belong to STORE transfers only — see 101 and
 * storeTransfers.ts. They are in this union because they share the table, and
 * every screen that renders a status has to be able to name them.
 */
export type TransferStatus = 'draft' | 'posted' | 'in_transit' | 'received' | 'cancelled'

/**
 * Which kind of transfer a row is.
 *
 *   internal  between two locations here, written by postTransfer below
 *   out       dispatched to another store, written by storeTransfers.ts
 *   in        received from another store, written by storeTransfers.ts
 */
export type TransferDirection = 'internal' | 'out' | 'in'

export type TransferLine = {
  id: number
  productId: number
  productCode: string | null
  description: string
  qty: number
  /**
   * What actually arrived, on a STORE transfer.
   *
   * Null on an internal one, where the goods arrive the instant they leave, and
   * on a dispatch nobody has answered yet. A number below `qty` is a short
   * delivery — the difference never reached anyone and the sending store wears
   * it. Carried onto the document so that loss is readable months later, not
   * only in the movement ledger.
   */
  qtyReceived: number | null
  unitCostExcl: number
}

export type StockTransfer = {
  id: number
  documentNumber: string | null
  documentDate: string
  direction: TransferDirection
  /** The other store, on a store transfer. Null on an internal one. */
  peerSiteName: string | null
  /**
   * Null on an INBOUND store transfer: the goods came out of another database
   * entirely, and there is no local room that they left.
   */
  fromLocationId: number | null
  fromLocationCode: string
  fromLocationName: string
  toLocationId: number | null
  toLocationCode: string
  toLocationName: string
  status: TransferStatus
  reference: string | null
  note: string | null
  postedAt: Date | null
  cancelReason: string | null
  userName: string
  lines: TransferLine[]
  /** Line count and total quantity, for a list that does not load the lines. */
  lineCount: number
  totalQty: number
}

type Row = RowDataPacket & Record<string, unknown>

function mapTransfer(r: Row, lines: TransferLine[] = []): StockTransfer {
  return {
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date).slice(0, 10),
    direction: (String(r.direction ?? 'internal') as TransferDirection),
    peerSiteName: (r.peer_site_name as string | null) ?? null,
    fromLocationId: r.from_location_id === null ? null : Number(r.from_location_id),
    fromLocationCode: String(r.from_code ?? ''),
    fromLocationName: String(r.from_name ?? ''),
    toLocationId: r.to_location_id === null ? null : Number(r.to_location_id),
    toLocationCode: String(r.to_code ?? ''),
    toLocationName: String(r.to_name ?? ''),
    status: String(r.status) as TransferStatus,
    reference: (r.reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    postedAt: (r.posted_at as Date | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    lines,
    lineCount: Number(r.line_count ?? lines.length),
    totalQty: toNum(r.total_qty ?? lines.reduce((s, l) => s + l.qty, 0)),
  }
}

/*
 * LEFT JOIN on both locations, not INNER.
 *
 * An INBOUND store transfer has no local source room — the goods came out of
 * another database — so from_location_id is genuinely NULL. An inner join would
 * not merely blank the column, it would drop the whole row, and every transfer
 * received from another store would silently vanish from this list.
 */
const SELECT_TRANSFER = `
  SELECT t.id, t.document_number, t.document_date, t.direction, t.peer_site_name,
         t.from_location_id, t.to_location_id, t.status, t.reference, t.note,
         t.posted_at, t.cancel_reason, t.user_name,
         f.code AS from_code, f.name AS from_name,
         g.code AS to_code,   g.name AS to_name,
         (SELECT COUNT(*)             FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS line_count,
         (SELECT COALESCE(SUM(l.qty),0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id) AS total_qty
    FROM stock_transfers t
    LEFT JOIN stock_locations f ON f.id = t.from_location_id
    LEFT JOIN stock_locations g ON g.id = t.to_location_id
`

export async function listTransfers(
  siteId: number,
  opts: {
    status?: TransferStatus | 'all'
    /** 'all' includes store transfers in both directions alongside internal ones. */
    direction?: TransferDirection | 'all'
    limit?: number
  } = {},
): Promise<StockTransfer[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)

  const where: string[] = []
  const params: unknown[] = []
  if (opts.status && opts.status !== 'all') {
    where.push('t.status = ?')
    params.push(opts.status)
  }
  if (opts.direction && opts.direction !== 'all') {
    where.push('t.direction = ?')
    params.push(opts.direction)
  }

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_TRANSFER}
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY t.document_date DESC, t.id DESC LIMIT ${limit}`,
    params,
  )
  return rows.map((r) => mapTransfer(r))
}

export async function getTransfer(siteId: number, id: number): Promise<StockTransfer | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_TRANSFER} WHERE t.id = ? LIMIT 1`, [id])
  if (!row) return null

  const lineRows = await siteQuery<Row>(
    siteId,
    `SELECT id, product_id, product_code, description, qty, qty_received, unit_cost_excl
       FROM stock_transfer_lines WHERE transfer_id = ? ORDER BY line_number ASC, id ASC`,
    [id],
  )

  return mapTransfer(
    row,
    lineRows.map((l) => ({
      id: Number(l.id),
      productId: Number(l.product_id),
      productCode: (l.product_code as string | null) ?? null,
      description: String(l.description),
      qty: toNum(l.qty),
      qtyReceived: l.qty_received === null ? null : toNum(l.qty_received),
      unitCostExcl: toNum(l.unit_cost_excl),
    })),
  )
}

export type TransferLineInput = {
  productId: number
  productCode?: string | null
  description: string
  qty: number
  unitCostExcl?: number
  /**
   * For a serial-tracked product, WHICH units are moving.
   *
   * The quantity alone is not enough for a serialised line: the pile in each
   * room would come out right while every unit still claimed the room the
   * goods left. Required for a serial product, and its length must equal qty —
   * both refusals live in postTransfer.
   */
  serialIds?: readonly number[]
}

export type TransferInput = {
  fromLocationId: number
  toLocationId: number
  documentDate?: string
  reference?: string | null
  note?: string | null
  lines: TransferLineInput[]
}

export type PostResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * Validates a transfer without touching the database.
 *
 * Kept separate so the screen can refuse the same things for the same reasons
 * before anyone clicks post.
 */
export function validateTransfer(input: TransferInput): string | null {
  if (!input.fromLocationId) return 'Choose where the stock is coming from.'
  if (!input.toLocationId) return 'Choose where the stock is going.'

  // The one refusal that is not about data quality: a transfer to the same
  // place writes +q and -q against ONE pile. Every invariant survives, nothing
  // moves, and the document claims something happened. That is worse than an
  // error, so it is refused rather than silently allowed.
  if (input.fromLocationId === input.toLocationId) {
    return 'A transfer needs two different locations — stock cannot move to where it already is.'
  }

  const lines = input.lines.filter((l) => l.productId)
  if (lines.length === 0) return 'Add at least one product to transfer.'
  if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
    return 'Every line needs a quantity greater than zero.'
  }
  return null
}

/**
 * Posts a transfer: writes the document, then both halves of every line.
 *
 * ── WHY IT REFUSES TO OVERDRAW ─────────────────────────────────────────────
 *
 * Sales are allowed to take a pile negative — a till that refuses to sell what
 * is physically in the customer's hand is worse than a stock figure that needs
 * correcting. A transfer has no such excuse: nobody is waiting, and moving 10
 * out of a room holding 3 records goods that were never there. So it is
 * checked, per line, inside the transaction, against the FROM pile.
 *
 * The check reads FOR UPDATE so two transfers emptying the same pile cannot
 * both pass it.
 */
export async function postTransfer(
  siteId: number,
  actor: Actor,
  input: TransferInput,
): Promise<PostResult> {
  const invalid = validateTransfer(input)
  if (invalid) return { ok: false, error: invalid }

  const docDate = input.documentDate ?? todayIso()
  const lockRefusal = await guardPosting(siteId, docDate, 'stock')
  if (lockRefusal) return { ok: false, error: lockRefusal }

  const locations = await siteQuery<Row>(
    siteId,
    'SELECT id, code, name, is_active FROM stock_locations WHERE id IN (?,?)',
    [input.fromLocationId, input.toLocationId],
  )
  if (locations.length !== 2) return { ok: false, error: 'One of those locations no longer exists.' }

  const inactive = locations.find((l) => !l.is_active)
  if (inactive) {
    return {
      ok: false,
      error: `${String(inactive.name)} is deactivated. Activate it before moving stock through it.`,
    }
  }

  const lines = input.lines.filter((l) => l.productId)

  try {
    return await siteTransaction(siteId, async (tx) => {
      // Every FROM pile is locked and checked BEFORE anything is written, so a
      // refusal leaves no partial document behind.
      for (const line of lines) {
        const [rows] = await tx.execute(
          `SELECT COALESCE(pls.stock_on_hand, 0) AS on_hand, p.code, p.description, p.product_type
             FROM products p
             LEFT JOIN product_location_stock pls
                    ON pls.product_id = p.id AND pls.location_id = ?
            WHERE p.id = ?
            FOR UPDATE`,
          [input.fromLocationId, line.productId] as never,
        )
        const row = (rows as Row[])[0]
        if (!row) return { ok: false as const, error: `A product on this transfer no longer exists.` }

        const available = toNum(row.on_hand)
        if (available < round(line.qty, 3)) {
          const from = locations.find((l) => Number(l.id) === input.fromLocationId)
          return {
            ok: false as const,
            error: `${String(row.code)} has only ${available} in ${String(from?.name ?? 'that location')} — cannot move ${line.qty}.`,
          }
        }

        // A serialised line has to say WHICH units. Moving the quantity alone
        // would leave every serial claiming the room the goods left, which is
        // exactly the drift (S2) exists to catch — so it is refused up front
        // rather than posted and reported later.
        if (String(row.product_type) === 'serial') {
          const chosen = line.serialIds ?? []
          if (chosen.length !== round(line.qty, 3)) {
            return {
              ok: false as const,
              error: `${String(row.code)} is serial-tracked — choose exactly ${line.qty} serial number${line.qty === 1 ? '' : 's'} to move.`,
            }
          }
        }
      }

      const documentNumber = await nextDocumentNumber(tx, 'stock_transfer')

      const [res] = await tx.execute(
        `INSERT INTO stock_transfers
           (document_number, document_date, from_location_id, to_location_id,
            status, reference, note, posted_at, user_id, user_name)
         VALUES (?,?,?,?, 'posted', ?,?, NOW(), ?,?)`,
        [
          documentNumber,
          docDate,
          input.fromLocationId,
          input.toLocationId,
          input.reference?.trim()?.slice(0, 60) || null,
          input.note?.trim()?.slice(0, 400) || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      const transferId = (res as { insertId: number }).insertId

      for (const [index, line] of lines.entries()) {
        const qty = round(line.qty, 3)
        const cost = round(line.unitCostExcl ?? 0, 4)

        await tx.execute(
          `INSERT INTO stock_transfer_lines
             (transfer_id, line_number, product_id, product_code, description, qty, unit_cost_excl)
           VALUES (?,?,?,?,?,?,?)`,
          [
            transferId,
            index + 1,
            line.productId,
            line.productCode ?? null,
            line.description.trim().slice(0, 190),
            qty.toFixed(3),
            cost.toFixed(4),
          ] as never,
        )

        // BOTH halves, always. Out first, so a failure cannot leave stock
        // duplicated into the destination.
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: input.fromLocationId,
          movementType: 'transfer_out',
          qtyChange: -qty,
          unitCostExcl: cost,
          source: 'transfer',
          sourceDocId: transferId,
          note: `To ${locations.find((l) => Number(l.id) === input.toLocationId)?.code ?? ''} on ${documentNumber}`,
        })

        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: input.toLocationId,
          movementType: 'transfer_in',
          qtyChange: qty,
          unitCostExcl: cost,
          source: 'transfer',
          sourceDocId: transferId,
          note: `From ${locations.find((l) => Number(l.id) === input.fromLocationId)?.code ?? ''} on ${documentNumber}`,
        })

        // The units follow the quantity, in the same transaction. Without
        // this the piles would be right and every serial would still name the
        // room the goods left.
        if (line.serialIds && line.serialIds.length > 0) {
          const moved = await markTransferred(tx, actor, {
            serialIds: line.serialIds,
            fromLocationId: input.fromLocationId,
            toLocationId: input.toLocationId,
            transferId,
          })
          // Throwing rolls the whole transaction back — the movements above
          // included. A partial post here is the one outcome that would break
          // the invariants this function exists to keep.
          if (!moved.ok) throw new Error(moved.error)
        }
      }

      return { ok: true as const, id: transferId, documentNumber }
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The transfer could not be posted.' }
  }
}

/**
 * Reverses a posted transfer.
 *
 * Writes a THIRD and FOURTH movement per line rather than deleting the first
 * two — the same reasoning as voiding a receipt. The stock genuinely went
 * somewhere and came back, and erasing that would leave a pile whose history
 * does not explain it.
 *
 * Refuses when the destination no longer holds what it received: the goods
 * have since been sold or moved on, and pulling them back would drive that
 * pile negative for stock it does not have.
 */
export async function voidTransfer(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason.trim()) return { ok: false, error: 'A reason is required to void a transfer.' }

  const transfer = await getTransfer(siteId, id)
  if (!transfer) return { ok: false, error: 'That transfer no longer exists.' }
  if (transfer.status === 'cancelled') return { ok: false, error: 'That transfer is already void.' }
  if (transfer.status !== 'posted') return { ok: false, error: 'Only a posted transfer can be voided.' }

  /*
   * A store transfer is not reversible from here. Its two halves live in two
   * databases, so putting the goods back is a recall (before receipt) or a
   * fresh transfer the other way (after) — both of which storeTransfers.ts
   * owns. Reversing only this side would leave the pair contradicting itself.
   */
  if (transfer.direction !== 'internal') {
    return {
      ok: false,
      error: 'This transfer went to another store. Recall it from the dispatch, or send the goods back.',
    }
  }
  if (transfer.fromLocationId === null || transfer.toLocationId === null) {
    return { ok: false, error: 'That transfer is missing a location and cannot be reversed.' }
  }
  const { fromLocationId, toLocationId } = transfer

  const cancelLockRefusal = await guardPosting(siteId, transfer.documentDate, 'stock')
  if (cancelLockRefusal) return { ok: false, error: cancelLockRefusal }

  try {
    return await siteTransaction(siteId, async (tx) => {
      for (const line of transfer.lines) {
        const [rows] = await tx.execute(
          `SELECT COALESCE(stock_on_hand, 0) AS on_hand
             FROM product_location_stock
            WHERE product_id = ? AND location_id = ?
            FOR UPDATE`,
          [line.productId, toLocationId] as never,
        )
        const available = toNum((rows as Row[])[0]?.on_hand)
        if (available < line.qty) {
          return {
            ok: false as const,
            error: `${line.productCode ?? line.description} has only ${available} left in ${transfer.toLocationName} — it cannot be sent back.`,
          }
        }
      }

      for (const line of transfer.lines) {
        // Exactly the original pair, reversed.
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: toLocationId,
          movementType: 'transfer_out',
          qtyChange: -line.qty,
          unitCostExcl: line.unitCostExcl,
          source: 'transfer_void',
          sourceDocId: transfer.id,
          note: `Void of ${transfer.documentNumber}`,
        })

        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: fromLocationId,
          movementType: 'transfer_in',
          qtyChange: line.qty,
          unitCostExcl: line.unitCostExcl,
          source: 'transfer_void',
          sourceDocId: transfer.id,
          note: `Void of ${transfer.documentNumber}`,
        })

        // Send the units back with the quantity. Which ones moved is recorded
        // in serial_movements rather than on the line — a transfer line holds a
        // quantity, and the units are what the serial history is FOR.
        const [movedRows] = await tx.execute(
          `SELECT sm.serial_id
             FROM serial_movements sm
             JOIN product_serials s ON s.id = sm.serial_id
            WHERE sm.document_id = ? AND sm.action = 'transferred'
              AND sm.to_location_id = ? AND s.product_id = ?`,
          [transfer.id, toLocationId, line.productId] as never,
        )
        const serialIds = (movedRows as Row[]).map((r) => Number(r.serial_id))

        if (serialIds.length > 0) {
          const back = await markTransferred(tx, actor, {
            serialIds,
            fromLocationId: toLocationId,
            toLocationId: fromLocationId,
            transferId: transfer.id,
          })
          if (!back.ok) throw new Error(back.error)
        }
      }

      await tx.execute(
        `UPDATE stock_transfers
            SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW()
          WHERE id = ?`,
        [reason.trim().slice(0, 190), transfer.id] as never,
      )

      return { ok: true as const }
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'The transfer could not be voided.' }
  }
}

export type TransferDrift = {
  transferId: number
  documentNumber: string | null
  productId: number
  productCode: string | null
  expected: number
  movedOut: number
  movedIn: number
}

/**
 * Posted transfer lines whose two movement halves do not match the line.
 *
 * This is the check that would catch a half-written transfer — the one failure
 * mode that breaks invariant (C) while leaving (A) intact. Reports rather than
 * repairs, like every other reconciliation here.
 */
export async function reconcileTransfers(siteId: number): Promise<TransferDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id AS transfer_id, t.document_number,
            l.product_id, l.product_code, l.qty AS expected,
            COALESCE((SELECT SUM(-m.qty_change) FROM stock_movements m
                       WHERE m.source_doc_id = t.id AND m.source = 'transfer'
                         AND m.product_id = l.product_id
                         AND m.location_id = t.from_location_id), 0) AS moved_out,
            COALESCE((SELECT SUM(m.qty_change) FROM stock_movements m
                       WHERE m.source_doc_id = t.id AND m.source = 'transfer'
                         AND m.product_id = l.product_id
                         AND m.location_id = t.to_location_id), 0)   AS moved_in
       FROM stock_transfers t
       JOIN stock_transfer_lines l ON l.transfer_id = t.id
      WHERE t.status = 'posted'
     HAVING ABS(expected - moved_out) > 0.0005 OR ABS(expected - moved_in) > 0.0005`,
  )

  return rows.map((r) => ({
    transferId: Number(r.transfer_id),
    documentNumber: (r.document_number as string | null) ?? null,
    productId: Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    expected: toNum(r.expected),
    movedOut: toNum(r.moved_out),
    movedIn: toNum(r.moved_in),
  }))
}
