import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import type { Actor } from './activityLog'

/**
 * Purchase orders, before anything is received.
 *
 * An ORDER moves nothing: no stock, no cost, no ledger. It is a statement of
 * what was asked for, and it exists so that receiving can be checked against
 * it. Everything that actually happens is in purchasePosting.ts.
 *
 * The mirror of salesDocuments.ts, and separate for the same reason the tables
 * are — see the header of 017_purchasing.sql.
 */

export const PURCHASE_DOC_TYPES = ['purchase_order', 'grv', 'supplier_return'] as const
export type PurchaseDocType = (typeof PURCHASE_DOC_TYPES)[number]

export const PURCHASE_DOC_LABELS: Record<PurchaseDocType, string> = {
  purchase_order: 'Purchase order',
  grv: 'Goods received',
  supplier_return: 'Supplier return',
}

export type PurchaseLine = {
  id: number
  documentId: number
  lineNumber: number
  productId: number | null
  productCode: string | null
  supplierCode: string | null
  description: string
  productType: string
  departmentId: number | null
  qtyOrdered: number
  qtyReceived: number
  /** Still to arrive. Zero once the line is complete. */
  qtyOutstanding: number
  unitCostExcl: number
  discountPct: number
  vatRatePct: number
  lineTotalExcl: number
  lineVat: number
  lineTotalIncl: number
  chargeExcl: number
  landedCostExcl: number
  /** Which pile the goods went into. A return must leave the same one. */
  locationId: number | null
  /** On a supplier_return line: the GRV line it sends back. Null elsewhere. */
  sourceLineId: number | null
}

export type PurchaseDocument = {
  id: number
  docType: PurchaseDocType
  docLabel: string
  status: string
  documentNumber: string | null
  documentDate: string
  dueDate: string | null
  supplierId: number
  supplierCode: string | null
  supplierName: string | null
  supplierInvoiceNo: string | null
  userName: string
  subtotalExcl: number
  vatTotal: number
  totalIncl: number
  chargesExcl: number
  orderedFromId: number | null
  reference: string | null
  notes: string | null
  cancelReason: string | null
  finalisedAt: Date | null
  createdAt: Date
  fulfilmentStatus: string | null
  expectedDate: string | null
  lines: PurchaseLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapLine(r: Row): PurchaseLine {
  const ordered = toNum(r.qty_ordered)
  const received = toNum(r.qty_received)
  return {
    id: Number(r.id),
    documentId: Number(r.document_id),
    lineNumber: Number(r.line_number),
    productId: r.product_id === null ? null : Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    supplierCode: (r.supplier_code as string | null) ?? null,
    description: String(r.description),
    productType: String(r.product_type),
    departmentId: r.department_id === null ? null : Number(r.department_id),
    qtyOrdered: ordered,
    qtyReceived: received,
    qtyOutstanding: round(Math.max(ordered - received, 0), 3),
    unitCostExcl: toNum(r.unit_cost_excl),
    discountPct: toNum(r.discount_pct),
    vatRatePct: toNum(r.vat_rate_pct),
    lineTotalExcl: toNum(r.line_total_excl),
    lineVat: toNum(r.line_vat),
    lineTotalIncl: toNum(r.line_total_incl),
    chargeExcl: toNum(r.charge_excl),
    landedCostExcl: toNum(r.landed_cost_excl),
    locationId: r.location_id === null || r.location_id === undefined ? null : Number(r.location_id),
    sourceLineId:
      r.source_line_id === null || r.source_line_id === undefined ? null : Number(r.source_line_id),
  }
}

function mapDocument(r: Row, lines: PurchaseLine[]): PurchaseDocument {
  const docType = String(r.doc_type) as PurchaseDocType
  return {
    id: Number(r.id),
    docType,
    docLabel: PURCHASE_DOC_LABELS[docType] ?? docType,
    status: String(r.status),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date),
    dueDate: r.due_date === null ? null : String(r.due_date),
    supplierId: Number(r.supplier_id),
    supplierCode: (r.supplier_code as string | null) ?? null,
    supplierName: (r.supplier_name as string | null) ?? null,
    supplierInvoiceNo: (r.supplier_invoice_no as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    subtotalExcl: toNum(r.subtotal_excl),
    vatTotal: toNum(r.vat_total),
    totalIncl: toNum(r.total_incl),
    chargesExcl: toNum(r.charges_excl),
    orderedFromId: r.ordered_from_id === null ? null : Number(r.ordered_from_id),
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    finalisedAt: (r.finalised_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    fulfilmentStatus: (r.fulfilment_status as string | null) ?? null,
    expectedDate: r.expected_date === null || r.expected_date === undefined ? null : String(r.expected_date),
    lines,
  }
}

const SELECT_DOC = `
  SELECT d.*, o.fulfilment_status, o.expected_date, o.supplier_order_no
    FROM purchase_documents d
    LEFT JOIN purchase_order_details o ON o.document_id = d.id
`

export async function getPurchaseDocument(
  siteId: number,
  id: number,
): Promise<PurchaseDocument | null> {
  const [docRow, lineRows] = await Promise.all([
    siteQueryOne<Row>(siteId, `${SELECT_DOC} WHERE d.id = ? LIMIT 1`, [id]),
    siteQuery<Row>(
      siteId,
      'SELECT * FROM purchase_document_lines WHERE document_id = ? ORDER BY line_number, id',
      [id],
    ),
  ])
  return docRow ? mapDocument(docRow, lineRows.map(mapLine)) : null
}

export type PurchaseListOptions = {
  docTypes?: readonly PurchaseDocType[]
  statuses?: readonly string[]
  supplierId?: number
  search?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export async function listPurchaseDocuments(
  siteId: number,
  opts: PurchaseListOptions = {},
): Promise<{ items: PurchaseDocument[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.docTypes?.length) {
    where.push(`d.doc_type IN (${opts.docTypes.map(() => '?').join(',')})`)
    params.push(...opts.docTypes)
  }
  if (opts.statuses?.length) {
    where.push(`d.status IN (${opts.statuses.map(() => '?').join(',')})`)
    params.push(...opts.statuses)
  }
  if (opts.supplierId) {
    where.push('d.supplier_id = ?')
    params.push(opts.supplierId)
  }
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(d.document_number LIKE ? OR d.supplier_name LIKE ? OR d.supplier_invoice_no LIKE ?)')
    params.push(term, term, term)
  }
  if (opts.from) {
    where.push('d.document_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('d.document_date <= ?')
    params.push(opts.to)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_DOC} ${whereSql} ORDER BY d.document_date DESC, d.id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<RowDataPacket & { total: number }>(
      siteId,
      `SELECT COUNT(*) AS total FROM purchase_documents d ${whereSql}`,
      params,
    ),
  ])

  return { items: rows.map((r) => mapDocument(r, [])), total: Number(countRow?.total ?? 0) }
}

/** Orders still waiting on stock — what the receiving screen offers. */
export async function openOrders(siteId: number, supplierId?: number) {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DOC}
      WHERE d.doc_type = 'purchase_order'
        AND d.status = 'issued'
        AND COALESCE(o.fulfilment_status, 'open') IN ('open','part_received')
        ${supplierId ? 'AND d.supplier_id = ?' : ''}
      ORDER BY d.document_date`,
    supplierId ? [supplierId] : [],
  )
  return rows.map((r) => mapDocument(r, []))
}

/* ── Orders ──────────────────────────────────────────────────────────────── */

export type OrderLineInput = {
  productId?: number | null
  productCode?: string | null
  supplierCode?: string | null
  description: string
  productType?: string
  departmentId?: number | null
  qtyOrdered: number
  unitCostExcl: number
  discountPct?: number
  vatRatePct: number
}

export type OrderInput = {
  supplierId: number
  documentDate?: string
  expectedDate?: string | null
  reference?: string | null
  notes?: string | null
  lines: OrderLineInput[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateOrder(input: OrderInput): string | null {
  if (input.lines.length === 0) return 'Add at least one line.'
  for (const [index, line] of input.lines.entries()) {
    const where = `Line ${index + 1}`
    if (!line.description?.trim()) return `${where}: a description is required.`
    if (!Number.isFinite(line.qtyOrdered) || line.qtyOrdered <= 0) {
      return `${where}: enter a quantity.`
    }
    if (!Number.isFinite(line.unitCostExcl) || line.unitCostExcl < 0) {
      return `${where}: the cost cannot be negative.`
    }
  }
  return null
}

/**
 * Saves a purchase order.
 *
 * Lines are rewritten wholesale rather than diffed — the same reasoning as a
 * sales draft: nothing has been received, so there is no state to preserve.
 */
export async function saveOrder(
  siteId: number,
  actor: Actor,
  input: OrderInput,
  documentId?: number,
): Promise<SaveResult> {
  const invalid = validateOrder(input)
  if (invalid) return { ok: false, error: invalid }

  const supplier = await siteQueryOne<Row>(
    siteId,
    'SELECT id, code, name, status FROM suppliers WHERE id = ? LIMIT 1',
    [input.supplierId],
  )
  if (!supplier) return { ok: false, error: 'That supplier no longer exists.' }
  if (String(supplier.status) !== 'active') {
    return { ok: false, error: `${supplier.name} is ${supplier.status} — no new orders.` }
  }

  if (documentId) {
    const existing = await getPurchaseDocument(siteId, documentId)
    if (!existing) return { ok: false, error: 'That order no longer exists.' }
    if (existing.status === 'finalised' || existing.status === 'cancelled') {
      return { ok: false, error: 'A received order cannot be changed.' }
    }
  }

  const computed = input.lines.map((line) => {
    const gross = round(line.qtyOrdered * line.unitCostExcl, 2)
    const discount = round(gross * ((line.discountPct ?? 0) / 100), 2)
    const excl = round(gross - discount, 2)
    const vat = round(excl * (line.vatRatePct / 100), 2)
    return { excl, vat, incl: round(excl + vat, 2) }
  })

  const subtotalExcl = computed.reduce((sum, c) => round(sum + c.excl, 2), 0)
  const vatTotal = computed.reduce((sum, c) => round(sum + c.vat, 2), 0)
  const documentDate = input.documentDate ?? todayIso()

  return siteTransaction(siteId, async (tx) => {
    let id = documentId

    if (id) {
      await tx.execute(
        `UPDATE purchase_documents SET
           document_date = ?, supplier_id = ?, supplier_code = ?, supplier_name = ?,
           subtotal_excl = ?, vat_total = ?, total_incl = ?, reference = ?, notes = ?
         WHERE id = ?`,
        [
          documentDate,
          input.supplierId,
          String(supplier.code),
          String(supplier.name),
          subtotalExcl.toFixed(4),
          vatTotal.toFixed(4),
          round(subtotalExcl + vatTotal, 2).toFixed(4),
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          id,
        ] as never,
      )
      await tx.execute('DELETE FROM purchase_document_lines WHERE document_id = ?', [id] as never)
    } else {
      const [res] = await tx.execute(
        `INSERT INTO purchase_documents
           (doc_type, status, document_date, supplier_id, supplier_code, supplier_name,
            user_id, user_name, subtotal_excl, vat_total, total_incl, reference, notes)
         VALUES ('purchase_order','draft',?,?,?,?,?,?,?,?,?,?,?)`,
        [
          documentDate,
          input.supplierId,
          String(supplier.code),
          String(supplier.name),
          actor.userId,
          actor.userName.slice(0, 120),
          subtotalExcl.toFixed(4),
          vatTotal.toFixed(4),
          round(subtotalExcl + vatTotal, 2).toFixed(4),
          input.reference?.trim() || null,
          input.notes?.trim() || null,
        ] as never,
      )
      id = (res as { insertId: number }).insertId
    }

    for (const [index, line] of input.lines.entries()) {
      const c = computed[index]
      await tx.execute(
        `INSERT INTO purchase_document_lines
           (document_id, line_number, product_id, product_code, supplier_code, description,
            product_type, department_id, qty_ordered, qty_received, unit_cost_excl,
            discount_pct, vat_rate_pct, line_total_excl, line_vat, line_total_incl)
         VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
        [
          id,
          index + 1,
          line.productId ?? null,
          line.productCode ?? null,
          line.supplierCode ?? null,
          line.description.trim().slice(0, 190),
          line.productType ?? 'normal',
          line.departmentId ?? null,
          round(line.qtyOrdered, 3).toFixed(3),
          round(line.unitCostExcl, 4).toFixed(4),
          (line.discountPct ?? 0).toFixed(3),
          line.vatRatePct.toFixed(3),
          c.excl.toFixed(4),
          c.vat.toFixed(4),
          c.incl.toFixed(4),
        ] as never,
      )
    }

    await tx.execute(
      `INSERT INTO purchase_order_details (document_id, expected_date) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE expected_date = VALUES(expected_date)`,
      [id, input.expectedDate ?? null] as never,
    )

    return { ok: true as const, id: id! }
  })
}

/**
 * Issues an order to the supplier.
 *
 * This is where a PO gets its number — not at draft. An order that was never
 * sent should not consume one, for the same reason a saved sale does not.
 */
export async function issueOrder(siteId: number, id: number): Promise<SaveResult> {
  const doc = await getPurchaseDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That order no longer exists.' }
  if (doc.status !== 'draft') return { ok: false, error: `A ${doc.status} order cannot be issued.` }
  if (doc.lines.length === 0) return { ok: false, error: 'Add at least one line first.' }

  await siteTransaction(siteId, async (tx) => {
    const documentNumber = await nextDocumentNumber(tx, 'purchase_order')
    await tx.execute(
      "UPDATE purchase_documents SET status = 'issued', document_number = ? WHERE id = ?",
      [documentNumber, id] as never,
    )
  })

  return { ok: true, id }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/** Cancels an order. Only ever a draft or an issued one — nothing was received. */
export async function cancelOrder(siteId: number, id: number, reason: string): Promise<DeleteResult> {
  const doc = await getPurchaseDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That order no longer exists.' }
  if (doc.status === 'finalised') {
    return { ok: false, error: 'Goods have been received against this order.' }
  }
  if (doc.lines.some((l) => l.qtyReceived > 0)) {
    return { ok: false, error: 'Part of this order has already arrived.' }
  }

  await siteExecute(
    siteId,
    "UPDATE purchase_documents SET status = 'cancelled', cancel_reason = ? WHERE id = ?",
    [reason.trim().slice(0, 190) || 'Cancelled', id],
  )
  await siteExecute(
    siteId,
    "UPDATE purchase_order_details SET fulfilment_status = 'cancelled' WHERE document_id = ?",
    [id],
  )
  return { ok: true }
}

export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}

export function toPurchaseDocType(value: unknown): PurchaseDocType | null {
  const raw = String(value ?? '')
  return (PURCHASE_DOC_TYPES as readonly string[]).includes(raw) ? (raw as PurchaseDocType) : null
}
