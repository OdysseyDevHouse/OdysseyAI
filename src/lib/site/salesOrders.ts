import 'server-only'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '@/lib/siteDb'
import { toNum, round } from '@/lib/decimals'
import { lineTotals } from '@/lib/documentMath'
import { getDocument, todayIso, type SalesDocument, type SalesLine } from './salesDocuments'

/**
 * Sales orders — a commitment to sell, not yet a sale.
 *
 * An order is the same transaction as an invoice at an earlier moment in its
 * life, which is why it lives in `sales_documents` alongside one. What it adds
 * is a promise: goods set aside for a customer who has not taken them yet.
 *
 * Three rules hold this together, and all three are load-bearing:
 *
 *  1. **An order posts nothing.** No stock movement, no ledger entry, no
 *     document number. Cancelling one therefore reverses nothing, which is the
 *     whole reason posting happens at finalise only.
 *
 *  2. **Reservation is a DERIVED figure, never a movement.** `stock_movements`
 *     records actual movement only, so `Σ qty_change` still equals
 *     `stock_on_hand`. A reservation has moved nothing — it has only made a
 *     claim on what is there. Writing reservations into the movements table
 *     would break the one invariant that proves this module works.
 *
 *  3. **Delivering raises a linked invoice**, never mutates the order into one.
 *     Order 10, deliver 4: an invoice for 4 with `converted_from_id` pointing
 *     back, the order left `part_delivered` with 6 still reserved. The
 *     remaining 6 deliver later as a second invoice against the same order.
 *     One order, many invoices — which is what a customer with a standing
 *     order actually has.
 */

type Row = Record<string, unknown>

export const FULFILMENT_STATUSES = ['open', 'part_delivered', 'delivered', 'cancelled'] as const
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number]

export const FULFILMENT_LABELS: Record<FulfilmentStatus, string> = {
  open: 'Open',
  part_delivered: 'Part delivered',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}

export type OrderDetails = {
  documentId: number
  deliveryDate: string | null
  fulfilmentStatus: FulfilmentStatus
  reservesStock: boolean
  reservedAt: Date | null
  expiresAt: Date | null
  customerOrderNo: string | null
}

function mapDetails(r: Row): OrderDetails {
  return {
    documentId: Number(r.document_id),
    deliveryDate: (r.delivery_date as string | null) ?? null,
    fulfilmentStatus: r.fulfilment_status as FulfilmentStatus,
    reservesStock: Number(r.reserves_stock) === 1,
    reservedAt: (r.reserved_at as Date | null) ?? null,
    expiresAt: (r.expires_at as Date | null) ?? null,
    customerOrderNo: (r.customer_order_no as string | null) ?? null,
  }
}

export async function getOrderDetails(
  siteId: number,
  documentId: number,
): Promise<OrderDetails | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    'SELECT * FROM sales_order_details WHERE document_id = ?',
    [documentId],
  )
  return row ? mapDetails(row) : null
}

export type OrderDetailsInput = {
  deliveryDate?: string | null
  reservesStock?: boolean
  expiresAt?: string | null
  customerOrderNo?: string | null
}

export function validateOrderDetails(input: OrderDetailsInput): string | null {
  if (input.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.deliveryDate)) {
    return 'The delivery date is not a valid date.'
  }
  if (input.expiresAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt)) {
    return 'The expiry date is not a valid date.'
  }
  if (input.deliveryDate && input.expiresAt && input.expiresAt < input.deliveryDate) {
    return 'The reservation cannot expire before the delivery date.'
  }
  if ((input.customerOrderNo ?? '').length > 60) {
    return 'The customer order number is too long.'
  }
  return null
}

export type OrderResult = { ok: true; documentId: number } | { ok: false; error: string }

/**
 * Attaches (or updates) the order-only facts on a `sales_order` document.
 *
 * Separate from `saveDraft` because these columns exist for exactly one doc
 * type — putting them on the main save path would mean every invoice, quote
 * and credit note carrying four fields that can only ever be NULL.
 */
export async function setOrderDetails(
  siteId: number,
  documentId: number,
  input: OrderDetailsInput,
): Promise<OrderResult> {
  const invalid = validateOrderDetails(input)
  if (invalid) return { ok: false, error: invalid }

  const doc = await getDocument(siteId, documentId)
  if (!doc) return { ok: false, error: 'That order no longer exists.' }
  if (doc.docType !== 'sales_order') {
    return { ok: false, error: 'Only a sales order carries delivery details.' }
  }

  const existing = await getOrderDetails(siteId, documentId)
  if (existing && (existing.fulfilmentStatus === 'delivered' || existing.fulfilmentStatus === 'cancelled')) {
    return { ok: false, error: `A ${FULFILMENT_LABELS[existing.fulfilmentStatus].toLowerCase()} order cannot be changed.` }
  }

  const reserves = input.reservesStock ?? existing?.reservesStock ?? true

  await siteExecute(
    siteId,
    `INSERT INTO sales_order_details
       (document_id, delivery_date, fulfilment_status, reserves_stock, reserved_at,
        expires_at, customer_order_no)
     VALUES (?, ?, 'open', ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       delivery_date     = VALUES(delivery_date),
       reserves_stock    = VALUES(reserves_stock),
       reserved_at       = VALUES(reserved_at),
       expires_at        = VALUES(expires_at),
       customer_order_no = VALUES(customer_order_no)`,
    [
      documentId,
      input.deliveryDate ?? existing?.deliveryDate ?? null,
      reserves ? 1 : 0,
      // reserved_at marks when the claim on stock began, so a stale-reservation
      // sweep can reason about age even when no expiry was set.
      reserves ? new Date() : null,
      input.expiresAt ?? (existing?.expiresAt ? isoDate(existing.expiresAt) : null),
      input.customerOrderNo?.trim() || null,
    ],
  )

  return { ok: true, documentId }
}

/** A line with what is still owed on it. */
export type OutstandingLine = SalesLine & { qtyOutstanding: number }

export function outstandingLines(doc: SalesDocument): OutstandingLine[] {
  return doc.lines.map((line) => ({
    ...line,
    qtyOutstanding: round(line.qty - line.qtyDelivered, 3),
  }))
}

export type OrderSummary = {
  document: SalesDocument
  details: OrderDetails | null
  lines: OutstandingLine[]
  qtyOrdered: number
  qtyDelivered: number
  qtyOutstanding: number
  /** Invoices already raised against this order, newest first. */
  deliveries: { id: number; documentNumber: string | null; documentDate: string; totalIncl: number; status: string }[]
}

export async function getOrder(siteId: number, documentId: number): Promise<OrderSummary | null> {
  const document = await getDocument(siteId, documentId)
  if (!document || document.docType !== 'sales_order') return null

  const [details, deliveryRows] = await Promise.all([
    getOrderDetails(siteId, documentId),
    siteQuery<Row>(
      siteId,
      `SELECT id, document_number, document_date, total_incl, status
         FROM sales_documents
        WHERE converted_from_id = ? AND doc_type = 'invoice'
        ORDER BY id DESC`,
      [documentId],
    ),
  ])

  const lines = outstandingLines(document)

  return {
    document,
    details,
    lines,
    qtyOrdered: round(lines.reduce((sum, l) => sum + l.qty, 0), 3),
    qtyDelivered: round(lines.reduce((sum, l) => sum + l.qtyDelivered, 0), 3),
    qtyOutstanding: round(lines.reduce((sum, l) => sum + l.qtyOutstanding, 0), 3),
    deliveries: deliveryRows.map((r) => ({
      id: Number(r.id),
      documentNumber: (r.document_number as string | null) ?? null,
      documentDate: String(r.document_date),
      totalIncl: toNum(r.total_incl),
      status: String(r.status),
    })),
  }
}

export type DeliveryLineInput = {
  /** The ORDER line being delivered against. */
  lineId: number
  qty: number
}

export type DeliveryResult =
  | { ok: true; invoiceId: number; fulfilmentStatus: FulfilmentStatus }
  | { ok: false; error: string }

/**
 * Delivers some or all of an order, raising a linked draft invoice for exactly
 * what goes out.
 *
 * The invoice is created as a DRAFT and finalised through the ordinary path, so
 * every guard that protects a normal sale — period lock, terminal validation,
 * credit limit, stock movement, numbering — runs unchanged. Delivering does not
 * get its own posting engine, because a second posting engine is how two code
 * paths start to disagree about what a sale is.
 *
 * Prices come from the ORDER line, not from today's product file: the customer
 * was quoted a price when they ordered, and a price rise between order and
 * delivery is the shop's problem, not theirs.
 */
export async function deliverOrder(
  siteId: number,
  actor: { userId: number; userName: string },
  documentId: number,
  deliveries: DeliveryLineInput[],
  options: { documentDate?: string; terminalId?: number | null; terminalCode?: string | null } = {},
): Promise<DeliveryResult> {
  const order = await getOrder(siteId, documentId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }

  if (order.details?.fulfilmentStatus === 'cancelled') {
    return { ok: false, error: 'A cancelled order cannot be delivered.' }
  }
  if (order.details?.fulfilmentStatus === 'delivered') {
    return { ok: false, error: 'This order has already been delivered in full.' }
  }
  if (order.document.status === 'cancelled') {
    return { ok: false, error: 'A voided order cannot be delivered.' }
  }

  const wanted = deliveries.filter((d) => round(d.qty, 3) !== 0)
  if (wanted.length === 0) return { ok: false, error: 'Enter a quantity to deliver.' }

  // Validate every line before writing anything, so a bad request cannot leave
  // half an order delivered.
  const byId = new Map(order.lines.map((l) => [l.id, l]))
  const planned: { line: OutstandingLine; qty: number }[] = []

  for (const delivery of wanted) {
    const line = byId.get(delivery.lineId)
    if (!line) return { ok: false, error: 'That line is not on this order.' }

    const qty = round(delivery.qty, 3)
    if (qty < 0) return { ok: false, error: 'A delivery cannot be negative. Credit the invoice instead.' }
    if (qty > line.qtyOutstanding) {
      return {
        ok: false,
        error: `Only ${line.qtyOutstanding} of ${line.description} is still outstanding.`,
      }
    }
    planned.push({ line, qty })
  }

  const documentDate = options.documentDate ?? todayIso()

  // The invoice is built from the order's own snapshot: same description, same
  // price, same VAT rate, same cost basis. Only the quantity differs.
  const invoiceId = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO sales_documents
         (doc_type, status, document_date, customer_id, customer_name, customer_vat_no,
          customer_phone, customer_address, price_structure_id, user_id, user_name,
          terminal_id, terminal_code, reference, notes, converted_from_id,
          subtotal_excl, vat_total, discount_total, total_incl)
       VALUES ('invoice','draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,0)`,
      [
        documentDate,
        order.document.customerId,
        order.document.customerName,
        order.document.customerVatNo,
        order.document.customerPhone,
        order.document.customerAddress,
        order.document.priceStructureId,
        actor.userId,
        actor.userName.slice(0, 120),
        options.terminalId ?? null,
        options.terminalCode ?? null,
        order.document.reference,
        order.details?.customerOrderNo
          ? `Order ${order.document.documentNumber ?? `#${documentId}`} · customer ref ${order.details.customerOrderNo}`
          : `Delivery against order ${order.document.documentNumber ?? `#${documentId}`}`,
        documentId,
      ] as never,
    )
    const id = (res as { insertId: number }).insertId

    let lineNumber = 0
    for (const { line, qty } of planned) {
      if (qty === 0) continue
      lineNumber += 1

      // Recomputed for the delivered quantity — the line discount is a
      // percentage of this line, so it scales with it. documentMath owns the
      // arithmetic; this only chooses the quantity it works on.
      const totals = lineFigures(line, qty)

      await tx.execute(
        `INSERT INTO sales_document_lines
           (document_id, line_number, product_id, product_code, description, product_type,
            department_id, qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
            line_total_incl, line_total_excl, line_vat, unit_cost_excl)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          lineNumber,
          line.productId,
          line.productCode,
          line.description,
          line.productType,
          line.departmentId,
          qty.toFixed(3),
          line.unitPriceIncl.toFixed(4),
          line.discountPct.toFixed(3),
          totals.discountIncl.toFixed(4),
          line.vatRatePct.toFixed(3),
          totals.lineTotalIncl.toFixed(4),
          totals.lineTotalExcl.toFixed(4),
          totals.lineVat.toFixed(4),
          line.unitCostExcl.toFixed(4),
        ] as never,
      )

      // The order line records what has gone out. This is what shrinks the
      // reservation: reserved = Σ(qty − qty_delivered).
      await tx.execute(
        'UPDATE sales_document_lines SET qty_delivered = qty_delivered + ? WHERE id = ?',
        [qty.toFixed(3), line.id] as never,
      )
    }

    // Header totals from the lines just written, so the draft is balanced
    // before anything reads it.
    await tx.execute(
      `UPDATE sales_documents d
          SET subtotal_excl = (SELECT COALESCE(SUM(line_total_excl),0) FROM sales_document_lines WHERE document_id = d.id),
              vat_total     = (SELECT COALESCE(SUM(line_vat),0)        FROM sales_document_lines WHERE document_id = d.id),
              discount_total= (SELECT COALESCE(SUM(discount_incl),0)   FROM sales_document_lines WHERE document_id = d.id),
              total_incl    = (SELECT COALESCE(SUM(line_total_incl),0) FROM sales_document_lines WHERE document_id = d.id)
        WHERE d.id = ?`,
      [id] as never,
    )

    return id
  })

  // Fulfilment status is recomputed from the lines rather than inferred from
  // this delivery, so it stays right even if a line was delivered elsewhere.
  const status = await refreshFulfilment(siteId, documentId)

  await auditDocument(siteId, actor, documentId, 'delivered',
    `Delivered against order — invoice draft #${invoiceId}`)

  return { ok: true, invoiceId, fulfilmentStatus: status }
}

/**
 * Recomputes an order's fulfilment status from its lines.
 *
 * Derived, never set by hand: an order is delivered when nothing is
 * outstanding, and that question has exactly one right answer at any moment.
 */
export async function refreshFulfilment(
  siteId: number,
  documentId: number,
): Promise<FulfilmentStatus> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COALESCE(SUM(qty), 0) AS ordered, COALESCE(SUM(qty_delivered), 0) AS delivered
       FROM sales_document_lines WHERE document_id = ?`,
    [documentId],
  )
  const ordered = toNum(row?.ordered)
  const delivered = toNum(row?.delivered)

  const current = await getOrderDetails(siteId, documentId)
  if (current?.fulfilmentStatus === 'cancelled') return 'cancelled'

  const status: FulfilmentStatus =
    delivered <= 0 ? 'open' : delivered >= ordered ? 'delivered' : 'part_delivered'

  await siteExecute(
    siteId,
    `INSERT INTO sales_order_details (document_id, fulfilment_status)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE fulfilment_status = VALUES(fulfilment_status)`,
    [documentId, status],
  )

  return status
}

export type CancelResult = { ok: true; released: number } | { ok: false; error: string }

/**
 * Cancels the undelivered balance of an order.
 *
 * Posts nothing and reverses nothing — an order never moved stock or touched
 * the ledger, so there is nothing to undo. What it releases is the
 * reservation, and because that is derived, releasing it means marking the
 * order cancelled: the reserved sum simply stops counting it.
 *
 * Already-delivered quantities stay delivered. Those went out on an invoice,
 * and that invoice is a tax document that cancelling an order must not touch.
 */
export async function cancelOrder(
  siteId: number,
  actor: { userId: number; userName: string },
  documentId: number,
  reason?: string,
): Promise<CancelResult> {
  const order = await getOrder(siteId, documentId)
  if (!order) return { ok: false, error: 'That order no longer exists.' }
  if (order.details?.fulfilmentStatus === 'cancelled') {
    return { ok: false, error: 'This order is already cancelled.' }
  }
  if (order.details?.fulfilmentStatus === 'delivered') {
    return { ok: false, error: 'This order was delivered in full — there is nothing to cancel.' }
  }

  await siteExecute(
    siteId,
    `INSERT INTO sales_order_details (document_id, fulfilment_status)
     VALUES (?, 'cancelled')
     ON DUPLICATE KEY UPDATE fulfilment_status = 'cancelled'`,
    [documentId],
  )

  await auditDocument(siteId, actor, documentId, 'order_cancelled',
    reason?.trim()
      ? `Cancelled — ${reason.trim().slice(0, 160)}`
      : `Cancelled with ${order.qtyOutstanding} outstanding`)

  return { ok: true, released: order.qtyOutstanding }
}

export type StaleRelease = {
  documentId: number
  documentNumber: string | null
  customerName: string | null
  qtyOutstanding: number
  expiredAt: Date | null
}

/**
 * Releases reservations on orders nobody came back for.
 *
 * An order parked for three months must not hold stock forever — the goods are
 * on the shelf, and a reservation that outlives the customer's interest makes
 * "available to sell" lie in the direction that loses sales.
 *
 * The release is audited, and it stops the reservation without cancelling the
 * order: `reserves_stock = 0` leaves the commitment visible and deliverable,
 * it just no longer claims stock. Deleting the order instead would destroy the
 * record of what was promised.
 */
export async function releaseStaleReservations(
  siteId: number,
  actor: { userId: number; userName: string },
  asAt: Date = new Date(),
): Promise<StaleRelease[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.document_number, d.customer_name, o.expires_at,
            COALESCE(SUM(l.qty - l.qty_delivered), 0) AS outstanding
       FROM sales_order_details o
       JOIN sales_documents d      ON d.id = o.document_id
       LEFT JOIN sales_document_lines l ON l.document_id = d.id
      WHERE o.reserves_stock = 1
        AND o.expires_at IS NOT NULL
        AND o.expires_at <= ?
        AND o.fulfilment_status IN ('open','part_delivered')
      GROUP BY d.id, d.document_number, d.customer_name, o.expires_at`,
    [asAt],
  )

  const released: StaleRelease[] = []

  for (const row of rows) {
    const documentId = Number(row.id)
    await siteExecute(
      siteId,
      'UPDATE sales_order_details SET reserves_stock = 0 WHERE document_id = ?',
      [documentId],
    )
    await auditDocument(siteId, actor, documentId, 'reservation_released',
      `Reservation expired — ${toNum(row.outstanding)} released back to available stock`)
    released.push({
      documentId,
      documentNumber: (row.document_number as string | null) ?? null,
      customerName: (row.customer_name as string | null) ?? null,
      qtyOutstanding: toNum(row.outstanding),
      expiredAt: (row.expires_at as Date | null) ?? null,
    })
  }

  return released
}

export type OrderListRow = {
  id: number
  documentNumber: string | null
  documentDate: string
  customerId: number | null
  customerName: string | null
  totalIncl: number
  status: string
  fulfilmentStatus: FulfilmentStatus
  deliveryDate: string | null
  customerOrderNo: string | null
  reservesStock: boolean
  expiresAt: Date | null
  qtyOrdered: number
  qtyDelivered: number
  qtyOutstanding: number
}

export type OrderListOptions = {
  fulfilment?: FulfilmentStatus | 'outstanding'
  customerId?: number
  q?: string
  limit?: number
  offset?: number
}

export async function listOrders(
  siteId: number,
  options: OrderListOptions = {},
): Promise<{ items: OrderListRow[]; total: number }> {
  const where: string[] = ["d.doc_type = 'sales_order'", "d.status <> 'cancelled'"]
  const params: unknown[] = []

  if (options.fulfilment === 'outstanding') {
    where.push("COALESCE(o.fulfilment_status,'open') IN ('open','part_delivered')")
  } else if (options.fulfilment) {
    where.push("COALESCE(o.fulfilment_status,'open') = ?")
    params.push(options.fulfilment)
  }
  if (options.customerId) {
    where.push('d.customer_id = ?')
    params.push(options.customerId)
  }
  if (options.q?.trim()) {
    where.push('(d.document_number LIKE ? OR d.customer_name LIKE ? OR o.customer_order_no LIKE ?)')
    const like = `%${options.q.trim()}%`
    params.push(like, like, like)
  }

  const clause = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const offset = Math.max(options.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT d.id, d.document_number, d.document_date, d.customer_id, d.customer_name,
              d.total_incl, d.status,
              COALESCE(o.fulfilment_status,'open') AS fulfilment_status,
              o.delivery_date, o.customer_order_no, COALESCE(o.reserves_stock,0) AS reserves_stock,
              o.expires_at,
              COALESCE(SUM(l.qty), 0)             AS qty_ordered,
              COALESCE(SUM(l.qty_delivered), 0)   AS qty_delivered
         FROM sales_documents d
         LEFT JOIN sales_order_details o  ON o.document_id = d.id
         LEFT JOIN sales_document_lines l ON l.document_id = d.id
         ${clause}
        GROUP BY d.id, d.document_number, d.document_date, d.customer_id, d.customer_name,
                 d.total_incl, d.status, o.fulfilment_status, o.delivery_date,
                 o.customer_order_no, o.reserves_stock, o.expires_at
        ORDER BY d.document_date DESC, d.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(DISTINCT d.id) AS total
         FROM sales_documents d
         LEFT JOIN sales_order_details o ON o.document_id = d.id
         ${clause}`,
      params,
    ),
  ])

  return {
    items: rows.map((r) => {
      const qtyOrdered = toNum(r.qty_ordered)
      const qtyDelivered = toNum(r.qty_delivered)
      return {
        id: Number(r.id),
        documentNumber: (r.document_number as string | null) ?? null,
        documentDate: String(r.document_date),
        customerId: r.customer_id === null ? null : Number(r.customer_id),
        customerName: (r.customer_name as string | null) ?? null,
        totalIncl: toNum(r.total_incl),
        status: String(r.status),
        fulfilmentStatus: r.fulfilment_status as FulfilmentStatus,
        deliveryDate: (r.delivery_date as string | null) ?? null,
        customerOrderNo: (r.customer_order_no as string | null) ?? null,
        reservesStock: Number(r.reserves_stock) === 1,
        expiresAt: (r.expires_at as Date | null) ?? null,
        qtyOrdered,
        qtyDelivered,
        qtyOutstanding: round(qtyOrdered - qtyDelivered, 3),
      }
    }),
    total: Number(countRow?.total ?? 0),
  }
}

/**
 * Line figures for a delivered quantity, at the order's own agreed pricing.
 *
 * Straight through `documentMath.lineTotals` — the discount is carried as a
 * PERCENTAGE so it scales with the delivered quantity. Passing the order line's
 * absolute `discountIncl` would apply the whole order's discount to a part
 * delivery, and the customer would get their full discount on the first box.
 */
function lineFigures(line: SalesLine, qty: number) {
  return lineTotals({
    qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: line.discountPct,
    vatRatePct: line.vatRatePct,
  })
}

/**
 * One audit row against the document.
 *
 * `document_audit`, not `activity_log`: the activity log is about what people
 * did to master data (a customer edited, a supplier put on hold), and a
 * document's own history belongs with the document so the detail screen can
 * show it without joining across two audit trails.
 *
 * Swallows its own errors — the write it describes has already committed, and
 * failing the delivery because the audit insert failed would undo a real
 * operation to record a note about it.
 */
async function auditDocument(
  siteId: number,
  actor: { userId: number; userName: string },
  documentId: number,
  action: string,
  detail: string,
): Promise<void> {
  try {
    await siteExecute(
      siteId,
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, ?, ?, ?, ?)`,
      [documentId, action, detail.slice(0, 400), actor.userId, actor.userName.slice(0, 120)],
    )
  } catch {
    // Deliberately ignored — see above.
  }
}

function isoDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(
    value.getDate(),
  ).padStart(2, '0')}`
}
