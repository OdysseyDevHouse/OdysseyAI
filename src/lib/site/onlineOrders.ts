import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteExecute, siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { saveDraft, type LineInput } from './salesDocuments'
import { getSetting } from './settings'
import { getOnlineSettings, listOrderStatuses, type OrderStatus } from './onlineStore'

/**
 * Online orders — from a public submission to a sale.
 *
 * ── AN ORDER IS A REQUEST; THE SALE IS THE TRANSACTION ───────────────────
 *
 * Accepting an order writes an ordinary DRAFT sales_document, which the till
 * then finalises exactly as it would a walk-in. From that moment stock,
 * cash-up, VAT and every report treat it as a normal sale, because it IS one.
 * There is no parallel "online" bookkeeping anywhere, and that is the whole
 * design: a second set of books that only online orders use is a second set of
 * books that only online orders get wrong.
 *
 * ── ACCEPTANCE RE-PRICES ─────────────────────────────────────────────────
 *
 * The submitted basket is a request that may be hours old. Between then and
 * now a price could have changed or a product been withdrawn, so the sale is
 * written from TODAY's product file rather than copied from the order. The
 * original request survives in online_order_lines, so any difference is
 * visible instead of silently applied — which is what lets staff ring the
 * customer before the surprise happens at the counter.
 *
 * ── NOTHING HERE TOUCHES MONEY ───────────────────────────────────────────
 *
 * Every order is unpaid: the storefront runs pay-on-collection until a
 * verified gateway callback exists (see 034_online_store.sql). So acceptance
 * only ever writes a DRAFT, and cancelling only ever discards one. The paid
 * path — where an order invoices itself and cancelling has to raise a credit
 * note — arrives with payments, and deliberately does not exist yet.
 */

type Row = RowDataPacket & Record<string, unknown>

export type OnlineOrderLine = {
  id: number
  lineNumber: number
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  unitPriceIncl: number
  lineTotalIncl: number
  lineNote: string
}

export type OnlineOrder = {
  id: number
  orderNumber: string
  statusId: number
  statusName: string
  statusTone: OrderStatus['tone']
  statusRole: OrderStatus['role']
  fulfilment: 'collect' | 'deliver'
  /** The sale this became, once accepted. Null while it is still a request. */
  documentId: number | null
  documentNumber: string | null
  documentStatus: string | null
  customerId: number | null
  contactName: string
  contactPhone: string
  contactEmail: string
  deliveryLine1: string
  deliveryLine2: string
  deliverySuburb: string
  deliveryPostcode: string
  deliveryNotes: string
  deliveryFeeIncl: number
  zoneId: number | null
  totalIncl: number
  requestedFor: Date | null
  customerNote: string
  declineReason: string
  isArchived: boolean
  placedAt: Date
  lineCount: number
}

export type OnlineOrderDetail = OnlineOrder & { lines: OnlineOrderLine[] }

/** A line whose price or availability moved between order and acceptance. */
export type Repricing = {
  description: string
  /** What the shopper was shown. */
  wasIncl: number
  /** What it costs today. Null when the product is no longer sellable. */
  nowIncl: number | null
  reason: 'price_changed' | 'unavailable'
}

/** Matches the shape every other module here returns from a mutation. */
export type ActionResult = { ok: true } | { ok: false; error: string }

/* ── Reading ──────────────────────────────────────────────────────────────── */

const ORDER_COLUMNS = `
  o.*, s.name AS status_name, s.tone AS status_tone, s.role AS status_role,
  d.document_number, d.status AS document_status,
  (SELECT COUNT(*) FROM online_order_lines l WHERE l.order_id = o.id) AS line_count
`

function mapOrder(r: Row): OnlineOrder {
  return {
    id: Number(r.id),
    orderNumber: String(r.order_number),
    statusId: Number(r.status_id),
    statusName: String(r.status_name ?? ''),
    statusTone: String(r.status_tone ?? 'neutral') as OrderStatus['tone'],
    statusRole: String(r.status_role ?? '') as OrderStatus['role'],
    fulfilment: String(r.fulfilment) as 'collect' | 'deliver',
    documentId: r.document_id === null ? null : Number(r.document_id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentStatus: (r.document_status as string | null) ?? null,
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    contactName: String(r.contact_name ?? ''),
    contactPhone: String(r.contact_phone ?? ''),
    contactEmail: String(r.contact_email ?? ''),
    deliveryLine1: String(r.delivery_line1 ?? ''),
    deliveryLine2: String(r.delivery_line2 ?? ''),
    deliverySuburb: String(r.delivery_suburb ?? ''),
    deliveryPostcode: String(r.delivery_postcode ?? ''),
    deliveryNotes: String(r.delivery_notes ?? ''),
    deliveryFeeIncl: toNum(r.delivery_fee_incl),
    zoneId: r.zone_id === null ? null : Number(r.zone_id),
    totalIncl: toNum(r.total_incl),
    requestedFor: r.requested_for instanceof Date ? r.requested_for : null,
    customerNote: String(r.customer_note ?? ''),
    declineReason: String(r.decline_reason ?? ''),
    isArchived: !!r.is_archived,
    placedAt: r.placed_at instanceof Date ? r.placed_at : new Date(0),
    lineCount: Number(r.line_count ?? 0),
  }
}

export type OrderListOptions = {
  /** Omit for the live queue; pass true for the archive. */
  archived?: boolean
  statusId?: number
  search?: string
  limit?: number
}

export async function listOrders(
  siteId: number,
  options: OrderListOptions = {},
): Promise<OnlineOrder[]> {
  const where: string[] = ['o.is_archived = ?']
  const params: unknown[] = [options.archived ? 1 : 0]

  if (options.statusId) {
    where.push('o.status_id = ?')
    params.push(options.statusId)
  }
  if (options.search?.trim()) {
    const term = `%${options.search.trim()}%`
    where.push('(o.order_number LIKE ? OR o.contact_name LIKE ? OR o.contact_phone LIKE ?)')
    params.push(term, term, term)
  }

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500)

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT ${ORDER_COLUMNS}
       FROM online_orders o
       JOIN online_order_statuses s ON s.id = o.status_id
       LEFT JOIN sales_documents d  ON d.id = o.document_id
      WHERE ${where.join(' AND ')}
      -- Oldest first: a queue is worked from the front, and the order that has
      -- been waiting longest is the one a customer is standing around for.
      ORDER BY o.placed_at
      LIMIT ${limit}`,
    params,
  )
  return rows.map(mapOrder)
}

export async function getOrder(siteId: number, id: number): Promise<OnlineOrderDetail | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT ${ORDER_COLUMNS}
       FROM online_orders o
       JOIN online_order_statuses s ON s.id = o.status_id
       LEFT JOIN sales_documents d  ON d.id = o.document_id
      WHERE o.id = ?`,
    [id],
  )
  if (!row) return null

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT * FROM online_order_lines WHERE order_id = ? ORDER BY line_number, id`,
    [id],
  )

  return {
    ...mapOrder(row),
    lines: lines.map((l) => ({
      id: Number(l.id),
      lineNumber: Number(l.line_number),
      productId: l.product_id === null ? null : Number(l.product_id),
      productCode: (l.product_code as string | null) ?? null,
      description: String(l.description),
      qty: toNum(l.qty),
      unitPriceIncl: toNum(l.unit_price_incl),
      lineTotalIncl: toNum(l.line_total_incl),
      lineNote: String(l.line_note ?? ''),
    })),
  }
}

/** How many orders sit in each status — the queue's tab counts. */
export async function orderCounts(siteId: number): Promise<Map<number, number>> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT status_id, COUNT(*) AS n
       FROM online_orders WHERE is_archived = 0 GROUP BY status_id`,
  )
  return new Map(rows.map((r) => [Number(r.status_id), Number(r.n)]))
}

/* ── The pipeline ─────────────────────────────────────────────────────────── */

function roleStatus(statuses: OrderStatus[], role: OrderStatus['role']): OrderStatus | null {
  return statuses.find((s) => s.role === role) ?? null
}

/**
 * The step after this one, in the order the owner arranged them.
 *
 * 'dispatched' is skipped for a collection — it only means anything to a store
 * that delivers, and offering "Out for delivery" on an order the customer is
 * coming to fetch is how a queue stops being trusted. Cancelled is never a
 * "next": it is a decision, reached by its own button.
 */
export function nextStatus(
  statuses: OrderStatus[],
  current: OrderStatus,
  fulfilment: 'collect' | 'deliver',
): OrderStatus | null {
  return (
    statuses.find(
      (s) =>
        s.isActive &&
        s.sortOrder > current.sortOrder &&
        s.role !== 'cancelled' &&
        !(s.role === 'dispatched' && fulfilment === 'collect'),
    ) ?? null
  )
}

/* ── Acceptance ───────────────────────────────────────────────────────────── */

/**
 * Today's price, VAT and cost for the products on an order.
 *
 * Reads the same figures the till reads, through the site's configured price
 * structure and cost basis, so a sale raised from an order is priced
 * identically to the same basket rung up at the counter.
 */
async function currentPricing(
  siteId: number,
  productIds: number[],
  priceStructureId: number | null,
): Promise<Map<number, { priceIncl: number; vatRatePct: number; costExcl: number; departmentId: number | null; description: string }>> {
  if (productIds.length === 0) return new Map()

  const costBasis = await getSetting(siteId, 'cost_basis')
  const costColumn = costBasis === 'last' ? 'p.last_cost' : 'p.average_cost'
  const placeholders = productIds.map(() => '?').join(',')

  // NULL on the settings row means "whatever a walk-in pays", which is the
  // DEFAULT structure — not "no structure". Resolving it here rather than
  // leaving the join to match nothing: a missed join produced a silent zero,
  // and a sale written at R0.00 is the exact failure re-pricing exists to stop.
  const structureId =
    priceStructureId ??
    Number(
      (
        await siteQueryOne<Row>(
          siteId,
          `SELECT id FROM price_structures WHERE is_default = 1 ORDER BY id LIMIT 1`,
        )
      )?.id ?? 0,
    )

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.description, p.department_id,
            pp.selling_price_incl AS price_incl,
            COALESCE(v.rate, 0)   AS vat_rate,
            ${costColumn}         AS cost_excl
       FROM products p
       LEFT JOIN product_prices pp
              ON pp.product_id = p.id AND pp.price_structure_id = ?
       LEFT JOIN vat_rates v ON v.id = p.selling_vat_rate_id
      WHERE p.id IN (${placeholders})
        -- An archived product is no longer sellable, so it must not silently
        -- reappear on a sale raised from an old basket.
        AND p.is_archived = 0`,
    [structureId, ...productIds],
  )

  return new Map(
    rows
      // NOT COALESCEd to zero. A product with no price in this structure has no
      // sellable price at all, so it is dropped here and reported to staff as
      // unavailable — the same treatment as a withdrawn product.
      .filter((r) => r.price_incl !== null)
      .map((r) => [
        Number(r.id),
        {
          priceIncl: toNum(r.price_incl),
          vatRatePct: toNum(r.vat_rate),
          costExcl: toNum(r.cost_excl),
          departmentId: r.department_id === null ? null : Number(r.department_id),
          description: String(r.description),
        },
      ]),
  )
}

export type AcceptResult =
  | { ok: true; documentId: number; repriced: Repricing[]; alreadyAccepted: boolean }
  | { ok: false; error: string }

/**
 * Accept an order: re-price it against today's product file, write a draft
 * sale, and move it to the next step in the store's pipeline.
 *
 * IDEMPOTENT. An order that already has a sale is only acknowledged — the
 * status still moves, but no second sale is written. That covers a
 * double-click and, later, the paid order that invoiced itself, where "accept"
 * means "seen" rather than "make me a sale".
 */
export async function acceptOrder(
  siteId: number,
  orderId: number,
  actor: { userId: number; userName: string },
): Promise<AcceptResult> {
  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }
  if (order.isArchived) return { ok: false, error: 'That order has been archived.' }

  const statuses = await listOrderStatuses(siteId)
  const current = statuses.find((s) => s.id === order.statusId)
  if (!current) return { ok: false, error: 'That order is in an unknown status.' }

  const landing =
    nextStatus(statuses, current, order.fulfilment) ?? roleStatus(statuses, 'completed')
  if (!landing) {
    return { ok: false, error: 'Your pipeline has no step to move this order to.' }
  }

  // Already a sale: acknowledge only. The status must still move, or an order
  // would sit at the top of the queue for ever with a button that does nothing.
  if (order.documentId) {
    if (current.role === 'new') {
      await siteExecute(siteId, `UPDATE online_orders SET status_id = ? WHERE id = ?`, [
        landing.id,
        orderId,
      ])
    }
    return { ok: true, documentId: order.documentId, repriced: [], alreadyAccepted: true }
  }

  if (current.role === 'cancelled') {
    return { ok: false, error: 'That order was cancelled.' }
  }
  if (order.lines.length === 0) {
    return { ok: false, error: 'That order has no items.' }
  }

  const settings = await getOnlineSettings(siteId)
  const productIds = order.lines
    .map((l) => l.productId)
    .filter((id): id is number => id !== null)
  const pricing = await currentPricing(siteId, productIds, settings.priceStructureId)

  const repriced: Repricing[] = []
  const saleLines: LineInput[] = []

  for (const line of order.lines) {
    const now = line.productId === null ? undefined : pricing.get(line.productId)

    // A free-text line, a product that has since been archived, or one with no
    // price in this structure. Either way there is no current price to sell it
    // at, so it is reported and dropped rather than guessed at.
    //
    // A zero price counts as no price: giving stock away is never what an
    // unpriced product meant, and a R0.00 line on a real invoice is how a
    // shop finds out about a data problem far too late.
    if (!now || now.priceIncl <= 0) {
      repriced.push({
        description: line.description,
        wasIncl: line.unitPriceIncl,
        nowIncl: null,
        reason: 'unavailable',
      })
      continue
    }

    if (round(now.priceIncl, 2) !== round(line.unitPriceIncl, 2)) {
      repriced.push({
        description: line.description,
        wasIncl: line.unitPriceIncl,
        nowIncl: now.priceIncl,
        reason: 'price_changed',
      })
    }

    saleLines.push({
      productId: line.productId,
      productCode: line.productCode,
      // The product file's description, not the basket's: the sale is written
      // from today's product file, and that includes what the thing is called.
      description: now.description,
      departmentId: now.departmentId,
      qty: line.qty,
      unitPriceIncl: now.priceIncl,
      vatRatePct: now.vatRatePct,
      unitCostExcl: now.costExcl,
    })
  }

  if (saleLines.length === 0) {
    return {
      ok: false,
      error: 'Nothing on this order can still be sold — every item has been withdrawn.',
    }
  }

  // The delivery fee rides on the sale as its own line, so the customer is
  // charged it and the takings include it. Zero-rated is wrong for most
  // stores, so it follows the same VAT rate as the order's goods.
  if (order.fulfilment === 'deliver' && order.deliveryFeeIncl > 0) {
    saleLines.push({
      productId: null,
      description: 'Delivery',
      qty: 1,
      unitPriceIncl: order.deliveryFeeIncl,
      vatRatePct: saleLines[0]?.vatRatePct ?? 0,
      unitCostExcl: 0,
    })
  }

  const saved = await saveDraft(siteId, actor, {
    docType: 'invoice',
    customerId: order.customerId,
    customerName: order.contactName || null,
    customerPhone: order.contactPhone || null,
    customerAddress:
      order.fulfilment === 'deliver'
        ? [order.deliveryLine1, order.deliveryLine2, order.deliverySuburb, order.deliveryPostcode]
            .filter(Boolean)
            .join(', ') || null
        : null,
    priceStructureId: settings.priceStructureId,
    reference: order.orderNumber,
    notes: order.customerNote || null,
    lines: saleLines,
  })

  if (!saved.ok) return saved

  // Guarded on document_id IS NULL so two clicks racing each other cannot
  // attach a second sale — the loser's UPDATE matches nothing.
  const linked = await siteExecute(
    siteId,
    `UPDATE online_orders SET document_id = ?, status_id = ?
      WHERE id = ? AND document_id IS NULL`,
    [saved.id, landing.id, orderId],
  )

  if (linked.affectedRows === 0) {
    // Another request won the race and already linked its own sale. Ours is an
    // orphan draft; leaving it would double-count the order in every unposted
    // list, so it goes.
    await siteExecute(siteId, `DELETE FROM sales_documents WHERE id = ? AND status = 'draft'`, [
      saved.id,
    ])
    const fresh = await getOrder(siteId, orderId)
    return {
      ok: true,
      documentId: fresh?.documentId ?? saved.id,
      repriced: [],
      alreadyAccepted: true,
    }
  }

  return { ok: true, documentId: saved.id, repriced, alreadyAccepted: false }
}

/* ── Moving along ─────────────────────────────────────────────────────────── */

export async function moveOrderStatus(
  siteId: number,
  orderId: number,
  statusId: number,
): Promise<ActionResult> {
  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }
  if (order.isArchived) return { ok: false, error: 'That order has been archived.' }

  const statuses = await listOrderStatuses(siteId)
  const target = statuses.find((s) => s.id === statusId)
  if (!target) return { ok: false, error: 'That status does not exist.' }
  if (!target.isActive) return { ok: false, error: `“${target.name}” is no longer in use.` }
  if (target.role === 'dispatched' && order.fulfilment === 'collect') {
    return { ok: false, error: 'That step is for deliveries only.' }
  }
  // Cancelling has consequences the plain move does not handle.
  if (target.role === 'cancelled') {
    return { ok: false, error: 'Use cancel, so a reason is recorded.' }
  }

  await siteExecute(siteId, `UPDATE online_orders SET status_id = ? WHERE id = ?`, [
    statusId,
    orderId,
  ])
  return { ok: true }
}

/**
 * Turn an order down.
 *
 * A draft sale raised on acceptance is discarded with it — a draft is not a
 * transaction, so nothing needs reversing and leaving it behind would show the
 * order twice in every list of unposted work.
 *
 * A FINALISED sale is different: that is a real invoice, and unwinding it means
 * a credit note. Refused here rather than half-done, because the reversal path
 * belongs with payments.
 */
export async function cancelOrder(
  siteId: number,
  orderId: number,
  reason: string,
): Promise<ActionResult> {
  const trimmed = reason.trim()
  if (!trimmed) return { ok: false, error: 'Give a reason so the customer can be told.' }

  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }
  if (order.statusRole === 'cancelled') return { ok: false, error: 'That order is already cancelled.' }

  if (order.documentId && order.documentStatus && order.documentStatus !== 'draft') {
    return {
      ok: false,
      error: `Sale ${order.documentNumber ?? order.documentId} has already been finalised. Raise a credit note against it instead.`,
    }
  }

  const statuses = await listOrderStatuses(siteId)
  const cancelled = roleStatus(statuses, 'cancelled')
  if (!cancelled) return { ok: false, error: 'Your pipeline has no cancelled status.' }

  await siteTransaction(siteId, async (tx) => {
    await tx.query(
      `UPDATE online_orders SET status_id = ?, decline_reason = ?, document_id = NULL WHERE id = ?`,
      [cancelled.id, trimmed.slice(0, 190), orderId],
    )
    if (order.documentId) {
      await tx.query(`DELETE FROM sales_documents WHERE id = ? AND status = 'draft'`, [
        order.documentId,
      ])
    }
  })

  return { ok: true }
}

/**
 * File a finished order away.
 *
 * Housekeeping, not a status: the order, its sale and its invoice are
 * untouched, it simply stops being one of the things staff scroll past every
 * morning. Only a finished order can be archived — archiving one still in
 * progress would hide work nobody has done.
 */
export async function archiveOrder(
  siteId: number,
  orderId: number,
  archived: boolean,
): Promise<ActionResult> {
  const order = await getOrder(siteId, orderId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }

  if (archived && order.statusRole !== 'completed' && order.statusRole !== 'cancelled') {
    return { ok: false, error: 'Only a completed or cancelled order can be archived.' }
  }

  await siteExecute(
    siteId,
    `UPDATE online_orders SET is_archived = ?, archived_at = ? WHERE id = ?`,
    [archived ? 1 : 0, archived ? new Date() : null, orderId],
  )
  return { ok: true }
}
