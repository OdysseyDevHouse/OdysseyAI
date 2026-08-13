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
 * lines, saving a sale, recalling it. Nothing in this file moves stock, posts
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
 * Where a document was captured.
 *
 * Not the same question as `terminalId`, which is only ever "which machine".
 * A back-office invoice captured on a machine claimed to a till records that
 * till AND stays 'back_office': it numbers from the shared run, and a lapsed
 * till claim does not stop it posting. Migration 099 has the reasoning.
 */
export type DocumentOrigin = 'till' | 'back_office'

/**
 * A document's state.
 *
 * There is no 'void'. A posted document that is undone is CANCELLED — the two
 * were separate values meaning the same thing, and "void" is now reserved for
 * what the till does to a basket that never posted at all. Migration 022
 * merged the values; 029 renamed the companion columns to match.
 */
export const DOC_STATUSES = ['draft', 'saved', 'issued', 'finalised', 'cancelled'] as const
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
  /** Who sold this line. Null on most: a till sale is not a commission event. */
  salesRepId: number | null
  salesRepName: string | null
  /** The site user commission is paid to for this line — see 043. */
  salesRepUserId: number | null
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
  /**
   * The special that caused this line's discount, if one did.
   *
   * The reduction itself is in `discountPct` — this records WHY, so a
   * promotion's cost and effectiveness can be reported on rather than
   * guessed at. Null for an ordinary line, or a discount given by hand.
   */
  specialId: number | null
  /**
   * The answers given when the till asked this product's questions.
   *
   * Read back for the same reason they are stored: a recalled table bill has to
   * come back to the till carrying what the customer ordered, and a document
   * screen has to be able to show it. Empty on every line that was never asked
   * anything, which is most of them.
   */
  instructions: SalesLineInstruction[]
  /** The free-text note on this line. Empty string when there is none. */
  note: string
}

/** One answer as recorded against a sale line. All of it snapshotted. */
export type SalesLineInstruction = {
  id: number
  groupId: number | null
  groupName: string
  optionId: number | null
  optionName: string
  /** How many of it ONE ITEM on the line carries. */
  qty: number
  priceAdjustIncl: number
  /** What it contributed across the whole line. Already inside the line total. */
  lineAdjustIncl: number
  productId: number | null
  stockQtyPer: number
  printsOnKitchen: boolean
  printsOnReceipt: boolean
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
  origin: DocumentOrigin
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
  /** Covers and visit type — set by the hospitality till only. See 125. */
  personCount: number | null
  visitTypeId: number | null
  internalNote: string | null
  cancelReason: string | null
  /**
   * The coded reason a sale was cancelled, and the coded reason goods came back.
   *
   * Both nullable and both stay that way: every void and credit note raised
   * before 102 carries free text and no code, and back-filling one would be
   * inventing a fact about trade that already happened.
   */
  cancelReasonId: number | null
  returnReasonId: number | null
  cancelledAt: Date | null
  finalisedAt: Date | null
  printCount: number
  createdAt: Date
  updatedAt: Date
  lines: SalesLine[]
}

type Row = RowDataPacket & Record<string, unknown>

function mapLineInstruction(r: Row): SalesLineInstruction {
  return {
    id: Number(r.id),
    groupId: r.group_id === null || r.group_id === undefined ? null : Number(r.group_id),
    groupName: String(r.group_name ?? ''),
    optionId: r.option_id === null || r.option_id === undefined ? null : Number(r.option_id),
    optionName: String(r.option_name ?? ''),
    qty: toNum(r.qty),
    priceAdjustIncl: toNum(r.price_adjust_incl),
    lineAdjustIncl: toNum(r.line_adjust_incl),
    productId: r.product_id === null || r.product_id === undefined ? null : Number(r.product_id),
    stockQtyPer: toNum(r.stock_qty_per),
    printsOnKitchen: !!r.prints_on_kitchen,
    printsOnReceipt: !!r.prints_on_receipt,
  }
}

/**
 * The answers on each of these lines, keyed by line id.
 *
 * One query for the whole document rather than one per line, and tolerant of the
 * table being absent so a site that has not run 082 yet still reads its own
 * invoices.
 */
async function instructionsForLines(
  siteId: number,
  lineIds: number[],
): Promise<Map<number, SalesLineInstruction[]>> {
  const map = new Map<number, SalesLineInstruction[]>()
  if (lineIds.length === 0) return map

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM sales_document_line_instructions
      WHERE line_id IN (${lineIds.map(() => '?').join(',')})
      ORDER BY line_id ASC, sort_order ASC, id ASC`,
    lineIds,
  ).catch(() => [] as Row[])

  for (const row of rows) {
    const lineId = Number(row.line_id)
    const chosen = mapLineInstruction(row)
    const list = map.get(lineId)
    if (list) list.push(chosen)
    else map.set(lineId, [chosen])
  }
  return map
}

function mapLine(r: Row, instructions: SalesLineInstruction[] = []): SalesLine {
  return {
    id: Number(r.id),
    documentId: Number(r.document_id),
    lineNumber: Number(r.line_number),
    productId: r.product_id === null ? null : Number(r.product_id),
    productCode: (r.product_code as string | null) ?? null,
    description: String(r.description),
    productType: String(r.product_type) as ProductTypeId,
    departmentId: r.department_id === null ? null : Number(r.department_id),
    salesRepId: r.sales_rep_id === null || r.sales_rep_id === undefined ? null : Number(r.sales_rep_id),
    salesRepName: (r.sales_rep_name as string | null) ?? null,
    salesRepUserId:
      r.sales_rep_user_id === null || r.sales_rep_user_id === undefined
        ? null
        : Number(r.sales_rep_user_id),
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
    specialId: r.special_id === null || r.special_id === undefined ? null : Number(r.special_id),
    instructions,
    note: String(r.line_note ?? ''),
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
    origin: (r.origin as DocumentOrigin | null) ?? 'till',
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
    /* Nullish rather than truthy: a table sat at by nobody yet is 0 covers,
       which is a fact, and `r.person_count ? …` would file it as "not set". */
    personCount: r.person_count === null || r.person_count === undefined
      ? null
      : Number(r.person_count),
    visitTypeId: r.visit_type_id ? Number(r.visit_type_id) : null,
    internalNote: (r.internal_note as string | null) ?? null,
    cancelReason: (r.cancel_reason as string | null) ?? null,
    cancelReasonId: r.cancel_reason_id ? Number(r.cancel_reason_id) : null,
    returnReasonId: r.return_reason_id ? Number(r.return_reason_id) : null,
    cancelledAt: (r.cancelled_at as Date | null) ?? null,
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
      // The rep's name is joined rather than snapshotted: unlike a product
      // description, it is not part of what the customer agreed to, and a rep
      // who marries should not leave last year's invoices under the old name.
      `SELECT l.*, r.name AS sales_rep_name
         FROM sales_document_lines l
         LEFT JOIN sales_reps r ON r.id = l.sales_rep_id
        WHERE l.document_id = ? ORDER BY l.line_number ASC, l.id ASC`,
      [id],
    ),
  ])
  if (!docRow) return null

  /*
   * The answers, in a second query rather than a join.
   *
   * A join would multiply each line by its answers, and a burger with three
   * toppings would come back as three burgers — which any caller summing the
   * lines would then charge for. Read separately and attached by line id.
   *
   * This is also what makes RECALL safe: a table bill is rebuilt from these
   * lines, and without the answers coming back with them, recalling a bill would
   * silently strip every modifier off it and reprice the line.
   */
  const instructions = await instructionsForLines(
    siteId,
    lineRows.map((r) => Number(r.id)),
  )

  return mapDocument(
    docRow,
    lineRows.map((r) => mapLine(r, instructions.get(Number(r.id)) ?? [])),
  )
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

/**
 * Saved sales waiting to be recalled, for the till's recall list.
 *
 * `terminalId` omitted means EVERY till in the shop. That is what the
 * hospitality gate wants: a waiter who opened table 12 on the bar till has to
 * be able to settle it at the pass, and a floor that only showed the tabs this
 * particular screen happened to open would strand the rest.
 *
 * LIMIT 200 rather than 50. Fifty is plenty of *parked retail* sales, but a
 * busy restaurant floor genuinely runs more than fifty open tabs at once, and a
 * truncated floor is a bill nobody can find — the one failure this list must
 * not have. Ordered by oldest-first so the tab that has been open longest is
 * the one that survives any cap at all.
 */
export async function listSaved(siteId: number, terminalId?: number): Promise<SalesDocument[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_DOC} WHERE status = 'saved' ${terminalId ? 'AND terminal_id = ?' : ''}
      ORDER BY updated_at DESC LIMIT 200`,
    terminalId ? [terminalId] : [],
  )
  return rows.map((r) => mapDocument(r, []))
}

/**
 * The same list, with the line count, total and visit-type NAME each tab needs
 * on a tile — resolved in one query instead of N+1 round trips per tab.
 *
 * A LEFT JOIN on the visit type, never an INNER: a tab whose visit type was
 * retired in the back office is still a live bill, and joining it away would
 * make it vanish off the floor rather than merely lose its label.
 */
export type OpenTabRow = {
  id: number
  reference: string | null
  customerName: string | null
  userName: string
  totalIncl: number
  lineCount: number
  personCount: number | null
  visitTypeId: number | null
  visitTypeName: string | null
  updatedAt: Date
}

export async function listOpenTabs(siteId: number): Promise<OpenTabRow[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.reference, d.customer_name, d.user_name, d.total_incl,
            d.person_count, d.visit_type_id, d.updated_at,
            v.name AS visit_type_name,
            (SELECT COUNT(*) FROM sales_document_lines l WHERE l.document_id = d.id) AS line_count
       FROM sales_documents d
       LEFT JOIN pos_visit_types v ON v.id = d.visit_type_id
      WHERE d.status = 'saved'
      ORDER BY d.updated_at DESC
      LIMIT 200`,
    [],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    reference: (r.reference as string | null) ?? null,
    customerName: (r.customer_name as string | null) ?? null,
    userName: String(r.user_name ?? ''),
    totalIncl: toNum(r.total_incl),
    lineCount: Number(r.line_count ?? 0),
    personCount:
      r.person_count === null || r.person_count === undefined ? null : Number(r.person_count),
    visitTypeId: r.visit_type_id ? Number(r.visit_type_id) : null,
    visitTypeName: (r.visit_type_name as string | null) ?? null,
    updatedAt: r.updated_at as Date,
  }))
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export type LineInput = {
  productId?: number | null
  productCode?: string | null
  description: string
  productType?: ProductTypeId
  departmentId?: number | null
  salesRepId?: number | null
  /**
   * The site user to pay commission to for this line, resolved at sale time.
   *
   * Separate from `salesRepId`: a rep is a commission-earning PERSON who may
   * not be a system user at all (012), while commission under 042 is paid to a
   * `users` row. Recorded here rather than joined through `users.sales_rep_id`
   * at calculation time, so re-pointing a user at a different rep cannot
   * silently re-attribute last month's sales.
   */
  salesRepUserId?: number | null
  /**
   * The invoice line this one reverses, on a credit note.
   *
   * Already used transiently to copy the original cost; persisting it is what
   * lets a commission clawback find the person who made the sale instead of
   * whoever processed the refund.
   */
  sourceLineId?: number | null
  qty: number
  unitPriceIncl: number
  discountPct?: number
  discountIncl?: number
  vatRatePct: number
  unitCostExcl?: number
  /**
   * The special that caused this line's discount, when one did.
   *
   * The discount itself still rides on `discountPct` — this only records WHY,
   * so "what did that promotion cost us, and did it sell anything" can be
   * answered from the sales data rather than guessed at. Null for an ordinary
   * line or a discount a cashier gave by hand.
   */
  specialId?: number | null
  /**
   * The discount code that caused this line's reduction, when one did.
   *
   * Alongside `specialId` rather than reusing it: a line can be reduced by a
   * special AND carry a code, and one column cannot record both. Without this
   * "what did that campaign cost us" is unanswerable from the sales data.
   */
  discountCodeId?: number | null
  /**
   * The answers given when the till asked this product's questions.
   *
   * Optional because most callers have none — a quote, a credit note, an
   * online-order conversion — and requiring an empty array of each of them would
   * be noise.
   *
   * ⚠ Their price is ALREADY INSIDE `unitPriceIncl`. These rows are the
   * breakdown of a figure that has been charged, not a further charge; adding
   * them to the totals would bill the customer twice for the same bacon.
   */
  instructions?: LineInstructionInput[]
  /** A free-text note for this line — "no ice", "allergy: nuts". */
  note?: string | null
}

/** One chosen answer, on its way into `sales_document_line_instructions`. */
export type LineInstructionInput = {
  groupId: number | null
  groupName: string
  optionId: number | null
  optionName: string
  /** How many of it ONE ITEM on the line carries. The line's qty multiplies. */
  qty: number
  /** What one adds, VAT-inclusive and signed. Snapshotted at sale time. */
  priceAdjustIncl: number
  productId?: number | null
  stockQtyPer?: number
  printsOnKitchen?: boolean
  printsOnReceipt?: boolean
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
  /**
   * Set on the INSERT only — a document does not change where it was captured.
   * Omitted means 'till', which is every caller that existed before 099.
   */
  origin?: DocumentOrigin
  reference?: string | null
  notes?: string | null
  /**
   * How many people are on this bill, and what kind of visit it is.
   *
   * Both belong to the DOCUMENT rather than to the table: a takeaway never
   * touches a table row, and a table that seats four can be sat at by two — so
   * reading either off `pos_tables` answers a different question from the one
   * being asked. See sql/site/125_sale_covers.sql.
   *
   * Undefined on every retail sale and every back-office document, which leaves
   * both columns NULL — the honest answer where the idea does not apply.
   */
  personCount?: number | null
  visitTypeId?: number | null
  /**
   * The till-generated uid of a sale rung up offline, and when the money actually
   * changed hands.
   *
   * Set in the INSERT rather than by a follow-up UPDATE so the document is never
   * momentarily on the books WITHOUT its uid: `uq_offline_uid` is what stops a
   * retried batch posting the same sale twice, and a window where the column is
   * still NULL is a window where that index cannot do its job.
   *
   * Both undefined for every online sale, which is what leaves the column NULL
   * and every existing caller unchanged.
   */
  offlineSaleUid?: string | null
  offlineTakenAt?: string | null
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
 * An empty invoice, for a capture screen that opens before anything is keyed.
 *
 * Separate from saveDraft because that rightly refuses a document with no
 * lines — a SAVE with an empty basket is a mistake, whereas a NEW invoice is
 * empty by definition. Written straight out rather than routed through the
 * validator, so the "at least one line" rule stays intact for every save that
 * follows this one.
 */
export async function createBlankInvoice(
  siteId: number,
  actor: { userId: number; userName: string },
): Promise<SaveResult> {
  const result = await siteExecute(
    siteId,
    `INSERT INTO sales_documents
       (doc_type, status, document_date, user_id, user_name, origin,
        subtotal_excl, vat_total, discount_total, total_incl)
     VALUES ('invoice','draft',?,?,?,'back_office',0,0,0,0)`,
    [todayIso(), actor.userId, actor.userName.slice(0, 120)],
  )

  return result.insertId
    ? { ok: true, id: result.insertId }
    : { ok: false, error: 'Could not start a new invoice.' }
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
           reference = ?, notes = ?, person_count = ?, visit_type_id = ?,
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
          input.personCount ?? null,
          input.visitTypeId ?? null,
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
            terminal_id, terminal_code, origin, reference, notes,
            person_count, visit_type_id,
            offline_sale_uid, offline_taken_at,
            subtotal_excl, vat_total, discount_total, total_incl)
         VALUES (?,'draft',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          input.origin ?? 'till',
          input.reference?.trim() || null,
          input.notes?.trim() || null,
          input.personCount ?? null,
          input.visitTypeId ?? null,
          input.offlineSaleUid ?? null,
          input.offlineTakenAt ?? null,
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
      const [lineRes] = await tx.execute(
        `INSERT INTO sales_document_lines
           (document_id, line_number, product_id, product_code, description, product_type,
            department_id, sales_rep_id, source_line_id, sales_rep_user_id,
            qty, unit_price_incl, discount_pct, discount_incl,
            vat_rate_pct, line_total_incl, line_total_excl, line_vat, unit_cost_excl,
            special_id, discount_code_id, line_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          id,
          index + 1,
          line.productId ?? null,
          line.productCode ?? null,
          line.description.trim().slice(0, 190),
          line.productType ?? 'normal',
          line.departmentId ?? null,
          line.salesRepId ?? null,
          line.sourceLineId ?? null,
          line.salesRepUserId ?? null,
          round(line.qty, 3).toFixed(3),
          round(line.unitPriceIncl, 4).toFixed(4),
          (line.discountPct ?? 0).toFixed(3),
          computed.discountIncl.toFixed(4),
          line.vatRatePct.toFixed(3),
          computed.lineTotalIncl.toFixed(4),
          computed.lineTotalExcl.toFixed(4),
          computed.lineVat.toFixed(4),
          (line.unitCostExcl ?? 0).toFixed(4),
          line.specialId ?? null,
          line.discountCodeId ?? null,
          (line.note ?? '').trim().slice(0, 190),
        ] as never,
      )

      /*
       * The answers, as their own rows under this line.
       *
       * ⚠ NOTHING HERE TOUCHES THE TOTALS. `unit_price_incl` above already has
       * the adjustment folded in — that is what makes specials, discounts and
       * VAT price the item as it was actually sold — so these rows record WHAT
       * was chosen and what each part of the price was for. Summing
       * line_adjust_incl alongside line_total_incl double-counts.
       *
       * No delete pass is needed on a re-save: the wholesale
       * `DELETE FROM sales_document_lines` above takes them with it by cascade.
       */
      if (line.instructions?.length) {
        const lineId = (lineRes as { insertId: number }).insertId
        for (const [i, chosen] of line.instructions.entries()) {
          const per = round(chosen.qty, 3)
          await tx.execute(
            `INSERT INTO sales_document_line_instructions
               (line_id, document_id, sort_order, group_id, group_name, option_id, option_name,
                qty, price_adjust_incl, line_adjust_incl,
                product_id, stock_qty_per, prints_on_kitchen, prints_on_receipt)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              lineId,
              id,
              i,
              chosen.groupId ?? null,
              (chosen.groupName ?? '').slice(0, 120),
              chosen.optionId ?? null,
              (chosen.optionName ?? '').slice(0, 120),
              per.toFixed(3),
              round(chosen.priceAdjustIncl ?? 0, 4).toFixed(4),
              // What it contributed across the whole line, for reporting.
              round((chosen.priceAdjustIncl ?? 0) * per * line.qty, 4).toFixed(4),
              chosen.productId ?? null,
              round(chosen.stockQtyPer ?? 0, 3).toFixed(3),
              chosen.printsOnKitchen === false ? 0 : 1,
              chosen.printsOnReceipt === false ? 0 : 1,
            ] as never,
          )
        }
      }
    }

    return { ok: true as const, id: id! }
  })
}

/** Saves a draft so the counter can serve someone else. Touches nothing else. */
export async function saveForLaterDocument(siteId: number, id: number): Promise<SaveResult> {
  const doc = await getDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That document no longer exists.' }
  if (!isEditable(doc.status)) return { ok: false, error: `A ${doc.status} sale cannot be saved.` }

  await siteExecute(siteId, "UPDATE sales_documents SET status = 'saved' WHERE id = ?", [id])
  return { ok: true, id }
}

export async function recallDocument(siteId: number, id: number): Promise<SaveResult> {
  const doc = await getDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }
  if (doc.status !== 'saved') return { ok: false, error: 'That sale is not saved.' }

  await siteExecute(siteId, "UPDATE sales_documents SET status = 'draft' WHERE id = ?", [id])
  return { ok: true, id }
}

export type DeleteResult = { ok: true } | { ok: false; error: string }

/**
 * Discards an unposted document.
 *
 * Only ever a draft or a saved sale: those never had a number, never moved
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
  return status === 'draft' || status === 'saved' || status === 'issued'
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
