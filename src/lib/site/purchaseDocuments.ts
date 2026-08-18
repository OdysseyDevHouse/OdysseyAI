import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { formatMoney, round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { getNumericSetting } from './settings'
import { can, type CapabilitySet } from './permissions'
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
  /** Free units that came with it. Increase stock, not what is owed. See 090. */
  qtyBonus: number
  /** Everything that entered stock: received plus bonus. */
  qtyArrived: number
  /** Still to arrive. Zero once the line is complete. */
  qtyOutstanding: number
  unitCostExcl: number
  discountPct: number
  /** Absolute discount, which wins over the percentage. Zero on older lines. */
  discountAmount: number
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
  /**
   * The job line this was bought for (163). Null on ordinary stock buying.
   *
   * Read so the order screen can carry it back into OrderLineInput on save —
   * without that round trip, editing an order silently severs every job from
   * its parts.
   */
  jobCardLineId: number | null
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
  /** A discount on the whole delivery, already apportioned onto the lines. */
  discountExcl: number
  discountPct: number
  orderedFromId: number | null
  reference: string | null
  notes: string | null
  cancelReason: string | null
  finalisedAt: Date | null
  createdAt: Date
  fulfilmentStatus: string | null
  expectedDate: string | null
  /** Their reference for our order. Order-only; null on a GRV or a return. */
  supplierOrderNo: string | null
  lines: PurchaseLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapLine(r: Row): PurchaseLine {
  const ordered = toNum(r.qty_ordered)
  const received = toNum(r.qty_received)
  // Absent until 090 reaches this site — toNum(undefined) is 0, which is
  // exactly right: no bonus units, so arrived equals received.
  const bonus = toNum(r.qty_bonus)
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
    qtyBonus: bonus,
    qtyArrived: round(received + bonus, 3),
    // Against the PAID quantity: an order for 100 filled by 90 paid plus 10
    // free is still 10 short of what was asked for.
    qtyOutstanding: round(Math.max(ordered - received, 0), 3),
    unitCostExcl: toNum(r.unit_cost_excl),
    discountPct: toNum(r.discount_pct),
    // Absent until 086 reaches this site — toNum(undefined) is 0, which is
    // exactly right: no absolute discount, so the percentage governs.
    discountAmount: toNum(r.discount_amount),
    vatRatePct: toNum(r.vat_rate_pct),
    lineTotalExcl: toNum(r.line_total_excl),
    lineVat: toNum(r.line_vat),
    lineTotalIncl: toNum(r.line_total_incl),
    chargeExcl: toNum(r.charge_excl),
    landedCostExcl: toNum(r.landed_cost_excl),
    locationId: r.location_id === null || r.location_id === undefined ? null : Number(r.location_id),
    sourceLineId:
      r.source_line_id === null || r.source_line_id === undefined ? null : Number(r.source_line_id),
    // Undefined until 163 reaches this site, which reads as null: no job link,
    // which is the truth on every line that predates the column.
    jobCardLineId:
      r.job_card_line_id === null || r.job_card_line_id === undefined
        ? null
        : Number(r.job_card_line_id),
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
    // Absent until 092 reaches this site; zero is the right answer there.
    discountExcl: toNum(r.discount_excl),
    discountPct: toNum(r.discount_pct),
    orderedFromId: r.ordered_from_id === null ? null : Number(r.ordered_from_id),
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    finalisedAt: (r.finalised_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
    fulfilmentStatus: (r.fulfilment_status as string | null) ?? null,
    expectedDate: r.expected_date === null || r.expected_date === undefined ? null : String(r.expected_date),
    supplierOrderNo: (r.supplier_order_no as string | null) ?? null,
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

/**
 * Where a set of products stands right now.
 *
 * The purchasing line grid previews what a delivery will do to average cost and
 * to margin, and both need the position BEFORE the receipt. A line pulled off a
 * purchase order carries neither: the order snapshotted a cost when it was
 * raised, which may be weeks stale, and never knew the stock figure at all.
 *
 * The default price structure, because that is the shelf price — the figure a
 * buyer is deciding whether the delivery still supports.
 */
export type ProductPosition = {
  productId: number
  stockOnHand: number
  averageCost: number
  lastCost: number
  sellIncl: number
  productType: string
}

export async function productPositions(
  siteId: number,
  productIds: readonly number[],
): Promise<ProductPosition[]> {
  if (productIds.length === 0) return []

  // Inlined rather than bound: these are integers filtered by the caller, and
  // a bound IN list of variable length needs the placeholders built anyway.
  const ids = productIds.filter((id) => Number.isInteger(id) && id > 0)
  if (ids.length === 0) return []

  // The default structure resolved to ONE id first. Joining on is_default
  // directly would multiply every product row if a site ever had two rows
  // flagged default — the column carries no unique key to prevent it.
  const structure = await siteQueryOne<Row>(
    siteId,
    'SELECT id FROM price_structures WHERE is_default = 1 ORDER BY position, id LIMIT 1',
  )
  const structureId = structure ? Number(structure.id) : 0

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT p.id, p.stock_on_hand, p.average_cost, p.last_cost, p.product_type,
            COALESCE(pp.selling_price_incl, 0) AS selling_price_incl
       FROM products p
       LEFT JOIN product_prices pp
              ON pp.product_id = p.id AND pp.price_structure_id = ?
      WHERE p.id IN (${ids.map(() => '?').join(',')})`,
    [structureId, ...ids],
  )

  return rows.map((r) => ({
    productId: Number(r.id),
    stockOnHand: toNum(r.stock_on_hand),
    averageCost: toNum(r.average_cost),
    lastCost: toNum(r.last_cost),
    sellIncl: toNum(r.selling_price_incl),
    productType: String(r.product_type ?? 'normal'),
  }))
}

/**
 * The itemised charges on a document — freight, duty, and who billed each.
 *
 * Returns nothing where 088 has not reached this site: such a document cannot
 * have charge rows, so an empty list is the correct answer rather than an
 * error. The total on the document itself is unaffected either way.
 */
export type PurchaseCharge = {
  id: number
  supplierId: number | null
  description: string
  amountExcl: number
  vatRatePct: number
  theirInvoiceNo: string | null
}

export async function documentCharges(
  siteId: number,
  documentId: number,
): Promise<PurchaseCharge[]> {
  const present = await siteQueryOne<Row>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_charges' LIMIT 1`,
  )
  if (!present) return []

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, supplier_id, description, amount_excl, vat_rate_pct, their_invoice_no
       FROM purchase_document_charges WHERE document_id = ? ORDER BY id`,
    [documentId],
  )

  return rows.map((r) => ({
    id: Number(r.id),
    supplierId: r.supplier_id === null ? null : Number(r.supplier_id),
    description: String(r.description),
    amountExcl: toNum(r.amount_excl),
    vatRatePct: toNum(r.vat_rate_pct),
    theirInvoiceNo: (r.their_invoice_no as string | null) ?? null,
  }))
}

/* ── Orders ──────────────────────────────────────────────────────────────── */

export type OrderLineInput = {
  productId?: number | null
  productCode?: string | null
  supplierCode?: string | null
  description: string
  productType?: string
  departmentId?: number | null
  /**
   * Where this line is MEANT to land. A destination, not a commitment.
   *
   * An order still moves nothing — the goods go into a pile at the door, and
   * receiveGoods() is what puts them there. What this buys is that a buyer
   * ordering ten cases for the warehouse and two for the shop says so once,
   * when they know it, rather than the receiver rebuilding the split from a
   * delivery note that does not carry it.
   *
   * So receiving INHERITS this and may override it, line by line. Null means
   * "wherever main is at the time", resolved by receiveGoods and never here:
   * an order raised in January must not be pinned to whichever location
   * happened to be main that morning.
   */
  locationId?: number | null
  qtyOrdered: number
  unitCostExcl: number
  discountPct?: number
  /** An absolute discount, which wins over the percentage — see 086. */
  discountAmount?: number
  vatRatePct: number
  /**
   * The job line this was bought for (163). Almost always null.
   *
   * ── WHY THIS HAS TO BE ON THE INPUT ────────────────────────────────────────
   *
   * Because saveOrder rewrites its lines wholesale — `DELETE FROM
   * purchase_document_lines WHERE document_id = ?` and then re-INSERT. A buyer
   * who edits an issued order to fix one quantity would otherwise blank the job
   * link on EVERY line of it, and nothing would report that: the order still
   * exists, the parts still arrive, and no job knows they were its.
   *
   * So every caller that rebuilds an order's lines must re-supply this, and the
   * order screen carries it through untouched. `reconcileJobPartRequests()` has
   * a bucket for the case where this was got wrong anyway.
   *
   * Purchasing learns nothing else about jobs: there is no job parameter on
   * saveOrder, and the decision logic lives on job_part_requests.
   */
  jobCardLineId?: number | null
}

export type OrderInput = {
  supplierId: number
  documentDate?: string
  expectedDate?: string | null
  reference?: string | null
  notes?: string | null
  /** Their reference for our order, quoted when chasing a late delivery. */
  supplierOrderNo?: string | null
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
    // The absolute amount wins over the percentage, and is capped at the line
    // — the same rule lineTotals() applies on the sales side. Capping matters
    // here rather than only in the UI: this function is the boundary, and a
    // discount larger than the line would post a negative order.
    const discount =
      (line.discountAmount ?? 0) > 0
        ? round(Math.min(line.discountAmount ?? 0, gross), 2)
        : round(gross * ((line.discountPct ?? 0) / 100), 2)
    const excl = round(gross - discount, 2)
    const vat = round(excl * (line.vatRatePct / 100), 2)
    return { excl, vat, incl: round(excl + vat, 2), discount }
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

    // 086 adds discount_amount. A site that has not had it applied yet must
    // still be able to save an order — the percentage is written either way,
    // and the amount is what the two disagree about by at most a cent.
    const hasDiscountAmount = await columnExistsTx(tx, 'purchase_document_lines', 'discount_amount')

    // 163 adds job_card_line_id, and a site that has not had it applied must
    // still be able to save an order — same tolerance, same reason.
    const hasJobLine = await columnExistsTx(tx, 'purchase_document_lines', 'job_card_line_id')

    // Locations that actually exist, so a stale dropdown cannot fail the save
    // on a foreign key. An id we do not recognise becomes null, which reads as
    // "wherever main is when it arrives" — the answer an order gave before it
    // could name a destination at all, and harmless because nothing has moved.
    const [locationRows] = await tx.execute('SELECT id FROM stock_locations')
    const knownLocations = new Set(
      (locationRows as RowDataPacket[]).map((r) => Number(r.id)),
    )

    for (const [index, line] of input.lines.entries()) {
      const c = computed[index]
      const locationId =
        line.locationId && knownLocations.has(line.locationId) ? line.locationId : null
      await tx.execute(
        `INSERT INTO purchase_document_lines
           (document_id, line_number, product_id, ${hasJobLine ? 'job_card_line_id, ' : ''}location_id,
            product_code, supplier_code,
            description, product_type, department_id, qty_ordered, qty_received, unit_cost_excl,
            discount_pct, ${hasDiscountAmount ? 'discount_amount, ' : ''}vat_rate_pct,
            line_total_excl, line_vat, line_total_incl)
         VALUES (?,?,?,${hasJobLine ? '?,' : ''}?,?,?,?,?,?,?,0,?,?,${hasDiscountAmount ? '?,' : ''}?,?,?,?)`,
        [
          id,
          index + 1,
          line.productId ?? null,
          // Re-supplied on every save, because the DELETE above just removed it.
          ...(hasJobLine ? [line.jobCardLineId ?? null] : []),
          locationId,
          line.productCode ?? null,
          line.supplierCode ?? null,
          line.description.trim().slice(0, 190),
          line.productType ?? 'normal',
          line.departmentId ?? null,
          round(line.qtyOrdered, 3).toFixed(3),
          round(line.unitCostExcl, 4).toFixed(4),
          (line.discountPct ?? 0).toFixed(3),
          ...(hasDiscountAmount ? [round(line.discountAmount ?? 0, 4).toFixed(4)] : []),
          line.vatRatePct.toFixed(3),
          c.excl.toFixed(4),
          c.vat.toFixed(4),
          c.incl.toFixed(4),
        ] as never,
      )
    }

    await tx.execute(
      `INSERT INTO purchase_order_details (document_id, expected_date, supplier_order_no)
            VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         expected_date     = VALUES(expected_date),
         supplier_order_no = VALUES(supplier_order_no)`,
      [id, input.expectedDate ?? null, input.supplierOrderNo?.trim() || null] as never,
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
/**
 * Issues an order, subject to the site's approval threshold.
 *
 * ── WHY THE CHECK IS HERE AND NOT ON THE SCREEN ──────────────────────────
 *
 * Because issuing is the act that commits the business to the spend. It claims
 * the document number, and it is the moment the order becomes something a
 * supplier can hold us to. A button greyed out in the UI is a suggestion — the
 * action behind it is the boundary, and this is that action.
 *
 * ── WHY A DRAFT IS THE PENDING STATE ─────────────────────────────────────
 *
 * There is no 'awaiting approval' status, deliberately. A draft that cannot be
 * issued IS an order awaiting approval, and it already behaves correctly
 * everywhere: it holds no document number, counts as nothing on order, appears
 * in the drafts filter, and can still be edited or cancelled. Adding a status
 * would mean touching the enum, the list filters, the badges and every query
 * that reads status — to express something the existing state already says.
 *
 * The approver does not "approve" and hand back; they issue it themselves.
 * Approval and issuing are the same act performed by the person entitled to do
 * it, and splitting them would invent a second thing to forget to do.
 */
export async function issueOrder(
  siteId: number,
  actor: Actor,
  id: number,
  /**
   * What the caller may do. Optional so existing callers — and any path where
   * the question does not arise — keep working; absent means "not checked
   * here", and the ACTION is the layer that supplies it. The threshold is only
   * ever enforced when a caller passes this.
   */
  capabilities?: CapabilitySet,
): Promise<SaveResult> {
  const doc = await getPurchaseDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That order no longer exists.' }
  if (doc.status !== 'draft') return { ok: false, error: `A ${doc.status} order cannot be issued.` }
  if (doc.lines.length === 0) return { ok: false, error: 'Add at least one line first.' }

  if (capabilities) {
    const gate = await approvalGate(siteId, doc.totalIncl)
    if (gate.needed && !can(capabilities, 'purchasing.approve')) {
      return {
        ok: false,
        error: `This order comes to ${formatMoney(doc.totalIncl)}, over the ${formatMoney(
          gate.threshold,
        )} approval limit. Someone who can approve large orders has to issue it.`,
      }
    }
  }

  // Probed outside the transaction — information_schema does not change
  // mid-flight, and a site 139 has not reached must still be able to issue.
  const auditable = await purchaseAuditTableExists(siteId)

  await siteTransaction(siteId, async (tx) => {
    const documentNumber = await nextDocumentNumber(tx, 'purchase_order')
    await tx.execute(
      "UPDATE purchase_documents SET status = 'issued', document_number = ? WHERE id = ?",
      [documentNumber, id] as never,
    )
    if (auditable) {
      await tx.execute(
        `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
         VALUES (?, 'issued', ?, ?, ?)`,
        [
          id,
          `${documentNumber} · ${doc.supplierName ?? ''}`,
          actor.userId,
          actor.userName.slice(0, 120),
        ] as never,
      )
    }
  })

  return { ok: true, id }
}

/**
 * Whether an order of this size needs somebody else's signature.
 *
 * VAT-INCLUSIVE, because that is what the business actually pays and what is
 * written on the order. Reading the exclusive figure against a threshold the
 * owner typed as a real-money number would wave through every order at 15%
 * over the line they meant to draw.
 *
 * A zero or unreadable threshold means OFF rather than "everything needs
 * approval". A setting that fails open is the right call here: the failure
 * mode is a shop that can still buy stock, not a shop that cannot.
 */
export async function approvalGate(
  siteId: number,
  totalIncl: number,
): Promise<{ needed: boolean; threshold: number }> {
  let threshold = 0
  try {
    threshold = await getNumericSetting(siteId, 'purchase_approval_threshold')
  } catch {
    return { needed: false, threshold: 0 }
  }
  if (!Number.isFinite(threshold) || threshold <= 0) return { needed: false, threshold: 0 }
  // Half a cent of slack, so an order that lands exactly on the threshold from
  // a sum of rounded lines is not pushed over by floating point.
  return { needed: totalIncl > threshold + 0.005, threshold }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/** Cancels an order. Only ever a draft or an issued one — nothing was received. */
export async function cancelOrder(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<DeleteResult> {
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
  if (await purchaseAuditTableExists(siteId)) {
    await siteExecute(
      siteId,
      `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'cancelled', ?, ?, ?)`,
      [
        id,
        `${doc.documentNumber ?? `#${id}`} · ${reason.trim().slice(0, 300) || 'Cancelled'}`,
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )
  }
  return { ok: true }
}

/**
 * Closes an order that will never be completed.
 *
 * ── WHY THIS IS NOT cancelOrder ──────────────────────────────────────────
 *
 * Because something ARRIVED. cancelOrder refuses a part-received order on
 * purpose — cancelling it would say the order never happened, while a GRV,
 * stock movements and a creditor entry all say it did. This does the opposite:
 * it accepts that what came is all that is coming, and stops the order asking
 * for the rest.
 *
 * ── WHAT IT ACTUALLY FIXES ───────────────────────────────────────────────
 *
 * An issued order counts as incoming stock in TWO places, both keyed on
 * `fulfilment_status IN ('open','part_received')`:
 *
 *   · openOrders(), which is what receiving offers and what the "On order"
 *     tile totals;
 *   · the `on_order` subquery in reorderSuggestions, which subtracts what is
 *     already coming from what to buy.
 *
 * So a supplier who short-ships three of ten and never sends the rest leaves
 * an order that permanently claims three units are on their way. The reorder
 * screen then quietly suggests three too few, FOREVER, and nobody connects the
 * empty shelf to a delivery from months ago. Marking the order 'received' —
 * meaning "as received as it is going to get" — removes it from both.
 *
 * The lines are left ALONE. qty_ordered stays ten and qty_received stays three,
 * because that is what happened, and it is the difference between the two that
 * a supplier-performance question is asking about later. Rewriting the order
 * down to what arrived would make every short delivery invisible.
 */
export type CloseShortResult = { ok: true; outstanding: number } | { ok: false; error: string }

export async function closeOrderShort(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<CloseShortResult> {
  const doc = await getPurchaseDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That order no longer exists.' }
  if (doc.docType !== 'purchase_order') {
    return { ok: false, error: `A ${doc.docLabel.toLowerCase()} is not closed from here.` }
  }
  // A draft was never sent, so there is nothing outstanding to give up on —
  // that is a cancel. A cancelled order is already closed.
  if (doc.status !== 'issued') {
    return { ok: false, error: 'Only an issued order can be closed short.' }
  }

  // Checked BEFORE the line arithmetic, because closing leaves the lines
  // exactly as they were — that is the point of it. An order already marked
  // received still shows three outstanding on its lines, so a guard that only
  // read the quantities would happily close it a second time and write a
  // duplicate audit row saying the same three units were written off twice.
  if (doc.fulfilmentStatus === 'received' || doc.fulfilmentStatus === 'cancelled') {
    return { ok: false, error: 'This order is already closed.' }
  }

  const outstanding = doc.lines.reduce(
    (sum, line) => sum + Math.max(line.qtyOrdered - line.qtyReceived, 0),
    0,
  )
  // Nothing outstanding means it is already fully received; refreshOrderFulfilment
  // would have said so. Offering to close it would be offering to do nothing.
  if (outstanding <= 0.0005) {
    return { ok: false, error: 'Everything on this order has arrived.' }
  }

  await siteExecute(
    siteId,
    "UPDATE purchase_order_details SET fulfilment_status = 'received' WHERE document_id = ?",
    [id],
  )
  // An order with no details row yet — raised before 017, or never received
  // against — still needs one, or COALESCE(…, 'open') keeps it in both queries.
  await siteExecute(
    siteId,
    `INSERT INTO purchase_order_details (document_id, fulfilment_status) VALUES (?, 'received')
     ON DUPLICATE KEY UPDATE fulfilment_status = 'received'`,
    [id],
  )

  if (await purchaseAuditTableExists(siteId)) {
    await siteExecute(
      siteId,
      `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'closed_short', ?, ?, ?)`,
      [
        id,
        `${doc.documentNumber ?? `#${id}`} · ${formatQtyShort(outstanding)} outstanding written off · ${
          reason.trim().slice(0, 200) || 'Closed short'
        }`.slice(0, 300),
        actor.userId,
        actor.userName.slice(0, 120),
      ],
    )
  }

  return { ok: true, outstanding: round(outstanding, 3) }
}

/** Trailing zeroes off a quantity, for an audit line read by a person. */
function formatQtyShort(qty: number): string {
  return String(round(qty, 3))
}

/** One purchase document's audit trail, newest last — the sales-side read. */
export type PurchaseAuditRow = {
  action: string
  detail: string | null
  userName: string
  createdAt: Date
}

export async function purchaseAudit(siteId: number, documentId: number): Promise<PurchaseAuditRow[]> {
  if (!(await purchaseAuditTableExists(siteId))) return []
  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT action, detail, user_name, created_at
       FROM purchase_document_audit
      WHERE document_id = ? ORDER BY created_at, id`,
    [documentId],
  )
  return rows.map((r) => ({
    action: String(r.action),
    detail: (r.detail as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }))
}

/**
 * Records that an order was pulled up on paper.
 *
 * The first print and every one after it are separate actions, because the
 * question asked afterwards is never "was this printed" — it is "did this
 * supplier get two copies of the same order", and that is answered by the
 * count of REPRINTS and who made them.
 *
 * Silent when 139 has not reached this site: schema drifts between sites, and
 * an order that would not print because a history table is missing is a far
 * worse failure than an order whose history panel is short a line.
 */
export async function recordOrderPrint(
  siteId: number,
  actor: Actor,
  doc: Pick<PurchaseDocument, 'id' | 'documentNumber' | 'supplierName'>,
  isReprint: boolean,
): Promise<void> {
  if (!(await purchaseAuditTableExists(siteId))) return
  await siteExecute(
    siteId,
    `INSERT INTO purchase_document_audit (document_id, action, detail, user_id, user_name)
     VALUES (?, ?, ?, ?, ?)`,
    [
      doc.id,
      isReprint ? 'reprinted' : 'printed',
      `${doc.documentNumber ?? `#${doc.id}`} · ${doc.supplierName ?? ''}`.slice(0, 300),
      actor.userId,
      actor.userName.slice(0, 120),
    ],
  )
}

async function purchaseAuditTableExists(siteId: number): Promise<boolean> {
  const row = await siteQueryOne<RowDataPacket>(
    siteId,
    `SELECT 1 AS ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'purchase_document_audit' LIMIT 1`,
  )
  return !!row
}

/**
 * Whether a column has actually reached this site's database.
 *
 * Schema drifts between sites: a file in sql/site/ is only real once the
 * runner has applied it there, and a concurrent migration can block the queue
 * for days. Writing to a column that is not there yet throws mid-transaction
 * and loses the whole save; probing lets the write degrade to what the site
 * does have instead.
 *
 * information_schema rather than SHOW COLUMNS: SHOW cannot be parameterised on
 * the table name, and this takes both names from callers.
 */
async function columnExistsTx(
  tx: PoolConnection,
  table: string,
  column: string,
): Promise<boolean> {
  const [rows] = await tx.execute(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column] as never,
  )
  return (rows as RowDataPacket[]).length > 0
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
