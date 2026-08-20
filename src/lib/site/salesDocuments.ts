import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import {
  siteQuery,
  siteQueryOne,
  siteExecute,
  siteTransaction,
  MASTER,
  type SitePurpose,
} from '../siteDb'
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
  /** The gift card a `gift_card` line sold (147). Null on ordinary lines. */
  giftCardCode: string | null
  /**
   * The answers given when the till asked this product's questions.
   *
   * Read back for the same reason they are stored: a recalled table bill has to
   * come back to the till carrying what the customer ordered, and a document
   * screen has to be able to show it. Empty on every line that was never asked
   * anything, which is most of them.
   */
  instructions: SalesLineInstruction[]
  /** How much of this line the kitchen has been told about (142). */
  kitchenSentQty: number
  /** The free-text note on this line. Empty string when there is none. */
  note: string
  /**
   * When the line was first rung, as epoch milliseconds (167).
   *
   * Null on any line written before 167 and on every line from a caller with no
   * such notion. A reader wanting an age should fall back to its own clock
   * rather than treating null as zero, which would report 1970.
   */
  orderedAt: number | null
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
  purpose: SitePurpose = MASTER,
): Promise<Map<number, SalesLineInstruction[]>> {
  const map = new Map<number, SalesLineInstruction[]>()
  if (lineIds.length === 0) return map

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT * FROM sales_document_line_instructions
      WHERE line_id IN (${lineIds.map(() => '?').join(',')})
      ORDER BY line_id ASC, sort_order ASC, id ASC`,
    lineIds,
    purpose,
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
    giftCardCode:
      r.gift_card_code === null || r.gift_card_code === undefined ? null : String(r.gift_card_code),
    instructions,
    note: String(r.line_note ?? ''),
    // Tolerant of a site that has not run 142 — toNum(undefined) reads 0,
    // which is also the truthful answer: nothing was ever sent.
    kitchenSentQty: toNum(r.kitchen_sent_qty),
    // Likewise tolerant of a site that has not run 167: absent reads null,
    // meaning "no recorded order time", NOT the epoch.
    orderedAt: orderedAtMillis(r.ordered_at),
  }
}

/**
 * A stored `ordered_at` back to epoch milliseconds.
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of the driver's
 * Date ARE the stored wall clock — and since this column only ever holds a UTC
 * instant this side wrote, reading `getTime()` off it is exact. The string branch
 * is defensive, for a driver configured with `dateStrings`: that shape has no
 * zone, so it is stamped as UTC to match what `orderedAtSql` wrote.
 *
 * `String(value)` is the trap here, as everywhere else in this codebase: it
 * yields a locale string that `Date.parse` reads in local time, which would put
 * every line's age two hours out on a SAST machine.
 */
function orderedAtMillis(value: unknown): number | null {
  if (!value) return null
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isNaN(ms) ? null : ms
  }
  if (typeof value === 'string') {
    const ms = Date.parse(`${value.replace(' ', 'T').slice(0, 19)}Z`)
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

/**
 * Epoch milliseconds to the `DATETIME` string this column stores.
 *
 * UTC parts, because the pool talks to the server in 'Z' — writing local parts
 * would store a figure two hours off what `orderedAtMillis` reads back, and the
 * till would show every line as two hours old the moment a tab was recalled.
 */
function orderedAtSql(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
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

/**
 * One document, with its lines.
 *
 * ── THE `purpose` ARGUMENT, AND WHY IT IS NOT A MODULE-WIDE SWITCH ────────
 *
 * On a HYBRID site an open tab lives on the shop's own box, while every other
 * document — quotes, orders, finalised invoices, anything the back office
 * touches — stays in the cloud. Those are the same table in two databases, so
 * the choice cannot be made per-module: this file is imported by 57 files, and
 * routing all of it would send the whole sales system to a box holding twelve
 * tables.
 *
 * So it is made per CALL, by the caller that knows what it is holding.
 * `tableActions.ts` passes `await tabPurpose(siteId)` because a table's bill is
 * a tab; everything else omits it and gets the cloud, exactly as before.
 *
 * Defaulting to the cloud is deliberate. A caller that forgets reads a document
 * that is genuinely there — wrong, but not corrupt — whereas defaulting to the
 * box would send every back-office read to a machine in a restaurant.
 */
export async function getDocument(
  siteId: number,
  id: number,
  purpose: SitePurpose = MASTER,
): Promise<SalesDocument | null> {
  const [docRow, lineRows] = await Promise.all([
    siteQueryOne<Row>(siteId, `${SELECT_DOC} WHERE id = ? LIMIT 1`, [id], purpose),
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
      purpose,
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
    purpose,
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
   * The gift card a `gift_card` line sells, captured at ADD time (147).
   *
   * On the line rather than the finalise input so a parked or recalled draft
   * keeps the code with the sale it belongs to. The posting engine activates
   * the card inside the finalise transaction.
   */
  giftCardCode?: string | null
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
  /**
   * When this line was FIRST rung, as epoch milliseconds (167).
   *
   * Sent by the till so a line's age survives park and recall. It cannot be
   * inferred here: a table bill rewrites its lines wholesale on every save, so
   * `created_at` would restart the clock each time a waiter added a round and a
   * forty-minute-old starter would report as new.
   *
   * Omitted by every caller that has no such notion — a quote, an online order,
   * a credit note — and stored NULL, which reads back as "no recorded order
   * time" rather than as the epoch.
   */
  orderedAt?: number | null
}

/**
 * Stamps every line with who sold it, unless the line already names someone.
 *
 * ── WHY THIS IS IN THE LIB AND NOT IN AN ACTIONS FILE ──────────────────────
 *
 * It lived as a private helper in the sales actions, so the RESTAURANT table
 * actions — which call `saveDraft` directly rather than going through
 * `saveSaleAction` — never stamped anything. Every line on every table bill was
 * left with `sales_rep_user_id = NULL`, which `staffCost.ts` filters out
 * entirely: table sales were silently absent from staff cost, and commission
 * fell back to whoever captured the header for all of them.
 *
 * Living beside `LineInput` means any future path that builds lines has it in
 * reach, which is the property the private copy did not have.
 *
 * ── PASS THE TILL OPERATOR, NOT THE BROWSER USER ───────────────────────────
 *
 * This decides who gets paid. Callers must resolve the actor with
 * `withTillOperator` first — a value the client supplies is a value the client
 * can choose, and the browser session on a shared floor machine is whoever
 * opened it that morning.
 *
 * A line that already names someone keeps them: the back-office invoicing
 * screen sets it per line deliberately, and that answer must not be overwritten.
 */
export function attributeTo<T extends { salesRepUserId?: number | null }>(
  lines: T[],
  userId: number,
): T[] {
  return lines.map((line) => ({ ...line, salesRepUserId: line.salesRepUserId ?? userId }))
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
 * An empty document, for a capture screen that opens before anything is keyed.
 *
 * Separate from saveDraft because that rightly refuses a document with no
 * lines — a SAVE with an empty basket is a mistake, whereas a NEW one is empty
 * by definition. Written straight out rather than routed through the validator,
 * so the "at least one line" rule stays intact for every save that follows.
 *
 * ── WHY IT TAKES A DOC TYPE ───────────────────────────────────────────────
 *
 * It used to hardcode 'invoice', which is why Invoicing had a working New
 * button and Quotes did not: `newQuoteAction` called saveDraft with no lines,
 * was correctly refused, and returned silently — so "New quotation" did
 * nothing at all, with no error to explain it.
 *
 * A quote, an order and an invoice are the same document at different moments,
 * and all three are captured on the same editor. One function, one shape.
 */
export async function createBlankDocument(
  siteId: number,
  actor: { userId: number; userName: string },
  docType: SalesDocType = 'invoice',
  /**
   * Where this is being captured.
   *
   * Defaults to `back_office` because that is what every caller outside the
   * invoicing window is — a contract raising an invoice, a job card, an
   * automation. The INVOICING window passes `till`, because it is a counter
   * screen with a PIN gate and a claimed till, and its documents number from
   * that till's own run like any other counter sale. See the note on
   * `numberSegmentsFor`.
   */
  origin: DocumentOrigin = 'back_office',
): Promise<SaveResult> {
  if (!DOC_TYPES.includes(docType)) {
    return { ok: false, error: 'That is not a document type this shop writes.' }
  }

  const result = await siteExecute(
    siteId,
    `INSERT INTO sales_documents
       (doc_type, status, document_date, user_id, user_name, origin,
        subtotal_excl, vat_total, discount_total, total_incl)
     VALUES (?,'draft',?,?,?,?,0,0,0,0)`,
    [docType, todayIso(), actor.userId, actor.userName.slice(0, 120), origin],
  )

  return result.insertId
    ? { ok: true, id: result.insertId }
    : { ok: false, error: `Could not start a new ${DOC_LABELS[docType].toLowerCase()}.` }
}

/**
 * The invoice-shaped call, kept so existing callers are undisturbed.
 *
 * @deprecated Prefer `createBlankDocument`, which says which kind it is making.
 */
export async function createBlankInvoice(
  siteId: number,
  actor: { userId: number; userName: string },
): Promise<SaveResult> {
  return createBlankDocument(siteId, actor, 'invoice')
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
  /* Where this document lives. See the note on getDocument: a table's bill goes
     to the shop's box on a hybrid site, everything else to the cloud. One
     purpose covers the whole write because it is a single transaction. */
  purpose: SitePurpose = MASTER,
): Promise<SaveResult> {
  const invalid = validateDocument(input)
  if (invalid) return { ok: false, error: invalid }

  if (documentId) {
    const existing = await getDocument(siteId, documentId, purpose)
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
            special_id, discount_code_id, gift_card_code, line_note, ordered_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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
          line.giftCardCode ?? null,
          (line.note ?? '').trim().slice(0, 190),
          orderedAtSql(line.orderedAt),
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
  }, purpose)
}

/** Saves a draft so the counter can serve someone else. Touches nothing else. */
export async function saveForLaterDocument(
  siteId: number,
  id: number,
  purpose: SitePurpose = MASTER,
): Promise<SaveResult> {
  const doc = await getDocument(siteId, id, purpose)
  if (!doc) return { ok: false, error: 'That document no longer exists.' }
  if (!isEditable(doc.status)) return { ok: false, error: `A ${doc.status} sale cannot be saved.` }

  await siteExecute(
    siteId,
    "UPDATE sales_documents SET status = 'saved' WHERE id = ?",
    [id],
    purpose,
  )
  return { ok: true, id }
}

/**
 * How long a claim made by a USER survives without being renewed.
 *
 * Legacy. Applies only to claims taken before 177, which recorded a user and no
 * terminal — see that migration for why those age out rather than being
 * converted. A terminal claim does not expire at all.
 */
export const CLAIM_LEASE_MINUTES = 15

/**
 * The statuses a document may be HELD in.
 *
 * ── WHY THIS IS A SET AND NOT `'saved'` ───────────────────────────────────
 *
 * The claim was built for parked baskets, which are always `saved`, and the
 * status was written into the predicate as a literal in three places. Then the
 * till learned to open quotes — and quotes are never `saved`. They are `draft`
 * while being written and `issued` once sent, so every attempt to open one at a
 * till was refused with "That sale is not saved", a message about a concept the
 * cashier had not used. Found by driving the screen: the list worked, the tap
 * worked, and the basket stayed empty.
 *
 * What belongs here is anything a person can still EDIT, because that is what
 * the claim protects — two tills writing over each other's changes.
 *
 * What must never be here is `finalised` or `cancelled`. Those are closed: the
 * money is taken or the document is dead, and a claim on one would suggest it
 * could still be worked on. `issued` IS claimable — an issued quote can be
 * recalled, re-priced and re-sent, which is an ordinary thing to do to one.
 */
export const CLAIMABLE_STATUSES = ['draft', 'saved', 'issued'] as const

/* Inlined into the SQL rather than parameterised: these are our own literals,
   never user input, and keeping the count of `?` placeholders stable across
   three predicates is worth more than the uniformity. */
const CLAIMABLE_SQL = CLAIMABLE_STATUSES.map((s) => `'${s}'`).join(',')

/** Who is holding a bill, for the message that refuses somebody else. */
export type DocumentClaim = {
  terminalId: number | null
  terminalCode: string | null
  userName: string | null
  claimedAt: Date | null
}

/**
 * Takes a document for one TILL, refusing it to every other.
 *
 * ── THE RACE IS DECIDED BY THE UPDATE, NOT BY THE READ ────────────────────
 *
 * The WHERE clause is the entire guarantee. Two tills recalling the same bill both
 * reach this line; the database applies the updates one after the other, so the first
 * matches an unclaimed row and the second finds a row that no longer satisfies the
 * predicate and reports zero rows changed. Reading first and then writing would leave a
 * window between the two where both saw it free.
 *
 * ── THE SAME TILL ALWAYS GETS ITS OWN BILL BACK ───────────────────────────
 *
 * `claimed_terminal_id = ?` in the predicate is what makes a reclaim free. A till
 * that reloads, crashes, or is switched off and on again is holding its own claim,
 * and must not be locked out of a bill by itself — which is what a user-owned
 * claim did to the next person to sign in at that machine.
 *
 * Note it does NOT check who is signed in. The terminal owns the claim, so the
 * night shift resumes what the day shift left on that till without a supervisor.
 * What they may DO with it is still their own capabilities, and the sale is
 * attributed to whoever finalises it.
 *
 * ── AND NOBODY ELSE GETS IT WITHOUT A DECISION ────────────────────────────
 *
 * A claim held by another terminal does not expire, because a till that is merely
 * OFFLINE looks exactly like one that is dead and is probably still adding to the
 * bill. Breaking it is a supervisor's call — see `overrideClaim` — made by
 * somebody who can see whether that machine is actually off.
 */
export async function claimDocument(
  siteId: number,
  id: number,
  userId: number,
  terminalId: number | null,
  purpose: SitePurpose = MASTER,
): Promise<SaveResult> {
  const doc = await getDocument(siteId, id, purpose)
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }
  /* See CLAIMABLE_STATUSES. This insisted on `saved`, which is right for a
     parked basket and refused every quote — they are never saved. */
  if (!(CLAIMABLE_STATUSES as readonly string[]).includes(doc.status)) {
    return { ok: false, error: 'That document can no longer be worked on.' }
  }

  /*
   * An UNCLAIMED terminal cannot hold a claim, so it falls back to the old
   * user-owned rule with its lease. That is the back office and any machine
   * nobody has linked to a till — neither is a shop floor with two people
   * reaching for one bill, and giving them no claim at all would be worse.
   */
  if (terminalId === null) {
    const claimed = await siteExecute(
      siteId,
      `UPDATE sales_documents
          SET claimed_by = ?, claimed_at = UTC_TIMESTAMP()
        WHERE id = ?
          AND status IN (${CLAIMABLE_SQL})
          AND claimed_terminal_id IS NULL
          AND (claimed_at IS NULL
               OR claimed_by = ?
               OR claimed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)`,
      [userId, id, userId, CLAIM_LEASE_MINUTES],
      purpose,
    )
    if (claimed.affectedRows === 0) return { ok: false, error: 'That sale has already been taken.' }
    return { ok: true, id }
  }

  /*
   * Three ways a till may take this bill, and no fourth:
   *
   *   · nothing holds it, and no legacy user claim is still inside its lease
   *   · THIS terminal already holds it — a reload must not lock a till out of
   *     its own bill
   *   · a pre-177 user claim has aged out, which is how the last of those drain
   *     away (see the migration on why they are not converted)
   *
   * A claim held by ANOTHER terminal matches none of them and never ages out.
   * Only overrideClaim breaks that, and only a supervisor reaches it.
   */
  const claimed = await siteExecute(
    siteId,
    `UPDATE sales_documents
        SET claimed_terminal_id = ?, claimed_by = ?, claimed_at = UTC_TIMESTAMP()
      WHERE id = ?
        AND status IN (${CLAIMABLE_SQL})
        AND (claimed_terminal_id = ?
             OR (claimed_terminal_id IS NULL
                 AND (claimed_at IS NULL
                      OR claimed_by = ?
                      OR claimed_at < UTC_TIMESTAMP() - INTERVAL ? MINUTE)))`,
    [terminalId, userId, id, terminalId, userId, CLAIM_LEASE_MINUTES],
    purpose,
  )
  if (claimed.affectedRows === 0) {
    return { ok: false, error: 'That sale is open on another till.' }
  }
  return { ok: true, id }
}

/**
 * Who is holding this bill — for the message that refuses somebody else.
 *
 * A lock that says only "no" gets worked around; one that says which till has
 * it and since when is one a supervisor can act on. Returns null when nothing
 * holds it.
 */
export async function documentClaim(
  siteId: number,
  id: number,
  purpose: SitePurpose = MASTER,
): Promise<DocumentClaim | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT d.claimed_terminal_id, d.claimed_at, t.code AS terminal_code, u.name AS user_name
       FROM sales_documents d
       LEFT JOIN terminals t ON t.id = d.claimed_terminal_id
       LEFT JOIN users u ON u.id = d.claimed_by
      WHERE d.id = ?`,
    [id],
    purpose,
  )
  if (!row || (!row.claimed_terminal_id && !row.claimed_at)) return null
  return {
    terminalId: row.claimed_terminal_id ? Number(row.claimed_terminal_id) : null,
    terminalCode: row.terminal_code ? String(row.terminal_code) : null,
    userName: row.user_name ? String(row.user_name) : null,
    claimedAt: (row.claimed_at as Date | null) ?? null,
  }
}

/**
 * Breaks another till's claim, on a supervisor's authority.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────────────
 *
 * A terminal claim does not expire (177), which closes the hole where a till
 * that was merely offline had its bill taken out from under it. That leaves the
 * opposite hole: a till that is genuinely dead — the power supply went, somebody
 * took it away — holds its bill forever, and a table nobody can serve is not an
 * acceptable resting state for a shop.
 *
 * A person can tell those apart by looking at the floor. A timeout cannot. So
 * the override is a deliberate act by somebody with the right, recorded, rather
 * than a rule that fires on a clock.
 *
 * ── WHAT THE OTHER TILL LOSES ─────────────────────────────────────────────
 *
 * Whatever it did while holding the claim. It comes back to find the bill taken,
 * and its own copy is discarded rather than merged: merging two divergent
 * baskets needs somebody to decide which of two prices for the same line is
 * right, and doing that silently is how a shop ends up billing the wrong figure.
 * Losing is predictable and visible; merging is neither.
 */
export async function overrideClaim(
  siteId: number,
  id: number,
  terminalId: number | null,
  userId: number,
): Promise<SaveResult> {
  const doc = await getDocument(siteId, id)
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }
  /* Matches claimDocument. A supervisor breaking the claim on a quote somebody
     left open at the other till is the same act as breaking it on a parked
     basket, and a set that differed between the two would leave a document
     claimable but never releasable. */
  if (!(CLAIMABLE_STATUSES as readonly string[]).includes(doc.status)) {
    return { ok: false, error: 'That document can no longer be worked on.' }
  }

  await siteExecute(
    siteId,
    `UPDATE sales_documents
        SET claimed_terminal_id = ?, claimed_by = ?, claimed_at = UTC_TIMESTAMP()
      WHERE id = ? AND status IN (${CLAIMABLE_SQL})`,
    [terminalId, userId, id],
  )
  return { ok: true, id }
}

/**
 * Hands a document back, so the next till may take it.
 *
 * Also forces the status back to `saved`, which is what repairs a bill claimed under
 * the OLD scheme — that one recorded a claim by moving the document to `draft`, and a
 * till still running the previous build can leave one behind mid-upgrade. Cheap, and it
 * means a mixed fleet cannot strand a table.
 *
 * ── EXCEPT ON AN ISSUED DOCUMENT, WHICH KEEPS ITS STATUS ──────────────────
 *
 * That repair is about BASKETS, which are `draft` or `saved` and belong on the
 * shelf either way. An issued quote is a different thing: it has been sent to a
 * customer, and `issued` is the record of that having happened. Once the till
 * could claim one — quotes are never `saved`, so it had to — a release that
 * rewrote the status would quietly demote a sent quote to an unsent one, and
 * the register would then show it as never having gone out.
 *
 * So the repair applies where it was aimed and nowhere else.
 */
export async function releaseDocument(
  siteId: number,
  id: number,
  purpose: SitePurpose = MASTER,
): Promise<SaveResult> {
  const doc = await getDocument(siteId, id, purpose)
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }
  /* Only a claimable document goes back on the shelf. A finalised or cancelled one has
     its own status for good reason, and a released claim must never resurrect it. */
  if (!(CLAIMABLE_STATUSES as readonly string[]).includes(doc.status)) {
    return { ok: false, error: `A ${doc.status} sale cannot be parked.` }
  }

  /* A basket goes back to `saved` — see above. Anything else keeps what it is,
     and only sheds the claim. */
  const restore = doc.status === 'issued' ? '' : `status = 'saved', `

  await siteExecute(
    siteId,
    `UPDATE sales_documents
        SET ${restore}claimed_by = NULL, claimed_at = NULL,
            claimed_terminal_id = NULL
      WHERE id = ?`,
    [id],
    purpose,
  )
  return { ok: true, id }
}

/**
 * The old recall: claims a document by walking its status backwards.
 *
 * Kept ONLY for the back office, where a recalled sale is opened in an editor that has
 * always expected a `draft` and where no floor screen derives occupancy from it. The
 * till uses `claimDocument` instead — see 171_document_claim.sql for why a table's bill
 * must stay `saved` while somebody edits it.
 */
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

/**
 * Takes an unposted document off the floor without destroying it.
 *
 * The sibling of `discardDocument`, and the difference is whether anything else
 * is pointing at the row. A discard is for a sale nobody ever accounted for — a
 * stale draft, a mis-tapped park — and deleting it leaves no hole. A CANCEL is
 * for one that was deliberately voided: `pos_void_events` rows carry its
 * `document_id`, so deleting it would orphan the very trail that explains why it
 * went. The row stays, its status says what happened to it, and the two records
 * agree.
 *
 * Refuses a finalised document on purpose. That one has a number, has moved
 * stock and has taken money; reversing it is `voidDocument`, which writes the
 * counter-entries this function deliberately does not.
 */
export async function cancelUnpostedDocument(
  siteId: number,
  id: number,
  purpose: SitePurpose = MASTER,
): Promise<SaveResult> {
  const doc = await getDocument(siteId, id, purpose)
  if (!doc) return { ok: false, error: 'That sale no longer exists.' }
  if (doc.status !== 'draft' && doc.status !== 'saved') {
    return { ok: false, error: `A ${doc.status} sale cannot be cancelled this way.` }
  }

  /* The claim goes with it. A cancelled bill nobody can reach still reads as held
     by the till that voided it, and a stale claim on a dead document is a puzzle
     for whoever finds it rather than a safeguard. */
  await siteExecute(
    siteId,
    `UPDATE sales_documents
        SET status = 'cancelled', claimed_by = NULL, claimed_at = NULL,
            claimed_terminal_id = NULL
      WHERE id = ?`,
    [id],
    purpose,
  )
  return { ok: true, id }
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
