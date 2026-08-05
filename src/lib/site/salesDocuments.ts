import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { lineTotals, documentTotals, type LineTotals } from '../documentMath'
import type { ProductTypeId } from '../productTypes'

/**
 * Sales documents before they are posted.
 *
 * Everything here is about a document that has NOT been finalised: capturing
 * lines, parking a sale, recalling it. Nothing in this file moves stock, posts
 * to a ledger or issues a number — that is salesPosting.ts, and keeping the two
 * apart means the whole of "what happens when money changes hands" is one file
 * a reviewer can read end to end.
 *
 * A finalised document is IMMUTABLE. There is no updateFinalised() here, and
 * every write below refuses a document that has been posted.
 */

export const DOC_TYPES = ['quote', 'sales_order', 'invoice', 'credit_sale'] as const
export type SalesDocType = (typeof DOC_TYPES)[number]

/**
 * A document's state.
 *
 * There is no 'void'. A posted document that is undone is CANCELLED — the two
 * were separate values meaning the same thing, and 'void' is now reserved for
 * what the till does to a basket that never posted at all. Migration 022
 * merged them.
 */
export const DOC_STATUSES = ['draft', 'parked', 'issued', 'finalised', 'cancelled'] as const
export type SalesDocStatus = (typeof DOC_STATUSES)[number]

/**
 * What each document type is called on screen.
 *
 * These match the stored values one-for-one — `credit_sale` is what is in the
 * database and what the user reads. Kept as a table anyway so a label can be
 * reworded without a migration.
 *
 * Note this is the SALES side. The debtor and creditor ledgers keep
 * `credit_note` (see ledger.ts), because there it means an adjustment posted
 * directly to an account rather than the reversal of a sale. Two tables, two
 * meanings, two words — which is the whole point of the rename.
 */
export const DOC_LABELS: Record<SalesDocType, string> = {
  quote: 'Quote',
  sales_order: 'Sales order',
  invoice: 'Invoice',
  credit_sale: 'Credit sale',
}

export type SalesLine = {
  id: number
  documentId: number
  lineNumber: number
  productId: number | null
  productCode: string | null
  description: string
  productType: ProductTypeId
  departmentId: number | null
  qty: number
  qtyDelivered: number
  unitPriceIncl: number
  discountPct: number
  discountIncl: number
  vatRatePct: number
  lineTotalIncl: number
  lineTotalExcl: number
  lineVat: number
  unitCostExcl: number
}

export type SalesDocument = {
  id: number
  docType: SalesDocType
  docLabel: string
  status: SalesDocStatus
  documentNumber: string | null
  documentDate: string
  dueDate: string | null
  customerId: number | null
  customerCode: string | null
  customerName: string | null
  customerVatNo: string | null
  customerPhone: string | null
  customerAddress: string | null
  priceStructureId: number | null
  userId: number | null
  userName: string
  terminalId: number | null
  terminalCode: string | null
  subtotalExcl: number
  vatTotal: number
  discountTotal: number
  totalIncl: number
  roundingAdj: number
  tenderedTotal: number
  changeGiven: number
  convertedFromId: number | null
  reversesId: number | null
  reference: string | null
  notes: string | null
  internalNote: string | null
  voidReason: string | null
  voidedAt: Date | null
  finalisedAt: Date | null
  printCount: number
  createdAt: Date
  updatedAt: Date
  lines: SalesLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapLine(r: Row): SalesLine {
  return {
    id: Number(r.id),
    documentId: Number(r.document_id),
    lineNumber: Number(r.line_number),
    productId: r.product_id === null ? null : Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    description: String(r.description),
    productType: String(r.product_type) as ProductTypeId,
    departmentId: r.department_id === null ? null : Number(r.department_id),
    qty: toNum(r.qty),
    qtyDelivered: toNum(r.qty_delivered),
    unitPriceIncl: toNum(r.unit_price_incl),
    discountPct: toNum(r.discount_pct),
    discountIncl: toNum(r.discount_incl),
    vatRatePct: toNum(r.vat_rate_pct),
    lineTotalIncl: toNum(r.line_total_incl),
    lineTotalExcl: toNum(r.line_total_excl),
    lineVat: toNum(r.line_vat),
    unitCostExcl: toNum(r.unit_cost_excl),
  }
}

function mapDocument(r: Row, lines: SalesLine[]): SalesDocument {
  const docType = String(r.doc_type) as SalesDocType
  return {
    id: Number(r.id),
    docType,
    docLabel: DOC_LABELS[docType] ?? docType,
    status: String(r.status) as SalesDocStatus,
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date),
    dueDate: r.due_date === null ? null : String(r.due_date),
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    customerCode: (r.customer_code as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    customerVatNo: (r.customer_vat_no as string | null) ?? null,
    customerPhone: (r.customer_phone as string | null) ?? null,
    customerAddress: (r.customer_address as string | null) ?? null,
    priceStructureId: r.price_structure_id === null ? null : Number(r.price_structure_id),
    userId: r.user_id === null ? null : Number(r.user_id),
    userName: String(r.user_name ?? ''),
    terminalId: r.terminal_id === null ? null : Number(r.terminal_id),
    terminalCode: (r.terminal_code as string | null) ?? null,
    subtotalExcl: toNum(r.subtotal_excl),
    vatTotal: toNum(r.vat_total),
    discountTotal: toNum(r.discount_total),
    totalIncl: toNum(r.total_incl),
    roundingAdj: toNum(r.rounding_adj),
    tenderedTotal: toNum(r.tendered_total),
    changeGiven: toNum(r.change_given),
    convertedFromId: r.converted_from_id === null ? null : Number(r.converted_from_id),
    reversesId: r.reverses_id === null ? null : Number(r.reverses_id),
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    internalNote: (r.internal_note as string | null) ?? null,
    voidReason: (r.void_reason as string | null) ?? null,
    voidedAt: (r.voided_at as Date | null) ?? null,
    finalisedAt: (r.finalised_at as Date | null) ?? null,
    printCount: Number(r.print_count ?? 0),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    lines,
  }
}

const SELECT_DOC = `SELECT * FROM sales_documents`

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function getDocument(siteId: number, id: number): Promise<SalesDocument | null> {
  const [docRow, lineRows] = await Promise.all([
    siteQueryOne<Row>(siteId, `${SELECT_DOC} WHERE id = ? LIMIT 1`, [id]),
    siteQuery<Row>(
      siteId,
      'SELECT * FROM sales_document_lines WHERE document_id = ? ORDER BY line_number ASC, id ASC',
      [id],
    ),
  ])
  return docRow ? mapDocument(docRow, lineRows.map(mapLine)) : null
}

export type DocumentListOptions = {
  docTypes?: readonly SalesDocType[]
  statuses?: readonly SalesDocStatus[]
  search?: string
  customerId?: number
  terminalId?: number
  from?: string
  to?: string
  limit?: number
  offset?: number
}

/** The document list. Headers only — lines are loaded when one is opened. */
export async function listDocuments(
  siteId: number,
  opts: DocumentListOptions = {},
): Promise<{ items: SalesDocument[]; total: number }> {
  const where: string[] = []
  const params: unknown[] = []

  if (opts.docTypes?.length) {
    where.push(`doc_type IN (${opts.docTypes.map(() => '?').join(',')})`)
    params.push(...opts.docTypes)
  }
  if (opts.statuses?.length) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(',')})`)
    params.push(...opts.statuses)
  }
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(document_number LIKE ? OR customer_name LIKE ? OR reference LIKE ?)')
    params.push(term, term, term)
  }
  if (opts.customerId) {
    where.push('customer_id = ?')
    params.push(opts.customerId)
  }
  if (opts.terminalId) {
    where.push('terminal_id = ?')
    params.push(opts.terminalId)
  }
  if (opts.from) {
    where.push('document_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('document_date <= ?')
    params.push(opts.to)
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_DOC} ${whereSql} ORDER BY document_date DESC, id DESC LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<RowDataPacket & { total: number }>(
      siteId,
      `SELECT COUNT(*) AS total FROM sales_documents ${whereSql}`,
      params,
    ),
  ])

  return { items: rows.map((r) => mapDocument(r, [])), total: Number(countRow?.total ?? 0) }
}

/** Parked sales waiting to be recalled, for the till's recall list. */
export async function listParked(siteId: number, terminalId?: number): Promise<SalesDocument[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DOC} WHERE status = 'parked' ${terminalId ? 'AND terminal_id = ?' : ''}
      ORDER BY updated_at DESC LIMIT 50`,
    terminalId ? [terminalId] : [],
  )
  return rows.map((r) => mapDocument(r, []))
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type LineInput = {
  productId?: number | null
  productCode?: string | null
  description: string
  productType?: ProductTypeId
  departmentId?: number | null
  qty: number
  unitPriceIncl: number
  discountPct?: number
  discountIncl?: number
  vatRatePct: number
  unitCostExcl?: number
}

export type DocumentInput = {
  docType: SalesDocType
  documentDate?: string
  customerId?: number | null
  customerName?: string | null
  customerVatNo?: string | null
  customerPhone?: string | null
  customerAddress?: string | null
  priceStructureId?: number | null
  terminalId?: number | null
  terminalCode?: string | null
  reference?: string | null
  notes?: string | null
  lines: LineInput[]
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export function validateDocument(input: DocumentInput): string | null {
  if (!DOC_TYPES.includes(input.docType)) return 'Choose a document type.'
  if (input.lines.length === 0) return 'Add at least one line.'
  if (input.lines.length > 500) return 'A document cannot have more than 500 lines.'

  for (const [index, line] of input.lines.entries()) {
    const where = `Line ${index + 1}`
    if (!line.description?.trim()) return `${where}: a description is required.`
    if (!Number.isFinite(line.qty) || line.qty === 0) return `${where}: enter a quantity.`
    if (!Number.isFinite(line.unitPriceIncl) || line.unitPriceIncl < 0) {
      return `${where}: the price cannot be negative.`
    }
    if ((line.discountPct ?? 0) < 0 || (line.discountPct ?? 0) > 100) {
      return `${where}: discount must be between 0 and 100 percent.`
    }
    // A credit note is negative throughout; an invoice never is. Mixing the two
    // on one document produces totals nobody can explain.
    if (input.docType === 'credit_sale' && line.qty > 0) {
      return `${where}: credit note quantities must be negative.`
    }
    if (input.docType !== 'credit_sale' && line.qty < 0) {
      return `${where}: use a credit note for a negative quantity.`
    }
  }
  return null
}

/** Line totals plus document totals, all through documentMath. Never inline. */
export function computeTotals(lines: readonly LineInput[]) {
  const computed = lines.map((line) => ({
    ...lineTotals({
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: line.discountPct,
      discountIncl: line.discountIncl,
      vatRatePct: line.vatRatePct,
    }),
    vatRatePct: line.vatRatePct,
  }))
  return { lines: computed, totals: documentTotals(computed) }
}

/**
 * Creates or replaces a draft.
 *
 * Lines are deleted and rewritten wholesale rather than diffed: a capture
 * screen sends the whole basket every save, and matching up which line moved is
 * work with no payoff on a document that has not been posted.
 */
export async function saveDraft(
  siteId: number,
  actor: { userId: number; userName: string },
  input: DocumentInput,
  documentId?: number,
): Promise<SaveResult> {
  const invalid = validateDocument(input)
  if (invalid) return { ok: false, error: invalid }

  if (documentId) {
    const existing = await getDocument(siteId, documentId)
    if (!existing) return { ok: false, error: 'That document no longer exists.' }
    if (!isEditable(existing.status)) {
      return { ok: false, error: `A ${existing.status} document cannot be changed.` }
    }
    // Lines are rewritten wholesale below, which would reset qty_delivered to
    // zero — silently un-delivering goods that have already left the shop and
    // re-reserving stock for them. Once anything on an order has been
    // delivered, the order is a record of a part-completed commitment, not a
    // scratch pad. Cancel the balance instead.
    if (existing.lines.some((line) => line.qtyDelivered > 0)) {
      return {
        ok: false,
        error: 'Part of this order has been delivered, so it can no longer be edited. Cancel the undelivered balance instead.',
      }
    }
  }

  const { lines, totals } = computeTotals(input.lines)
  const documentDate = input.documentDate ?? todayIso()

  return siteTransaction(siteId, async (tx) => {
    let id = documentId

    if (id) {
      await tx.execute(
        `UPDATE sales_documents SET
           doc_type = ?, document_date = ?, customer_id = ?, customer_name = ?,
           customer_vat_no = ?, customer_phone = ?, customer_address = ?,
           price_structure_id = ?, terminal_id = ?, terminal_code = ?,
           reference = ?, notes = ?,
           subtotal_excl = ?, vat_total = ?, discount_total = ?, total_incl = ?
         WHERE id = ?`,
        [
          input.docType,
          documentDate,
          input.customerId ?? null,
          input.customerName?.trim() || null,
          input.customerVatNo?.trim() || null,
          input.customerPhone?.trim() || null,
          input.customerAddress?.trim() || null,
          input.priceStructureId ?? null,
          input.terminalId ?? null,
          input.terminalCode ?? null,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.discountTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
          id,
        ] as never,
      )
      await tx.execute('DELETE FROM sales_document_lines WHERE document_id = ?', [id] as never)
    } else {
      const [res] = await tx.execute(
        `INSERT INTO sales_documents
           (doc_type, status, document_date, customer_id, customer_name, customer_vat_no,
            customer_phone, customer_address, price_structure_id, user_id, user_name,
            terminal_id, terminal_code, reference, notes,
            subtotal_excl, vat_total, discount_total, total_incl)
         VALUES (?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          input.docType,
          documentDate,
          input.customerId ?? null,
          input.customerName?.trim() || null,
          input.customerVatNo?.trim() || null,
          input.customerPhone?.trim() || null,
          input.customerAddress?.trim() || null,
          input.priceStructureId ?? null,
          actor.userId,
          actor.userName.slice(0, 120),
          input.terminalId ?? null,
          input.terminalCode ?? null,
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          totals.subtotalExcl.toFixed(4),
          totals.vatTotal.toFixed(4),
          totals.discountTotal.toFixed(4),
          totals.totalIncl.toFixed(4),
        ] as never,
      )
      id = (res as { insertId: number }).insertId
    }

    for (const [index, line] of input.lines.entries()) {
      const computed = lines[index]
      await tx.execute(
        `INSERT INTO sales_document_lines
           (document_id, line_number, product_id, product_code, description, product_type,
            department_id, qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
            line_total_incl, line_total_excl, line_vat, unit_cost_excl)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          index + 1,
          line.productId ?? null,
          line.productCode ?? null,
          line.description.trim().slice(0, 190),
          line.productType ?? 'normal',
          line.departmentId ?? null,
          round(line.qty, 3).toFixed(3),
          round(line.unitPriceIncl, 4).toFixed(4),
          (line.discountPct ?? 0).toFixed(3),
          computed.discountIncl.toFixed(4),
          line.vatRatePct.toFixed(3),
          computed.lineTotalIncl.toFixed(4),
          computed.lineTotalExcl.toFixed(4),
          computed.lineVat.toFixed(4),
          (line.unitCostExcl ?? 0).toFixed(4),
        ] as never,
      )
    }

    return { ok: true as const, id: id! }
  })
}

/** Parks a draft so the counter can serve someone else. Touches nothing else. */
export async function parkDocument(siteId: number, id: number): Promise<SaveResult> {
  const doc = await getDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That document no longer exists.' }
  if (!isEditable(doc.status)) return { ok: false, error: `A ${doc.status} sale cannot be parked.` }

  await siteExecute(siteId, "UPDATE sales_documents SET status = 'parked' WHERE id = ?", [id])
  return { ok: true, id }
}

export async function recallDocument(siteId: number, id: number): Promise<SaveResult> {
  const doc = await getDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }
  if (doc.status !== 'parked') return { ok: false, error: 'That sale is not parked.' }

  await siteExecute(siteId, "UPDATE sales_documents SET status = 'draft' WHERE id = ?", [id])
  return { ok: true, id }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Discards an unposted document.
 *
 * Only ever a draft or a parked sale: those never had a number, never moved
 * stock and never posted, so nothing is lost. A finalised document is voided,
 * never deleted — it keeps its number so the sequence stays explainable.
 */
export async function discardDocument(siteId: number, id: number): Promise<DeleteResult> {
  const doc = await getDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That document no longer exists.' }
  if (doc.status === 'finalised' || doc.status === 'cancelled') {
    return {
      ok: false,
      error: 'A finalised document cannot be deleted. Void it or raise a credit note instead.',
    }
  }

  await siteExecute(siteId, 'DELETE FROM sales_documents WHERE id = ?', [id])
  return { ok: true }
}

/** Statuses that may still be edited. Everything else is a posted record. */
export function isEditable(status: SalesDocStatus): boolean {
  return status === 'draft' || status === 'parked' || status === 'issued'
}

export function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}

export function toDocType(value: unknown): SalesDocType | null {
  const raw = String(value ?? '')
  return (DOC_TYPES as readonly string[]).includes(raw) ? (raw as SalesDocType) : null
}

export function toDocStatus(value: unknown): SalesDocStatus | null {
  const raw = String(value ?? '')
  return (DOC_STATUSES as readonly string[]).includes(raw) ? (raw as SalesDocStatus) : null
}

export type { LineTotals }
