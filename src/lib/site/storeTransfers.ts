import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { weightedAverageCost } from '../documentMath'
import { linkedStores } from '../storeGroups'
import { nextDocumentNumber } from './sequences'
import { recordMovement } from './stockMovements'
import { transitLocationIdTx } from './stockLocations'
import { isPeriodLocked } from './settings'
import type { Actor } from './activityLog'

/**
 * Moving stock between STORES, which means between databases.
 *
 * ── WHY THIS IS NOT stockTransfers.ts ──────────────────────────────────────
 *
 * 026 moves stock between two locations that share a database, a product row
 * and a transaction. None of that is true here. A store is a separate site with
 * its own master database and its own product ids, linked only by
 * cp2_store_groups in the control database and matched only by product CODE.
 *
 * So a store transfer is TWO documents, one in each database, pointing at each
 * other by id — and the pair can never be written atomically, because there is
 * no distributed transaction available and pretending otherwise would be worse
 * than saying so plainly.
 *
 * ── THE TRANSIT LOCATION IS WHAT KEEPS THE BOOKS TRUE ──────────────────────
 *
 * 026 said a site that genuinely needs goods in transit should model the van AS
 * a location. 101 seeds exactly that, and it is what lets every invariant
 * survive a move that takes two days:
 *
 *   DISPATCH, sender only
 *     transfer_out  -qty  from the source room
 *     transfer_in   +qty  into TRANSIT
 *     → the sender still owns the goods, and its total is unchanged. Correct:
 *       they are on its truck. (A), (B) and (C) hold with no special case.
 *
 *   RECEIVE, two commits in two databases
 *     receiver   transfer_in  +qty  into the chosen room   → its total rises
 *     sender     transfer_out -qty  out of TRANSIT         → its total falls
 *
 * Each database keeps its own invariants at every single moment. What is not
 * atomic is the PAIR, and the whole design below is about making that failure
 * mode the harmless one.
 *
 * ── THE RECEIVER COMMITS FIRST, DELIBERATELY ───────────────────────────────
 *
 * If the sender-side settle then fails, the goods are briefly counted twice
 * across the group — in the senders TRANSIT and on the receivers shelf. That is
 * visible (the sender still reads `in_transit` while the receiver names it as
 * received) and it is REPAIRABLE: settleDispatch() only fires while the
 * document is still `in_transit`, so retrying it is safe and running it twice
 * cannot double-decrement.
 *
 * The other order loses the goods outright: they leave the sender, the receiver
 * never records them, and nothing anywhere says where they went. A figure that
 * is briefly too high and heals itself beats one that is quietly too low.
 *
 * reconcileStoreTransfers() is what finds the ones that did not heal.
 *
 * ── COST MOVES HERE, UNLIKE AN INTERNAL TRANSFER ───────────────────────────
 *
 * 026 refuses to touch average_cost, because the goods are the same goods in a
 * different room. Across stores that stops being true: the receiver did not own
 * these units a moment ago, and if they land with no cost its valuation is
 * wrong from that second on. So the receiver blends the senders cost into its
 * own weighted average exactly as a GRV does, and the sender does not move its
 * average at all — goods left at cost.
 */

type Row = RowDataPacket & Record<string, unknown>

export type StoreOption = {
  siteId: number
  siteCode: string
  name: string
}

/**
 * The stores this one may send to.
 *
 * linkedStores() rather than membersOfGroup(): matching by product code only
 * makes sense between stores that actually share a product file, and it already
 * excludes members with no reachable database. A store that shares nothing is
 * in the group for other reasons and has its own unrelated product codes.
 */
export async function eligibleStores(siteId: number): Promise<StoreOption[]> {
  const members = await linkedStores(siteId)
  return members
    .filter((m) => m.siteId !== siteId)
    .map((m) => ({ siteId: m.siteId, siteCode: m.siteCode, name: m.displayName }))
}

export type StoreTransferLine = {
  id: number
  productId: number
  productCode: string
  description: string
  qty: number
  /** What the receiver counted. Null until it answers. */
  qtyReceived: number | null
  unitCostExcl: number
}

export type StoreTransfer = {
  id: number
  documentNumber: string | null
  documentDate: string
  direction: 'out' | 'in'
  peerSiteId: number | null
  peerSiteName: string | null
  peerTransferId: number | null
  peerDocumentNumber: string | null
  fromLocationId: number | null
  fromLocationCode: string | null
  toLocationId: number | null
  toLocationCode: string | null
  status: 'in_transit' | 'received' | 'cancelled'
  reference: string | null
  note: string | null
  dispatchedAt: Date | null
  receivedAt: Date | null
  cancelReason: string | null
  userName: string
  lines: StoreTransferLine[]
}

export type PostResult =
  | {
      ok: true
      id: number
      documentNumber: string
      /**
       * Set when the write SUCCEEDED but something downstream did not.
       *
       * Only receiveFromStore raises it, and only for the one case it cannot
       * roll back: the goods are on this store's shelf and the sending store
       * still has them in transit. The receipt is real and must not be undone,
       * so the caller shows this rather than an error.
       */
      warning?: string
    }
  | { ok: false; error: string }

export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/* ── Reading ─────────────────────────────────────────────────────────────── */

const SELECT_STORE_TRANSFER = `
  SELECT t.id, t.document_number, t.document_date, t.direction,
         t.peer_site_id, t.peer_site_name, t.peer_transfer_id, t.peer_document_number,
         t.from_location_id, t.to_location_id, t.status, t.reference, t.note,
         t.dispatched_at, t.received_at, t.cancel_reason, t.user_name,
         f.code AS from_code, g.code AS to_code
    FROM stock_transfers t
    LEFT JOIN stock_locations f ON f.id = t.from_location_id
    LEFT JOIN stock_locations g ON g.id = t.to_location_id
`

function mapStoreTransfer(r: Row, lines: StoreTransferLine[]): StoreTransfer {
  return {
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date).slice(0, 10),
    direction: String(r.direction) as 'out' | 'in',
    peerSiteId: r.peer_site_id === null ? null : Number(r.peer_site_id),
    peerSiteName: (r.peer_site_name as string | null) ?? null,
    peerTransferId: r.peer_transfer_id === null ? null : Number(r.peer_transfer_id),
    peerDocumentNumber: (r.peer_document_number as string | null) ?? null,
    fromLocationId: r.from_location_id === null ? null : Number(r.from_location_id),
    fromLocationCode: (r.from_code as string | null) ?? null,
    toLocationId: r.to_location_id === null ? null : Number(r.to_location_id),
    toLocationCode: (r.to_code as string | null) ?? null,
    status: String(r.status) as StoreTransfer['status'],
    reference: (r.reference as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    dispatchedAt: (r.dispatched_at as Date | null) ?? null,
    receivedAt: (r.received_at as Date | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    lines,
  }
}

async function linesOf(siteId: number, transferId: number): Promise<StoreTransferLine[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, product_id, product_code, description, qty, qty_received, unit_cost_excl
       FROM stock_transfer_lines WHERE transfer_id = ? ORDER BY line_number ASC, id ASC`,
    [transferId],
  )
  return rows.map((l) => ({
    id: Number(l.id),
    productId: Number(l.product_id),
    productCode: String(l.product_code ?? ''),
    description: String(l.description),
    qty: toNum(l.qty),
    qtyReceived: l.qty_received === null ? null : toNum(l.qty_received),
    unitCostExcl: toNum(l.unit_cost_excl),
  }))
}

export async function getStoreTransfer(
  siteId: number,
  id: number,
): Promise<StoreTransfer | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_STORE_TRANSFER} WHERE t.id = ? AND t.direction <> 'internal' LIMIT 1`,
    [id],
  )
  if (!row) return null
  return mapStoreTransfer(row, await linesOf(siteId, id))
}

/**
 * Dispatches from other stores that this one has not received yet.
 *
 * Reads every linked store's database, because the pending document lives in
 * the SENDER until the receiver acts on it. That is a handful of queries
 * against a handful of sites, and it is the only way a receiver can know
 * something is on its way — nothing has been written into its own database yet.
 *
 * A store that is unreachable is skipped rather than thrown on: one branch with
 * a dead database must not stop the others being received.
 */
export async function pendingInbound(siteId: number): Promise<StoreTransfer[]> {
  const stores = await eligibleStores(siteId)

  const results = await Promise.all(
    stores.map(async (store) => {
      try {
        const rows = await siteQuery<Row>(
          store.siteId,
          `${SELECT_STORE_TRANSFER}
            WHERE t.direction = 'out' AND t.status = 'in_transit' AND t.peer_site_id = ?
            ORDER BY t.document_date ASC, t.id ASC`,
          [siteId],
        )
        return Promise.all(
          rows.map(async (r) => {
            const transfer = mapStoreTransfer(r, await linesOf(store.siteId, Number(r.id)))
            // The sender's own row carries ITS peer (us). Rewritten here so the
            // receiver reads "from Northgate" rather than its own name.
            return { ...transfer, peerSiteId: store.siteId, peerSiteName: store.name }
          }),
        )
      } catch {
        return [] as StoreTransfer[]
      }
    }),
  )

  return results.flat()
}

/** One pending dispatch, re-read from the sender at the moment of receiving. */
export async function getInbound(
  siteId: number,
  peerSiteId: number,
  peerTransferId: number,
): Promise<StoreTransfer | null> {
  const allowed = (await eligibleStores(siteId)).find((s) => s.siteId === peerSiteId)
  if (!allowed) return null

  const row = await siteQueryOne<Row>(
    peerSiteId,
    `${SELECT_STORE_TRANSFER}
      WHERE t.id = ? AND t.direction = 'out' AND t.peer_site_id = ? LIMIT 1`,
    [peerTransferId, siteId],
  )
  if (!row) return null

  const transfer = mapStoreTransfer(row, await linesOf(peerSiteId, peerTransferId))
  return { ...transfer, peerSiteId, peerSiteName: allowed.name }
}

/**
 * The RECEIVER's copy of a dispatch this store sent, if it has one.
 *
 * The mirror of getInbound, and it exists for the repair path: when a receive
 * commits at the far end but the settle back here fails, this is how the sender
 * learns what actually arrived. Read from the receiver rather than trusted from
 * a caller, because the receiver is the only place that knows.
 *
 * Returns null on an unreachable store, which is the normal case while the
 * problem that caused the split is still happening.
 */
export async function findPeerReceipt(
  senderSiteId: number,
  receiverSiteId: number,
  senderTransferId: number,
): Promise<StoreTransfer | null> {
  const allowed = (await eligibleStores(senderSiteId)).find((s) => s.siteId === receiverSiteId)
  if (!allowed) return null

  try {
    const row = await siteQueryOne<Row>(
      receiverSiteId,
      `${SELECT_STORE_TRANSFER}
        WHERE t.direction = 'in' AND t.peer_site_id = ? AND t.peer_transfer_id = ?
        ORDER BY t.id DESC LIMIT 1`,
      [senderSiteId, senderTransferId],
    )
    if (!row) return null
    return mapStoreTransfer(row, await linesOf(receiverSiteId, Number(row.id)))
  } catch {
    return null
  }
}

/* ── Dispatch ────────────────────────────────────────────────────────────── */

export type DispatchLineInput = {
  productId: number
  productCode: string
  description: string
  qty: number
  unitCostExcl?: number
}

export type DispatchInput = {
  toSiteId: number
  fromLocationId: number
  documentDate?: string
  reference?: string | null
  note?: string | null
  lines: DispatchLineInput[]
}

export function validateDispatch(input: DispatchInput): string | null {
  if (!input.toSiteId) return 'Choose which store the stock is going to.'
  if (!input.fromLocationId) return 'Choose which location the stock is leaving.'

  const lines = input.lines.filter((l) => l.productId)
  if (lines.length === 0) return 'Add at least one product to send.'
  if (lines.some((l) => !Number.isFinite(l.qty) || l.qty <= 0)) {
    return 'Every line needs a quantity greater than zero.'
  }
  // The far end joins on CODE, because ids mean nothing across databases. A
  // line without one could never be matched, so it is refused here rather than
  // arriving as an unidentifiable row in another store.
  if (lines.some((l) => !l.productCode?.trim())) {
    return 'Every product needs a code — the receiving store matches on it.'
  }
  return null
}

/**
 * Sends stock to another store: out of the source room, into TRANSIT.
 *
 * Only the SENDER is written. Nothing is put into the other store's database,
 * because the goods have not arrived — the receiver creates its own document
 * when it confirms what turned up.
 */
export async function dispatchToStore(
  siteId: number,
  actor: Actor,
  input: DispatchInput,
): Promise<PostResult> {
  const invalid = validateDispatch(input)
  if (invalid) return { ok: false, error: invalid }

  const destination = (await eligibleStores(siteId)).find((s) => s.siteId === input.toSiteId)
  if (!destination) {
    return {
      ok: false,
      error: 'That store is not linked to this one, or it does not share a product file.',
    }
  }

  const docDate = input.documentDate ?? todayIso()
  if (await isPeriodLocked(siteId, docDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  const source = await siteQueryOne<Row>(
    siteId,
    'SELECT id, name, is_active, is_transit FROM stock_locations WHERE id = ?',
    [input.fromLocationId],
  )
  if (!source) return { ok: false, error: 'That location no longer exists.' }
  if (!source.is_active) {
    return {
      ok: false,
      error: `${String(source.name)} is deactivated. Activate it before sending stock from it.`,
    }
  }
  if (source.is_transit) {
    return {
      ok: false,
      error: 'Goods already in transit cannot be dispatched again. Receive them first.',
    }
  }

  const lines = input.lines.filter((l) => l.productId)

  try {
    return await siteTransaction(siteId, async (tx) => {
      const transitId = await transitLocationIdTx(tx)

      // Every source pile is locked and checked BEFORE anything is written, so
      // a refusal leaves no half-built document behind. Product order, so two
      // dispatches over the same goods queue rather than deadlock.
      const ordered = [...lines].sort((a, b) => a.productId - b.productId)

      for (const line of ordered) {
        const [rows] = await tx.execute(
          `SELECT COALESCE(pls.stock_on_hand, 0) AS on_hand, p.code, p.product_type, p.has_variants
             FROM products p
             LEFT JOIN product_location_stock pls
                    ON pls.product_id = p.id AND pls.location_id = ?
            WHERE p.id = ?
            FOR UPDATE`,
          [input.fromLocationId, line.productId] as never,
        )
        const row = (rows as Row[])[0]
        if (!row) return { ok: false as const, error: 'A product on this transfer no longer exists.' }

        if (Number(row.has_variants) === 1) {
          return {
            ok: false as const,
            error: `${String(row.code)} has variants — send the variants instead.`,
          }
        }

        /*
         * A serial-tracked product cannot cross databases yet.
         *
         * Its units live in THIS site's product_serials, and moving them means
         * writing them off here and creating them there — a second paired
         * write, in the same two-database transaction that already cannot be
         * atomic. Refusing plainly beats a half-migrated unit that neither
         * store can account for, and serial reconciliation would report it
         * forever.
         */
        if (String(row.product_type) === 'serial') {
          return {
            ok: false as const,
            error: `${String(row.code)} is serial-tracked, which cannot be sent between stores yet. Move it as a normal product only once serial handover is built.`,
          }
        }

        const available = toNum(row.on_hand)
        if (available < round(line.qty, 3)) {
          return {
            ok: false as const,
            error: `${String(row.code)} has only ${available} in ${String(source.name)} — cannot send ${line.qty}.`,
          }
        }
      }

      const documentNumber = await nextDocumentNumber(tx, 'stock_transfer')

      const [res] = await tx.execute(
        `INSERT INTO stock_transfers
           (document_number, document_date, direction, peer_site_id, peer_site_name,
            from_location_id, to_location_id, status, reference, note,
            posted_at, dispatched_at, user_id, user_name)
         VALUES (?,?, 'out', ?,?, ?,?, 'in_transit', ?,?, NOW(), NOW(), ?,?)`,
        [
          documentNumber,
          docDate,
          input.toSiteId,
          destination.name.slice(0, 190),
          input.fromLocationId,
          transitId,
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
            line.productCode.trim().slice(0, 40),
            line.description.trim().slice(0, 190),
            qty.toFixed(3),
            cost.toFixed(4),
          ] as never,
        )

        // Both halves, always — out of the room and onto the truck. Out first,
        // so a failure cannot leave stock duplicated into transit.
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: input.fromLocationId,
          movementType: 'transfer_out',
          qtyChange: -qty,
          unitCostExcl: cost,
          source: 'store_transfer',
          sourceDocId: transferId,
          note: `To ${destination.name} on ${documentNumber}`.slice(0, 190),
        })

        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: transitId,
          movementType: 'transfer_in',
          qtyChange: qty,
          unitCostExcl: cost,
          source: 'store_transfer',
          sourceDocId: transferId,
          note: `In transit to ${destination.name} on ${documentNumber}`.slice(0, 190),
        })
      }

      return { ok: true as const, id: transferId, documentNumber }
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The dispatch could not be posted.',
    }
  }
}

/* ── Receive ─────────────────────────────────────────────────────────────── */

export type ReceiveInput = {
  peerSiteId: number
  peerTransferId: number
  toLocationId: number
  /** Per sender line id, what actually turned up. Absent means "all of it". */
  received?: { lineId: number; qty: number }[]
  note?: string | null
}

/**
 * Confirms what arrived, in the RECEIVER.
 *
 * Two commits, receiver first — see the module header for why that order and
 * not the other. The sender-side settle is idempotent, so a failure between the
 * two leaves a repairable state rather than lost goods.
 */
export async function receiveFromStore(
  siteId: number,
  actor: Actor,
  input: ReceiveInput,
): Promise<PostResult> {
  if (!input.toLocationId) return { ok: false, error: 'Choose where the stock is being put.' }

  const inbound = await getInbound(siteId, input.peerSiteId, input.peerTransferId)
  if (!inbound) {
    return { ok: false, error: 'That dispatch no longer exists, or it was not sent to this store.' }
  }
  if (inbound.status === 'received') {
    return { ok: false, error: 'That dispatch has already been received.' }
  }
  if (inbound.status !== 'in_transit') {
    return { ok: false, error: 'That dispatch was cancelled by the sending store.' }
  }

  const docDate = todayIso()
  if (await isPeriodLocked(siteId, docDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }

  const destination = await siteQueryOne<Row>(
    siteId,
    'SELECT id, name, is_active, is_transit FROM stock_locations WHERE id = ?',
    [input.toLocationId],
  )
  if (!destination) return { ok: false, error: 'That location no longer exists.' }
  if (!destination.is_active) {
    return {
      ok: false,
      error: `${String(destination.name)} is deactivated. Activate it before receiving stock into it.`,
    }
  }
  if (destination.is_transit) {
    return { ok: false, error: 'Stock cannot be received into the in-transit location.' }
  }

  const receivedFor = new Map((input.received ?? []).map((r) => [r.lineId, round(r.qty, 3)]))

  // Match every line to a local product by CODE before writing anything, so an
  // unknown code is refused by name instead of failing halfway through.
  const resolved: {
    senderLineId: number
    productCode: string
    description: string
    localProductId: number
    qtyDispatched: number
    qtyReceived: number
    unitCostExcl: number
  }[] = []

  for (const line of inbound.lines) {
    const qty = receivedFor.has(line.id) ? (receivedFor.get(line.id) as number) : line.qty
    if (!Number.isFinite(qty) || qty < 0) {
      return { ok: false, error: `${line.productCode}: the quantity received cannot be negative.` }
    }
    if (round(qty, 3) > round(line.qty, 3)) {
      return {
        ok: false,
        error: `${line.productCode}: ${qty} cannot be received when only ${line.qty} was sent.`,
      }
    }

    const local = await siteQueryOne<Row>(
      siteId,
      'SELECT id, product_type, has_variants FROM products WHERE code = ? LIMIT 1',
      [line.productCode],
    )
    if (!local) {
      return {
        ok: false,
        error: `This store has no product with the code ${line.productCode}. Create it, or ask the sending store to check the code.`,
      }
    }
    if (Number(local.has_variants) === 1) {
      return {
        ok: false,
        error: `${line.productCode} has variants in this store, so stock cannot be received onto it.`,
      }
    }

    resolved.push({
      senderLineId: line.id,
      productCode: line.productCode,
      description: line.description,
      localProductId: Number(local.id),
      qtyDispatched: line.qty,
      qtyReceived: round(qty, 3),
      unitCostExcl: line.unitCostExcl,
    })
  }

  if (resolved.every((r) => r.qtyReceived === 0)) {
    return {
      ok: false,
      error: 'Nothing was received. If none of it arrived, ask the sending store to cancel the dispatch instead.',
    }
  }

  /* ── Commit one: the receiver takes the goods ───────────────────────── */
  let localId = 0
  let localNumber = ''
  try {
    const created = await siteTransaction(siteId, async (tx) => {
      const documentNumber = await nextDocumentNumber(tx, 'stock_transfer')

      const [res] = await tx.execute(
        `INSERT INTO stock_transfers
           (document_number, document_date, direction, peer_site_id, peer_site_name,
            peer_transfer_id, peer_document_number,
            from_location_id, to_location_id, status, reference, note,
            posted_at, received_at, user_id, user_name)
         VALUES (?,?, 'in', ?,?, ?,?, NULL, ?, 'received', ?,?, NOW(), NOW(), ?,?)`,
        [
          documentNumber,
          docDate,
          input.peerSiteId,
          (inbound.peerSiteName ?? '').slice(0, 190),
          input.peerTransferId,
          inbound.documentNumber,
          input.toLocationId,
          inbound.reference?.slice(0, 60) ?? null,
          input.note?.trim()?.slice(0, 400) || inbound.note?.slice(0, 400) || null,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
      const id = (res as { insertId: number }).insertId

      const ordered = [...resolved].sort((a, b) => a.localProductId - b.localProductId)

      for (const [index, line] of ordered.entries()) {
        await tx.execute(
          `INSERT INTO stock_transfer_lines
             (transfer_id, line_number, product_id, product_code, description,
              qty, qty_received, unit_cost_excl)
           VALUES (?,?,?,?,?,?,?,?)`,
          [
            id,
            index + 1,
            line.localProductId,
            line.productCode,
            line.description,
            line.qtyDispatched.toFixed(3),
            line.qtyReceived.toFixed(3),
            line.unitCostExcl.toFixed(4),
          ] as never,
        )

        // A line that arrived empty is recorded and moves nothing — the loss is
        // the senders, and it is cleared out of ITS transit pile by the settle.
        if (line.qtyReceived === 0) continue

        // The cost blend, and the reason this is not an internal transfer: the
        // receiver did not own these units a moment ago. Read FOR UPDATE so two
        // receipts of the same product cannot both blend against a stale figure.
        const [before] = await tx.execute(
          `SELECT stock_on_hand, COALESCE(NULLIF(average_cost, 0), last_cost, 0) AS cost
             FROM products WHERE id = ? FOR UPDATE`,
          [line.localProductId] as never,
        )
        const beforeRow = (before as Row[])[0]

        await recordMovement(tx, actor, {
          productId: line.localProductId,
          locationId: input.toLocationId,
          movementType: 'transfer_in',
          qtyChange: line.qtyReceived,
          unitCostExcl: line.unitCostExcl,
          source: 'store_transfer',
          sourceDocId: id,
          note: `From ${inbound.peerSiteName ?? 'another store'} on ${inbound.documentNumber ?? ''}`.slice(0, 190),
        })

        const newAverage = weightedAverageCost({
          existingQty: toNum(beforeRow?.stock_on_hand),
          existingCostExcl: toNum(beforeRow?.cost),
          receivedQty: line.qtyReceived,
          receivedCostExcl: line.unitCostExcl,
        })

        await tx.execute(
          'UPDATE products SET average_cost = ?, last_cost = ? WHERE id = ?',
          [newAverage.toFixed(4), line.unitCostExcl.toFixed(4), line.localProductId] as never,
        )
      }

      return { id, documentNumber }
    })
    localId = created.id
    localNumber = created.documentNumber
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The stock could not be received.',
    }
  }

  /* ── Commit two: the sender lets the goods go ───────────────────────── */
  const settled = await settleDispatch(input.peerSiteId, actor, {
    transferId: input.peerTransferId,
    receiverSiteId: siteId,
    receiverTransferId: localId,
    receiverDocumentNumber: localNumber,
    received: resolved.map((r) => ({ productCode: r.productCode, qty: r.qtyReceived })),
  })

  if (!settled.ok) {
    /*
     * The goods are on the shelf and the sender still thinks they are on the
     * road. Reported rather than rolled back: unwinding a committed receipt
     * would take stock the receiver can physically see, and settleDispatch is
     * idempotent, so the honest answer is to say what happened and let it be
     * retried. reconcileStoreTransfers() lists exactly this state.
     */
    return {
      ok: true,
      id: localId,
      documentNumber: localNumber,
      warning: `The stock is booked in here, but ${inbound.peerSiteName ?? 'the sending store'} could not be updated (${settled.error}). Until it is, both stores count these goods. It will settle itself when that store is reachable — the stock reconciliation lists it meanwhile.`,
    }
  }

  return { ok: true, id: localId, documentNumber: localNumber }
}

/* ── The sender side of a receipt ────────────────────────────────────────── */

export type SettleInput = {
  transferId: number
  receiverSiteId: number
  receiverTransferId: number
  receiverDocumentNumber: string
  /**
   * Keyed by product CODE, not line id.
   *
   * The retry path reads what arrived from the RECEIVER's document, whose line
   * ids are its own and mean nothing here. Code is the only key both databases
   * share — the same reasoning the whole module rests on — so both the direct
   * path and the retry can speak it.
   */
  received: { productCode: string; qty: number }[]
}

/**
 * Clears a dispatch out of the sender's TRANSIT pile.
 *
 * IDEMPOTENT, and that is the whole point. It claims the document with
 * `WHERE status = 'in_transit'` and does nothing at all if that claim fails, so
 * a retry after a half-completed receive cannot decrement twice. This is what
 * makes receiver-commits-first a safe order rather than a gamble.
 *
 * ── A SHORT RECEIPT IS A LOSS, NOT A TRANSFER ──────────────────────────────
 *
 * What arrived leaves TRANSIT as `transfer_out` — it genuinely transferred.
 * What did not arrive leaves TRANSIT as an `adjustment`, because nothing
 * received it: the goods left this store and reached nobody, which is a
 * write-off the sender wears. Both come out of TRANSIT, so the pile empties and
 * invariant (C) holds. Recording the shortfall as a transfer would claim the
 * other store has stock it never got.
 */
export async function settleDispatch(
  senderSiteId: number,
  actor: Actor,
  input: SettleInput,
): Promise<{ ok: true; settled: boolean } | { ok: false; error: string }> {
  const receivedFor = new Map(input.received.map((r) => [r.productCode, round(r.qty, 3)]))

  try {
    return await siteTransaction(senderSiteId, async (tx) => {
      const [claim] = await tx.execute(
        `UPDATE stock_transfers
            SET status = 'received', received_at = NOW(),
                peer_transfer_id = ?, peer_document_number = ?
          WHERE id = ? AND direction = 'out' AND status = 'in_transit'`,
        [
          input.receiverTransferId,
          input.receiverDocumentNumber,
          input.transferId,
        ] as never,
      )
      // Already settled, or cancelled out from under us. Either way there is
      // nothing to do and saying so is not an error.
      if ((claim as { affectedRows: number }).affectedRows === 0) {
        return { ok: true as const, settled: false }
      }

      const transitId = await transitLocationIdTx(tx)

      const [lineRows] = await tx.execute(
        `SELECT id, product_id, product_code, qty, unit_cost_excl
           FROM stock_transfer_lines WHERE transfer_id = ? ORDER BY product_id ASC`,
        [input.transferId] as never,
      )

      for (const raw of lineRows as Row[]) {
        const lineId = Number(raw.id)
        const productId = Number(raw.product_id)
        const productCode = String(raw.product_code ?? '')
        const dispatched = toNum(raw.qty)
        const cost = toNum(raw.unit_cost_excl)
        // Absent means the receiver did not mention this code at all, which can
        // only happen on a malformed retry. Treating it as fully received is
        // the safe reading: it clears TRANSIT without inventing a write-off.
        const arrived = receivedFor.has(productCode)
          ? (receivedFor.get(productCode) as number)
          : dispatched
        const lost = round(dispatched - arrived, 3)

        await tx.execute('UPDATE stock_transfer_lines SET qty_received = ? WHERE id = ?', [
          arrived.toFixed(3),
          lineId,
        ] as never)

        if (arrived > 0) {
          await recordMovement(tx, actor, {
            productId,
            locationId: transitId,
            movementType: 'transfer_out',
            qtyChange: -arrived,
            unitCostExcl: cost,
            source: 'store_transfer',
            sourceDocId: input.transferId,
            sourceLineId: lineId,
            note: `Received on ${input.receiverDocumentNumber}`.slice(0, 190),
          })
        }

        if (lost > 0) {
          await recordMovement(tx, actor, {
            productId,
            locationId: transitId,
            movementType: 'adjustment',
            qtyChange: -lost,
            unitCostExcl: cost,
            source: 'transfer_shortfall',
            sourceDocId: input.transferId,
            sourceLineId: lineId,
            note: `Short on ${input.receiverDocumentNumber} — sent ${dispatched}, arrived ${arrived}`.slice(0, 190),
          })
        }
      }

      return { ok: true as const, settled: true }
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The sending store could not be settled.',
    }
  }
}

/* ── Recall ──────────────────────────────────────────────────────────────── */

/**
 * Pulls a dispatch back before anyone receives it.
 *
 * Writes the exact inverse of the dispatch — out of TRANSIT, back into the room
 * it left — rather than deleting the movements. The goods genuinely went onto a
 * truck and came back off it.
 *
 * Claims the document the same way settleDispatch does, so a cancel racing a
 * receive cannot both win: whichever claims `in_transit` first is the one that
 * happens, and the loser reports that the other already did.
 */
export async function cancelDispatch(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!reason.trim()) return { ok: false, error: 'A reason is required to recall a dispatch.' }

  const transfer = await getStoreTransfer(siteId, id)
  if (!transfer) return { ok: false, error: 'That dispatch no longer exists.' }
  if (transfer.direction !== 'out') {
    return { ok: false, error: 'Only a dispatch from this store can be recalled.' }
  }
  if (transfer.status === 'received') {
    return {
      ok: false,
      error: 'That dispatch has already been received by the other store. Ask them to send it back.',
    }
  }
  if (transfer.status === 'cancelled') return { ok: false, error: 'That dispatch is already recalled.' }

  if (await isPeriodLocked(siteId, transfer.documentDate)) {
    return { ok: false, error: 'That VAT period is locked.' }
  }
  if (transfer.fromLocationId === null) {
    return { ok: false, error: 'That dispatch has no source location to return the stock to.' }
  }
  const sourceLocationId = transfer.fromLocationId

  try {
    return await siteTransaction(siteId, async (tx) => {
      const [claim] = await tx.execute(
        `UPDATE stock_transfers
            SET status = 'cancelled', cancel_reason = ?, cancelled_at = NOW()
          WHERE id = ? AND direction = 'out' AND status = 'in_transit'`,
        [reason.trim().slice(0, 190), id] as never,
      )
      if ((claim as { affectedRows: number }).affectedRows === 0) {
        return {
          ok: false as const,
          error: 'That dispatch was received or recalled a moment ago. Reload to see where it stands.',
        }
      }

      const transitId = await transitLocationIdTx(tx)

      for (const line of transfer.lines) {
        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: transitId,
          movementType: 'transfer_out',
          qtyChange: -line.qty,
          unitCostExcl: line.unitCostExcl,
          source: 'store_transfer_void',
          sourceDocId: transfer.id,
          note: `Recall of ${transfer.documentNumber ?? `#${transfer.id}`}`.slice(0, 190),
        })

        await recordMovement(tx, actor, {
          productId: line.productId,
          locationId: sourceLocationId,
          movementType: 'transfer_in',
          qtyChange: line.qty,
          unitCostExcl: line.unitCostExcl,
          source: 'store_transfer_void',
          sourceDocId: transfer.id,
          note: `Recall of ${transfer.documentNumber ?? `#${transfer.id}`}`.slice(0, 190),
        })
      }

      return { ok: true as const }
    })
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'The dispatch could not be recalled.',
    }
  }
}

/* ── Reconciliation ──────────────────────────────────────────────────────── */

export type StoreTransferDrift = {
  transferId: number
  documentNumber: string | null
  peerSiteName: string | null
  dispatchedAt: Date | null
  totalQty: number
  /**
   * Which of the two shapes this is, because they need very different
   * responses and only one of them is a BUG.
   *
   *   stale      still on the road. Chase the truck. Nothing is wrong.
   *   unsettled  the far end already has these goods and this store still
   *              holds them. Counted twice across the group until settled.
   *
   * The reconciliation screen keys its alarm off this: a lorry running late
   * must not turn the page red.
   */
  kind: 'stale' | 'unsettled'
  /** What is wrong, in a sentence a person can act on. */
  problem: string
}

/**
 * Store transfers that did not complete.
 *
 * TWO shapes, and the second is the one this whole module is arranged around:
 *
 *   1. A dispatch that has sat in transit for a long time. Usually a truck that
 *      has not arrived, sometimes a receiver that forgot. Not an error, but the
 *      goods are on this store's balance sheet and somebody should know.
 *
 *   2. A dispatch this store still calls `in_transit` that the RECEIVER has
 *      already recorded as received. That is the split-brain window the header
 *      describes, and it means settleDispatch never ran — the goods are counted
 *      twice across the group until it does.
 *
 * Reports rather than repairs, like every other reconciliation here. The repair
 * is settleDispatch(), which is safe to run again precisely because it claims
 * the document before it moves anything.
 */
export async function reconcileStoreTransfers(
  siteId: number,
  staleAfterDays = 7,
): Promise<StoreTransferDrift[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT t.id, t.document_number, t.peer_site_id, t.peer_site_name, t.dispatched_at,
            COALESCE((SELECT SUM(l.qty) FROM stock_transfer_lines l WHERE l.transfer_id = t.id), 0) AS total_qty,
            DATEDIFF(NOW(), t.dispatched_at) AS days_out
       FROM stock_transfers t
      WHERE t.direction = 'out' AND t.status = 'in_transit'
      ORDER BY t.dispatched_at ASC`,
  )

  const drift: StoreTransferDrift[] = []

  for (const r of rows) {
    const transferId = Number(r.id)
    const peerSiteId = r.peer_site_id === null ? null : Number(r.peer_site_id)
    const daysOut = Number(r.days_out ?? 0)

    // The dangerous one first: does the far end already have these goods?
    let claimedByPeer = false
    if (peerSiteId) {
      try {
        const match = await siteQueryOne<Row>(
          peerSiteId,
          `SELECT id FROM stock_transfers
            WHERE direction = 'in' AND peer_site_id = ? AND peer_transfer_id = ?
              AND status = 'received' LIMIT 1`,
          [siteId, transferId],
        )
        claimedByPeer = !!match
      } catch {
        // Unreachable store: the staleness check below still applies, and a
        // dead database is not evidence either way about what it holds.
        claimedByPeer = false
      }
    }

    if (claimedByPeer) {
      drift.push({
        transferId,
        documentNumber: (r.document_number as string | null) ?? null,
        peerSiteName: (r.peer_site_name as string | null) ?? null,
        dispatchedAt: (r.dispatched_at as Date | null) ?? null,
        totalQty: toNum(r.total_qty),
        kind: 'unsettled',
        problem:
          'The receiving store has already taken these goods, but this store still holds them in transit. They are counted twice until this dispatch is settled.',
      })
      continue
    }

    if (daysOut >= staleAfterDays) {
      drift.push({
        transferId,
        documentNumber: (r.document_number as string | null) ?? null,
        peerSiteName: (r.peer_site_name as string | null) ?? null,
        dispatchedAt: (r.dispatched_at as Date | null) ?? null,
        totalQty: toNum(r.total_qty),
        kind: 'stale',
        problem: `Dispatched ${daysOut} days ago and still not received. The goods are on this store's books until the other store confirms them.`,
      })
    }
  }

  return drift
}
