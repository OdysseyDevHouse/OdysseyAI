import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { statusForRole, listJobStatuses } from './jobStatuses'
// One-directional: jobSla reads settings and holidays, never jobCards.
import { applyDeadlinesTx } from './jobSla'
import { logActivity, logActivityTx, diffFields, type Actor } from './activityLog'
import {
  BILLABLE_STATES,
  BILLING_STATE_LABEL,
  canReclassify,
  isBillable,
  isClosed,
  reclassifyNeedsReason,
  validateJobCardFields,
  type BillingState,
  type JobLineKind,
  type JobPriority,
  type JobSource,
  type JobStatusRole,
  type JobStatusTone,
} from '../jobStatusModel'

/**
 * A job card: one record for a piece of work, from the phone call to the invoice.
 *
 * ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * It is not a sales document, and the reasoning is in the header of
 * 104_job_cards.sql. The short version: a job has n quotes and m invoices over
 * its life, a status that is an FK into a configurable table, and lines that must
 * never be billed. None of those fit sales_documents, and living outside it means
 * finaliseDocument() CANNOT be handed a job card — a stronger guarantee than a
 * guard, for free.
 *
 * ── A JOB CARD RAISES DOCUMENTS, IT NEVER BECOMES ONE ──────────────────────
 *
 * Billing lives in jobInvoicing.ts and creates a DRAFT sales_documents row a
 * person finalises through the one posting engine. Nothing in this file imports
 * recordMovement, postTransaction or mirrorSale. That is deliverOrder() in
 * salesOrders.ts, and its header says why: a second posting engine is how two
 * code paths start to disagree about what a sale is.
 *
 * ── THE TWO STATE COLUMNS, AND WHY BOTH ────────────────────────────────────
 *
 *   status      open | closed | cancelled   the RECORD state
 *   status_id   FK job_statuses             the WORKFLOW stage
 *
 * The workflow stage is what a business configures and renames. The record state
 * exists because verifySequence counts a numbered run as issued/live/voided and
 * hard-codes `status = 'cancelled'` against the table OWN_TABLE_TYPES names. A
 * job card allocates numbers, so it has to answer in the same vocabulary as every
 * other numbered document.
 *
 * They cannot drift: setStatus derives the record state from the new status role
 * and writes both in one statement. Nothing else may write `status`.
 */

export type JobCardLine = {
  id: number
  lineNumber: number
  lineKind: JobLineKind
  billingState: BillingState
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  unitCostExcl: number
  unitPriceIncl: number
  vatRatePct: number
  discountPct: number
  sourceLineId: number | null
  invoicedDocId: number | null
  invoicedNumber: string | null
  invoicedQty: number
  note: string | null
  decidedByUserId: number | null
  decidedAt: string | null
  decidedReason: string | null
  /** qty * unit_cost_excl. What this line cost us. */
  costExcl: number
  /** qty * unit_price_incl, less discount. What we WOULD charge — an intention. */
  priceIncl: number
  /** Still to invoice: qty - invoiced_qty, and only if the state is billable. */
  outstandingQty: number
}

export type JobCardDocument = {
  id: number
  docType: string
  documentNumber: string | null
  status: string
  documentDate: string
  totalIncl: number
}

export type JobCard = {
  id: number
  documentNumber: string | null
  status: 'open' | 'closed' | 'cancelled'
  customerId: number | null
  customerCode: string | null
  customerName: string | null
  customerPhone: string | null
  customerEmail: string | null
  serviceAddressId: number | null
  serviceAddressName: string | null
  locationId: number | null
  locationName: string | null
  statusId: number
  statusName: string
  statusTone: JobStatusTone
  statusRole: JobStatusRole
  priority: JobPriority
  ownerUserId: number | null
  ownerName: string
  title: string
  description: string | null
  reportedAt: string
  dueAt: string | null
  startedAt: string | null
  closedAt: string | null
  closeReason: string | null
  acceptedQuoteId: number | null
  source: JobSource
  reference: string | null
  internalNote: string | null
  cancelledAt: string | null
  cancelReason: string | null
  userId: number | null
  userName: string
  createdAt: string
  updatedAt: string
  /** Derived from the status role, never stored. See isClosed(). */
  isClosed: boolean
}

export type JobCardDetail = JobCard & {
  lines: JobCardLine[]
  documents: JobCardDocument[]
  totals: JobTotals
}

/**
 * What a job is worth, and what it cost.
 *
 * ── REVENUE IS READ OFF THE INVOICE ────────────────────────────────────────
 *
 * `invoiced` sums the LINKED SALES DOCUMENTS, not the lines' intended prices.
 * A job line's unit_price_incl is an intention; the invoice, after documentMath
 * has applied discounts and split the VAT, is what the customer owes. A
 * profitability figure built on intentions and a sales report built on invoices
 * would disagree, and the sales report is right.
 *
 * ── COST INCLUDES WHAT WE WILL NEVER CHARGE FOR ────────────────────────────
 *
 * `cost` sums EVERY line, including internal and written_off. That is the whole
 * requirement: a warranty repair costs real money and earns none, and a job that
 * hid those would report a margin the business never made.
 */
export type JobTotals = {
  /** Every line, whoever pays. */
  cost: number
  /** Lines on the accepted quote — the baseline. */
  quoted: number
  /** Approved variations and additional billable work. */
  extras: number
  /** Actually invoiced, read from the linked documents. */
  invoiced: number
  /** Billable, not yet on an invoice. The money still to collect. */
  uninvoiced: number
  /** Cost the business absorbed: internal plus written off. */
  absorbed: number
  /** Cost recorded with nobody having decided who pays. */
  pending: number
  /** invoiced - cost. Null until something has been invoiced. */
  profit: number | null
  /** profit as a percentage of invoiced. Null on the same condition. */
  marginPct: number | null
  /** How many lines are still awaiting a billing decision. */
  pendingCount: number
}

export type JobCardInput = {
  id: number | null
  customerId: number | null
  customerName: string | null
  customerPhone: string | null
  customerEmail: string | null
  serviceAddressId: number | null
  locationId: number | null
  statusId: number | null
  priority: JobPriority
  ownerUserId: number | null
  ownerName: string
  title: string
  description: string | null
  dueAt: string | null
  source: JobSource
  reference: string | null
  internalNote: string | null
}

export type JobLineInput = {
  id: number | null
  lineKind: JobLineKind
  billingState: BillingState
  productId: number | null
  productCode: string | null
  description: string
  qty: number
  unitCostExcl: number
  unitPriceIncl: number
  vatRatePct: number
  discountPct: number
  note: string | null
}

export type JobSaveResult =
  | { ok: true; id: number; documentNumber: string | null }
  | { ok: false; error: string }

export type JobActionResult = { ok: true } | { ok: false; error: string }

export type JobListFilter = {
  /** 'open' | 'closed' | 'cancelled' | 'all' */
  state?: string
  statusId?: number | null
  priority?: string
  ownerUserId?: number | null
  customerId?: number | null
  search?: string
  limit?: number
  offset?: number
}

export type JobCounts = {
  open: number
  closed: number
  cancelled: number
  unassigned: number
  overdue: number
}

type Row = RowDataPacket & Record<string, unknown>

const SELECT_JOB = `
  SELECT j.id, j.document_number, j.status, j.customer_id, j.customer_code,
         j.customer_name, j.customer_phone, j.customer_email,
         j.service_address_id, j.location_id, j.status_id, j.priority,
         j.owner_user_id, j.owner_name, j.title, j.description,
         j.reported_at, j.due_at, j.started_at, j.closed_at, j.close_reason,
         j.accepted_quote_id, j.source, j.reference, j.internal_note,
         j.cancelled_at, j.cancel_reason, j.user_id, j.user_name,
         j.created_at, j.updated_at,
         s.name AS status_name, s.tone AS status_tone, s.role AS status_role,
         a.name AS service_address_name,
         l.name AS location_name
    FROM job_cards j
    JOIN job_statuses s          ON s.id = j.status_id
    LEFT JOIN service_addresses a ON a.id = j.service_address_id
    LEFT JOIN stock_locations l   ON l.id = j.location_id`

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

/**
 * A DATETIME as a stable wall-clock string, `YYYY-MM-DDTHH:MM:SS`.
 *
 * mysql2 hands back a Date, and `String(thatDate)` yields a LOCALE string —
 * 'Wed Aug 12 2026 20:00:17 GMT+0200 (South Africa Standard Time)'. That reaches
 * the browser as something every consumer has to re-parse, and a comparison built
 * on it silently yields NaN rather than throwing.
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of that Date ARE
 * the stored wall clock. Same helper, same reasoning, as wallClock() in
 * reservations.ts and jobAppointments.ts — `dateStrings` is not set for DATETIME,
 * so this cannot be skipped.
 */
function wallClock(value: unknown): string | null {
  if (!value) return null
  if (typeof value === 'string') return value.replace(' ', 'T').slice(0, 19)
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

function mapJob(row: Row): JobCard {
  const role = String(row.status_role) as JobStatusRole
  return {
    id: Number(row.id),
    documentNumber: text(row.document_number),
    status: String(row.status) as 'open' | 'closed' | 'cancelled',
    customerId: row.customer_id === null ? null : Number(row.customer_id),
    customerCode: text(row.customer_code),
    customerName: text(row.customer_name),
    customerPhone: text(row.customer_phone),
    customerEmail: text(row.customer_email),
    serviceAddressId: row.service_address_id === null ? null : Number(row.service_address_id),
    serviceAddressName: text(row.service_address_name),
    locationId: row.location_id === null ? null : Number(row.location_id),
    locationName: text(row.location_name),
    statusId: Number(row.status_id),
    statusName: String(row.status_name),
    statusTone: String(row.status_tone) as JobStatusTone,
    statusRole: role,
    priority: String(row.priority) as JobPriority,
    ownerUserId: row.owner_user_id === null ? null : Number(row.owner_user_id),
    ownerName: String(row.owner_name ?? ''),
    title: String(row.title),
    description: text(row.description),
    // Every DATETIME through wallClock — see its header for why String() is a trap.
    reportedAt: wallClock(row.reported_at) ?? '',
    dueAt: wallClock(row.due_at),
    startedAt: wallClock(row.started_at),
    closedAt: wallClock(row.closed_at),
    closeReason: text(row.close_reason),
    acceptedQuoteId: row.accepted_quote_id === null ? null : Number(row.accepted_quote_id),
    source: String(row.source) as JobSource,
    reference: text(row.reference),
    internalNote: text(row.internal_note),
    cancelledAt: wallClock(row.cancelled_at),
    cancelReason: text(row.cancel_reason),
    userId: row.user_id === null ? null : Number(row.user_id),
    userName: String(row.user_name ?? ''),
    createdAt: wallClock(row.created_at) ?? '',
    updatedAt: wallClock(row.updated_at) ?? '',
    isClosed: isClosed(role),
  }
}

function mapLine(row: Row): JobCardLine {
  const qty = toNum(row.qty)
  const unitCost = toNum(row.unit_cost_excl)
  const unitPrice = toNum(row.unit_price_incl)
  const discountPct = toNum(row.discount_pct)
  const invoicedQty = toNum(row.invoiced_qty)
  const state = String(row.billing_state) as BillingState

  const gross = qty * unitPrice
  const priceIncl = round(gross - gross * (discountPct / 100), 2)

  return {
    id: Number(row.id),
    lineNumber: Number(row.line_number),
    lineKind: String(row.line_kind) as JobLineKind,
    billingState: state,
    productId: row.product_id === null ? null : Number(row.product_id),
    productCode: text(row.product_code),
    description: String(row.description),
    qty,
    unitCostExcl: unitCost,
    unitPriceIncl: unitPrice,
    vatRatePct: toNum(row.vat_rate_pct),
    discountPct,
    sourceLineId: row.source_line_id === null ? null : Number(row.source_line_id),
    invoicedDocId: row.invoiced_doc_id === null ? null : Number(row.invoiced_doc_id),
    invoicedNumber: text(row.invoiced_number),
    invoicedQty,
    note: text(row.note),
    decidedByUserId: row.decided_by_user_id === null ? null : Number(row.decided_by_user_id),
    decidedAt: wallClock(row.decided_at),
    decidedReason: text(row.decided_reason),
    costExcl: round(qty * unitCost, 2),
    priceIncl,
    outstandingQty: isBillable(state) ? round(Math.max(0, qty - invoicedQty), 3) : 0,
  }
}

/**
 * The money, computed in one place.
 *
 * Exported and pure so the costing tab, the list screen and the test all agree
 * without three copies of the arithmetic. `documents` carries the linked sales
 * documents because revenue comes from them, not from the lines.
 */
export function jobTotals(
  lines: readonly JobCardLine[],
  documents: readonly JobCardDocument[],
): JobTotals {
  let cost = 0
  let quoted = 0
  let extras = 0
  let absorbed = 0
  let pending = 0
  let pendingCount = 0
  let uninvoiced = 0

  for (const line of lines) {
    cost += line.costExcl

    switch (line.billingState) {
      case 'quoted':
        quoted += line.priceIncl
        break
      case 'variation':
      case 'additional':
        extras += line.priceIncl
        break
      case 'internal':
      case 'written_off':
        absorbed += line.costExcl
        break
      case 'pending':
        pending += line.costExcl
        pendingCount += 1
        break
    }

    if (line.outstandingQty > 0 && line.qty > 0) {
      // Pro-rata: a line half invoiced has half its value still to collect.
      uninvoiced += round(line.priceIncl * (line.outstandingQty / line.qty), 2)
    }
  }

  /*
   * Only FINALISED documents count as revenue. A draft invoice is a proposal
   * that a person has not yet posted, and counting it would let a job report
   * profit before anything was billed — the exact thing the invoiced-is-derived
   * decision exists to prevent. A cancelled or voided one has been undone.
   */
  const invoiced = documents
    .filter((d) => d.docType === 'invoice' && d.status === 'finalised')
    .reduce((sum, d) => sum + d.totalIncl, 0)

  const roundedCost = round(cost, 2)
  const roundedInvoiced = round(invoiced, 2)
  const profit = roundedInvoiced === 0 ? null : round(roundedInvoiced - roundedCost, 2)

  return {
    cost: roundedCost,
    quoted: round(quoted, 2),
    extras: round(extras, 2),
    invoiced: roundedInvoiced,
    uninvoiced: round(uninvoiced, 2),
    absorbed: round(absorbed, 2),
    pending: round(pending, 2),
    profit,
    marginPct:
      profit === null || roundedInvoiced === 0 ? null : round((profit / roundedInvoiced) * 100, 2),
    pendingCount,
  }
}

export async function listJobCards(siteId: number, filter: JobListFilter = {}): Promise<JobCard[]> {
  const where: string[] = []
  const params: (string | number)[] = []

  const state = filter.state ?? 'open'
  if (state !== 'all') {
    where.push('j.status = ?')
    params.push(state)
  }
  if (filter.statusId) {
    where.push('j.status_id = ?')
    params.push(filter.statusId)
  }
  if (filter.priority) {
    where.push('j.priority = ?')
    params.push(filter.priority)
  }
  if (filter.ownerUserId !== undefined && filter.ownerUserId !== null) {
    where.push('j.owner_user_id = ?')
    params.push(filter.ownerUserId)
  }
  if (filter.customerId) {
    where.push('j.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.search) {
    const term = `%${filter.search.trim()}%`
    where.push(
      '(j.document_number LIKE ? OR j.title LIKE ? OR j.customer_name LIKE ? OR j.reference LIKE ?)',
    )
    params.push(term, term, term, term)
  }

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500)
  const offset = Math.max(filter.offset ?? 0, 0)

  const rows = await siteQuery<Row>(
    siteId,
    `${SELECT_JOB}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY FIELD(j.priority, 'urgent','high','normal','low'), j.reported_at DESC, j.id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  )
  return rows.map(mapJob)
}

export async function countJobCards(siteId: number, filter: JobListFilter = {}): Promise<number> {
  const where: string[] = []
  const params: (string | number)[] = []
  const state = filter.state ?? 'open'
  if (state !== 'all') {
    where.push('j.status = ?')
    params.push(state)
  }
  if (filter.statusId) {
    where.push('j.status_id = ?')
    params.push(filter.statusId)
  }
  if (filter.priority) {
    where.push('j.priority = ?')
    params.push(filter.priority)
  }
  if (filter.ownerUserId !== undefined && filter.ownerUserId !== null) {
    where.push('j.owner_user_id = ?')
    params.push(filter.ownerUserId)
  }
  if (filter.customerId) {
    where.push('j.customer_id = ?')
    params.push(filter.customerId)
  }
  if (filter.search) {
    const term = `%${filter.search.trim()}%`
    where.push(
      '(j.document_number LIKE ? OR j.title LIKE ? OR j.customer_name LIKE ? OR j.reference LIKE ?)',
    )
    params.push(term, term, term, term)
  }
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT COUNT(*) AS total FROM job_cards j ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    params,
  )
  return Number(row?.total ?? 0)
}

/** The tiles above the list. One query, because five would be five round trips. */
export async function jobCounts(siteId: number): Promise<JobCounts> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT
       SUM(CASE WHEN status = 'open'      THEN 1 ELSE 0 END) AS open_count,
       SUM(CASE WHEN status = 'closed'    THEN 1 ELSE 0 END) AS closed_count,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
       SUM(CASE WHEN status = 'open' AND owner_user_id IS NULL THEN 1 ELSE 0 END) AS unassigned_count,
       SUM(CASE WHEN status = 'open' AND due_at IS NOT NULL AND due_at < NOW() THEN 1 ELSE 0 END) AS overdue_count
     FROM job_cards`,
  )
  return {
    open: Number(row?.open_count ?? 0),
    closed: Number(row?.closed_count ?? 0),
    cancelled: Number(row?.cancelled_count ?? 0),
    unassigned: Number(row?.unassigned_count ?? 0),
    overdue: Number(row?.overdue_count ?? 0),
  }
}

export async function getJobCard(siteId: number, id: number): Promise<JobCardDetail | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_JOB} WHERE j.id = ?`, [id])
  if (!row) return null
  const job = mapJob(row)

  const [lineRows, docRows] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT l.*, d.document_number AS invoiced_number
         FROM job_card_lines l
         LEFT JOIN sales_documents d ON d.id = l.invoiced_doc_id
        WHERE l.job_card_id = ?
        ORDER BY l.line_number, l.id`,
      [id],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, doc_type, document_number, status, document_date, total_incl
         FROM sales_documents
        WHERE job_card_id = ?
        ORDER BY document_date DESC, id DESC`,
      [id],
    ),
  ])

  const lines = lineRows.map(mapLine)
  const documents: JobCardDocument[] = docRows.map((d) => ({
    id: Number(d.id),
    docType: String(d.doc_type),
    documentNumber: text(d.document_number),
    status: String(d.status),
    documentDate: String(d.document_date),
    totalIncl: toNum(d.total_incl),
  }))

  return { ...job, lines, documents, totals: jobTotals(lines, documents) }
}

/**
 * Validation.
 *
 * The rules themselves live in jobStatusModel.ts so the FORM can run them — that
 * file is free of `server-only` and of any database import, and this one is not.
 * Kept as a named export here anyway so a server caller has one import, matching
 * how quotes.ts re-exports quotesModel.
 *
 * The PRD minimum for creating a job is a headline, a description and a customer.
 * Only the first is required, and the departure is deliberate: see the note in
 * validateJobCardFields. What a job with no ACCOUNT cannot do is be invoiced, and
 * invoiceJob refuses that with a sentence rather than the schema refusing the job
 * up front.
 */
export function validateJobCard(input: JobCardInput): string | null {
  return validateJobCardFields(input)
}

/**
 * Create or update a job card.
 *
 * ── THE NUMBER IS ISSUED AT CREATE ─────────────────────────────────────────
 *
 * This is the one place the module departs from the house rule that a number is
 * issued at post. An invoice number waits for finalise because an abandoned draft
 * must not burn one. A job number cannot wait: it is read out to a customer on
 * the phone within a minute of the job existing, and there is no later moment
 * that works. So an abandoned job leaves a permanent gap that verifySequence
 * reports, and that is the accepted cost.
 *
 * It is still allocated as the LAST write before commit, for the ordinary reason:
 * the UPDATE takes an exclusive lock on the sequence row that is held until
 * commit, so holding it for as short a time as possible is what stops two people
 * creating a job at once from blocking each other.
 */
export async function saveJobCard(
  siteId: number,
  actor: Actor,
  input: JobCardInput,
): Promise<JobSaveResult> {
  const refusal = validateJobCard(input)
  if (refusal) return { ok: false, error: refusal }

  const title = input.title.trim()

  return siteTransaction(siteId, async (tx) => {
    // Snapshot the customer, matching every other document in the schema: a
    // rename must not rewrite what this job said at the time.
    let customerCode: string | null = null
    let customerName = text(input.customerName)
    let customerPhone = text(input.customerPhone)
    let customerEmail = text(input.customerEmail)

    if (input.customerId) {
      const [rows] = await tx.query<Row[]>(
        `SELECT code, name, phone, email FROM customers WHERE id = ?`,
        [input.customerId],
      )
      const customer = rows[0]
      if (!customer) return { ok: false as const, error: 'That customer no longer exists.' }
      customerCode = text(customer.code)
      customerName = text(customer.name)
      customerPhone = customerPhone ?? text(customer.phone)
      customerEmail = customerEmail ?? text(customer.email)
    }

    if (input.id === null) {
      let statusId = input.statusId
      if (!statusId) {
        const status = await statusForRole(siteId, 'new', tx)
        if (!status) {
          return {
            ok: false as const,
            error:
              'No status is marked as where new jobs start. Set one under Setup before creating a job.',
          }
        }
        statusId = status.id
      }

      const [result] = await tx.execute(
        `INSERT INTO job_cards
           (status, customer_id, customer_code, customer_name, customer_phone, customer_email,
            service_address_id, location_id, status_id, priority, owner_user_id, owner_name,
            title, description, due_at, source, reference, internal_note, user_id, user_name)
         VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.customerId,
          customerCode,
          customerName,
          customerPhone,
          customerEmail,
          input.serviceAddressId,
          input.locationId,
          statusId,
          input.priority,
          input.ownerUserId,
          input.ownerName ?? '',
          title,
          text(input.description),
          input.dueAt,
          input.source,
          text(input.reference),
          text(input.internalNote),
          actor.userId,
          actor.userName,
        ],
      )
      const id = Number((result as { insertId: number }).insertId)

      /*
       * The SLA deadlines, read back from the row rather than computed from the
       * input: reported_at defaults to CURRENT_TIMESTAMP, so the only place the
       * real value exists is the row that was just written. Computing from
       * `new Date()` here would set a deadline a few milliseconds off the
       * reported time, and reconcileJobSla would then report every job as drifted.
       */
      const [stampRows] = await tx.query<Row[]>(
        `SELECT reported_at FROM job_cards WHERE id = ?`,
        [id],
      )
      const reportedAt = stampRows[0]?.reported_at
      if (reportedAt !== undefined && reportedAt !== null) {
        await applyDeadlinesTx(tx, siteId, id, input.priority, reportedAt as string | Date)
      }

      // LAST write before commit — see the header note about the sequence lock.
      const documentNumber = await nextDocumentNumber(tx, 'job_card')
      await tx.execute(`UPDATE job_cards SET document_number = ? WHERE id = ?`, [documentNumber, id])

      await logActivityTx(tx, actor, {
        entity: 'job_card',
        entityId: id,
        action: 'created',
        detail: `${documentNumber} — ${title}`,
      })

      return { ok: true as const, id, documentNumber }
    }

    const [beforeRows] = await tx.query<Row[]>(
      `SELECT title, description, priority, customer_id, service_address_id, location_id,
              due_at, reference, internal_note, document_number, reported_at
         FROM job_cards WHERE id = ?`,
      [input.id],
    )
    const before = beforeRows[0]
    if (!before) return { ok: false as const, error: 'That job no longer exists.' }

    await tx.execute(
      `UPDATE job_cards
          SET customer_id = ?, customer_code = ?, customer_name = ?, customer_phone = ?,
              customer_email = ?, service_address_id = ?, location_id = ?, priority = ?,
              title = ?, description = ?, due_at = ?, reference = ?, internal_note = ?
        WHERE id = ?`,
      [
        input.customerId,
        customerCode,
        customerName,
        customerPhone,
        customerEmail,
        input.serviceAddressId,
        input.locationId,
        input.priority,
        title,
        text(input.description),
        input.dueAt,
        text(input.reference),
        text(input.internalNote),
        input.id,
      ],
    )

    /*
     * A priority change re-promises the job.
     *
     * An urgent job downgraded to normal must stop being measured against an
     * urgent promise, and vice versa — keeping the old deadline would breach a job
     * for a promise nobody is making any more.
     *
     * Recomputed from the ORIGINAL reported_at, not from now: the clock started
     * when the customer phoned. Restarting it on every priority edit would make
     * the deadline a thing you could reset by fiddling with a dropdown.
     */
    if (String(before.priority) !== input.priority && before.reported_at !== null) {
      await applyDeadlinesTx(
        tx,
        siteId,
        input.id,
        input.priority,
        before.reported_at as string | Date,
      )
    }

    const changes = diffFields(
      {
        title: String(before.title),
        priority: String(before.priority),
        customer: before.customer_id === null ? '' : String(before.customer_id),
        dueAt: before.due_at === null ? '' : String(before.due_at),
      },
      {
        title,
        priority: input.priority,
        customer: input.customerId === null ? '' : String(input.customerId),
        dueAt: input.dueAt ?? '',
      },
      ['title', 'priority', 'customer', 'dueAt'],
    )

    if (changes) {
      await logActivityTx(tx, actor, {
        entity: 'job_card',
        entityId: input.id,
        action: 'updated',
        detail: title,
        changes,
      })
    }

    return { ok: true as const, id: input.id, documentNumber: text(before.document_number) }
  })
}

/**
 * Move a job to a status.
 *
 * The record state is derived from the new status's ROLE and written in the same
 * statement, which is what stops the two columns drifting. Nothing else in the
 * module writes `status`.
 */
export async function setStatus(
  siteId: number,
  actor: Actor,
  jobId: number,
  statusId: number,
  reason?: string,
): Promise<JobActionResult> {
  return siteTransaction(siteId, async (tx) => {
    const [jobRows] = await tx.query<Row[]>(
      `SELECT j.status_id, j.started_at, s.name AS status_name
         FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
        WHERE j.id = ?`,
      [jobId],
    )
    const job = jobRows[0]
    if (!job) return { ok: false as const, error: 'That job no longer exists.' }

    const [statusRows] = await tx.query<Row[]>(
      `SELECT id, name, role, is_active FROM job_statuses WHERE id = ?`,
      [statusId],
    )
    const status = statusRows[0]
    if (!status) return { ok: false as const, error: 'That status no longer exists.' }
    if (Number(status.is_active) !== 1) {
      return { ok: false as const, error: `${String(status.name)} has been switched off.` }
    }

    if (Number(job.status_id) === statusId) return { ok: true as const }

    const role = String(status.role) as JobStatusRole
    const recordState = role === 'cancelled' ? 'cancelled' : isClosed(role) ? 'closed' : 'open'

    /*
     * A closed job with lines nobody has classified is the commonest way a job
     * leaks money: the cost is recorded, the customer was never charged, and
     * nobody finds out until somebody reads a margin report months later. So
     * closing is refused while any line is still pending.
     */
    if (recordState === 'closed') {
      const [pendingRows] = await tx.query<Row[]>(
        `SELECT COUNT(*) AS pending FROM job_card_lines
          WHERE job_card_id = ? AND billing_state = 'pending'`,
        [jobId],
      )
      const pending = Number(pendingRows[0]?.pending ?? 0)
      if (pending > 0) {
        return {
          ok: false as const,
          error: `${pending} ${pending === 1 ? 'line is' : 'lines are'} still awaiting a billing decision. Decide who pays for ${pending === 1 ? 'it' : 'them'} before closing the job.`,
        }
      }
    }

    // started_at is stamped once, the first time work begins, and never moved:
    // a job paused and resumed still started when it started.
    const stampStart = role === 'in_progress' && job.started_at === null

    await tx.execute(
      `UPDATE job_cards
          SET status_id = ?,
              status = ?,
              started_at = ${stampStart ? 'NOW()' : 'started_at'},
              closed_at = ${recordState === 'closed' ? 'NOW()' : 'NULL'},
              close_reason = ?,
              cancelled_at = ${recordState === 'cancelled' ? 'NOW()' : 'NULL'},
              cancel_reason = ?
        WHERE id = ?`,
      [
        statusId,
        recordState,
        recordState === 'closed' ? (text(reason) ?? null) : null,
        recordState === 'cancelled' ? (text(reason) ?? null) : null,
        jobId,
      ],
    )

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'status_changed',
      detail: reason ? `${String(status.name)} — ${reason}` : String(status.name),
      changes: { status: { from: String(job.status_name), to: String(status.name) } },
    })

    return { ok: true as const }
  })
}

/**
 * Make somebody responsible, and advance the status if it is still New.
 *
 * The advance is why `assigned` earns a role rather than being an ordinary
 * status: the PRD asks for a job to become Assigned when a user is attached, and
 * that behaviour has to find the right status without knowing what this business
 * renamed it to. If nobody holds the role the assignment still happens and the
 * status is left alone — a missing role is not a reason to refuse the work.
 */
export async function assignOwner(
  siteId: number,
  actor: Actor,
  jobId: number,
  ownerUserId: number | null,
  ownerName: string,
): Promise<JobActionResult> {
  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT j.owner_name, j.status_id, s.role AS status_role
         FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
        WHERE j.id = ?`,
      [jobId],
    )
    const job = rows[0]
    if (!job) return { ok: false as const, error: 'That job no longer exists.' }

    await tx.execute(`UPDATE job_cards SET owner_user_id = ?, owner_name = ? WHERE id = ?`, [
      ownerUserId,
      ownerName ?? '',
      jobId,
    ])

    let movedTo: string | null = null
    if (ownerUserId !== null && String(job.status_role) === 'new') {
      const assigned = await statusForRole(siteId, 'assigned', tx)
      if (assigned) {
        await tx.execute(`UPDATE job_cards SET status_id = ?, status = 'open' WHERE id = ?`, [
          assigned.id,
          jobId,
        ])
        movedTo = assigned.name
      }
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: ownerUserId === null ? 'unassigned' : 'assigned',
      detail: movedTo ? `${ownerName} — moved to ${movedTo}` : (ownerName || 'nobody'),
      changes: { owner: { from: String(job.owner_name ?? ''), to: ownerName ?? '' } },
    })

    return { ok: true as const }
  })
}

/**
 * Replace the job's cost lines.
 *
 * Whole-set replacement rather than per-line edits, matching how every other
 * document editor in the app saves: the screen owns the list, sends it, and the
 * server reconciles. Lines already invoiced are NOT deletable — they are
 * evidence of something a customer was charged for, and removing one would leave
 * the invoice referring to nothing.
 */
export async function saveLines(
  siteId: number,
  actor: Actor,
  jobId: number,
  lines: readonly JobLineInput[],
): Promise<JobActionResult> {
  for (const line of lines) {
    if (!line.description.trim()) return { ok: false, error: 'Every line needs a description.' }
    if (line.qty < 0) return { ok: false, error: 'A quantity cannot be negative.' }
  }

  return siteTransaction(siteId, async (tx) => {
    const [jobRows] = await tx.query<Row[]>(`SELECT status FROM job_cards WHERE id = ?`, [jobId])
    if (!jobRows[0]) return { ok: false as const, error: 'That job no longer exists.' }

    const [existingRows] = await tx.query<Row[]>(
      `SELECT id, invoiced_doc_id, invoiced_qty, description FROM job_card_lines WHERE job_card_id = ?`,
      [jobId],
    )

    const keptIds = new Set(lines.map((l) => l.id).filter((id): id is number => id !== null))

    for (const existing of existingRows) {
      const id = Number(existing.id)
      if (keptIds.has(id)) continue
      if (existing.invoiced_doc_id !== null || toNum(existing.invoiced_qty) > 0) {
        return {
          ok: false as const,
          error: `${String(existing.description)} has already been invoiced and cannot be removed. Credit the invoice instead.`,
        }
      }
      await tx.execute(`DELETE FROM job_card_lines WHERE id = ?`, [id])
    }

    let lineNumber = 1
    for (const line of lines) {
      if (line.id === null) {
        await tx.execute(
          `INSERT INTO job_card_lines
             (job_card_id, line_number, line_kind, billing_state, product_id, product_code,
              description, qty, unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            jobId,
            lineNumber,
            line.lineKind,
            line.billingState,
            line.productId,
            text(line.productCode),
            line.description.trim(),
            line.qty,
            line.unitCostExcl,
            line.unitPriceIncl,
            line.vatRatePct,
            line.discountPct,
            text(line.note),
          ],
        )
      } else {
        /*
         * billing_state is deliberately NOT updated here. It moves only through
         * reclassifyLine(), which checks the transition is legal and records who
         * decided and why. Letting the line editor set it would make a write-off
         * an untracked side effect of saving a form.
         */
        await tx.execute(
          `UPDATE job_card_lines
              SET line_number = ?, line_kind = ?, product_id = ?, product_code = ?,
                  description = ?, qty = ?, unit_cost_excl = ?, unit_price_incl = ?,
                  vat_rate_pct = ?, discount_pct = ?, note = ?
            WHERE id = ? AND job_card_id = ?`,
          [
            lineNumber,
            line.lineKind,
            line.productId,
            text(line.productCode),
            line.description.trim(),
            line.qty,
            line.unitCostExcl,
            line.unitPriceIncl,
            line.vatRatePct,
            line.discountPct,
            text(line.note),
            line.id,
            jobId,
          ],
        )
      }
      lineNumber += 1
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'lines_saved',
      detail: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}`,
    })

    return { ok: true as const }
  })
}

/**
 * Decide who pays for a line.
 *
 * The transition table in jobStatusModel.ts says which moves are legal, and it is
 * deliberately narrow: nothing leaves `internal`, because a warranty repair does
 * not become chargeable when somebody changes their mind, and nothing leaves
 * `quoted` except a write-off, because the accepted quote is the baseline every
 * variance figure is measured against.
 *
 * An invoiced line cannot be reclassified at all. It has been charged; the
 * remedy is a credit note.
 */
export async function reclassifyLine(
  siteId: number,
  actor: Actor,
  lineId: number,
  to: BillingState,
  reason: string | null,
): Promise<JobActionResult> {
  if (reclassifyNeedsReason(to) && !reason?.trim()) {
    return { ok: false, error: `Say why this is ${BILLING_STATE_LABEL[to].toLowerCase()}.` }
  }

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT id, job_card_id, billing_state, description, invoiced_doc_id, invoiced_qty
         FROM job_card_lines WHERE id = ?`,
      [lineId],
    )
    const line = rows[0]
    if (!line) return { ok: false as const, error: 'That line no longer exists.' }

    const from = String(line.billing_state) as BillingState
    if (from === to) return { ok: true as const }

    if (line.invoiced_doc_id !== null || toNum(line.invoiced_qty) > 0) {
      return {
        ok: false as const,
        error: `${String(line.description)} has been invoiced. Credit the invoice to change what the customer was charged.`,
      }
    }

    if (!canReclassify(from, to)) {
      return {
        ok: false as const,
        error: `A ${BILLING_STATE_LABEL[from].toLowerCase()} line cannot become ${BILLING_STATE_LABEL[to].toLowerCase()}.`,
      }
    }

    await tx.execute(
      `UPDATE job_card_lines
          SET billing_state = ?, decided_by_user_id = ?, decided_at = NOW(), decided_reason = ?
        WHERE id = ?`,
      [to, actor.userId, text(reason), lineId],
    )

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: Number(line.job_card_id),
      action: 'line_reclassified',
      detail: reason
        ? `${String(line.description)} — ${BILLING_STATE_LABEL[to]}: ${reason}`
        : `${String(line.description)} — ${BILLING_STATE_LABEL[to]}`,
      changes: { billing: { from: BILLING_STATE_LABEL[from], to: BILLING_STATE_LABEL[to] } },
    })

    return { ok: true as const }
  })
}

/** Close a job by moving it to whichever status means completed. */
export async function closeJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  reason?: string,
): Promise<JobActionResult> {
  const status = await statusForRole(siteId, 'completed')
  if (!status) {
    return {
      ok: false,
      error: 'No status is marked as the work being done. Set one under Setup first.',
    }
  }
  return setStatus(siteId, actor, jobId, status.id, reason)
}

/** Cancel a job by moving it to whichever status means cancelled. */
export async function cancelJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  reason: string,
): Promise<JobActionResult> {
  if (!reason?.trim()) return { ok: false, error: 'Say why the job was called off.' }
  const status = await statusForRole(siteId, 'cancelled')
  if (!status) {
    return {
      ok: false,
      error: 'No status is marked as the job being called off. Set one under Setup first.',
    }
  }
  return setStatus(siteId, actor, jobId, status.id, reason)
}

/**
 * Reopen a closed job.
 *
 * Sends it back to whichever status means work is underway, because a job being
 * reopened means somebody is going to do something to it. Not to `new`: it has
 * been worked on, and a reopened job appearing in the new-jobs queue would be
 * read as a fresh call.
 */
export async function reopenJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  reason: string,
): Promise<JobActionResult> {
  if (!reason?.trim()) return { ok: false, error: 'Say why the job is being reopened.' }
  const status = await statusForRole(siteId, 'in_progress')
  if (!status) {
    return { ok: false, error: 'No status is marked as work underway. Set one under Setup first.' }
  }
  const result = await setStatus(siteId, actor, jobId, status.id)
  if (!result.ok) return result
  await logActivity(siteId, actor, {
    entity: 'job_card',
    entityId: jobId,
    action: 'reopened',
    detail: reason,
  })
  return { ok: true }
}

export type JobDrift = {
  /** Lines claiming more invoiced than they have. Arithmetic that cannot be right. */
  overInvoiced: { lineId: number; jobId: number; description: string; qty: number; invoiced: number }[]
  /** Lines pointing at an invoice that is not linked to their job. */
  orphanedInvoiceLinks: { lineId: number; jobId: number; description: string; docId: number }[]
  /** Non-billable lines carrying an invoice. Should be impossible. */
  billedUnbillable: { lineId: number; jobId: number; description: string; state: string }[]
  /** Open jobs whose workflow status means closed, or the reverse. */
  stateMismatch: { jobId: number; number: string | null; status: string; role: string }[]
  /** Statuses no board lists, so jobs in them are invisible on every board. */
  statusesOffEveryBoard: { statusId: number; name: string; jobCount: number }[]
}

/**
 * Drift report. Reports, never repairs.
 *
 * The same stance as reconcileStock(): every one of these is either impossible or
 * a symptom of a bug, and a function that quietly fixed them would hide the bug
 * while leaving the cause in place. The last check is not a bug at all but a
 * configuration trap — a job in a status no board lists is invisible on every
 * board, which the board setup screen shows so nobody discovers it by losing work.
 */
export async function reconcileJobCards(siteId: number): Promise<JobDrift> {
  const [over, orphaned, unbillable, mismatch, offBoard] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, description, qty, invoiced_qty
         FROM job_card_lines WHERE invoiced_qty > qty`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT l.id, l.job_card_id, l.description, l.invoiced_doc_id
         FROM job_card_lines l
         JOIN sales_documents d ON d.id = l.invoiced_doc_id
        WHERE d.job_card_id IS NULL OR d.job_card_id <> l.job_card_id`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT id, job_card_id, description, billing_state
         FROM job_card_lines
        WHERE invoiced_doc_id IS NOT NULL
          AND billing_state NOT IN (${BILLABLE_STATES.map(() => '?').join(',')})`,
      [...BILLABLE_STATES],
    ),
    siteQuery<Row>(
      siteId,
      `SELECT j.id, j.document_number, j.status, s.role
         FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
        WHERE (s.role IN ('completed') AND j.status <> 'closed')
           OR (s.role = 'cancelled' AND j.status <> 'cancelled')
           OR (s.role NOT IN ('completed','cancelled') AND j.status <> 'open')`,
    ),
    siteQuery<Row>(
      siteId,
      `SELECT s.id, s.name, (SELECT COUNT(*) FROM job_cards j WHERE j.status_id = s.id) AS job_count
         FROM job_statuses s
        WHERE s.is_active = 1
          AND NOT EXISTS (SELECT 1 FROM job_board_statuses b WHERE b.status_id = s.id)`,
    ),
  ])

  return {
    overInvoiced: over.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      qty: toNum(r.qty),
      invoiced: toNum(r.invoiced_qty),
    })),
    orphanedInvoiceLinks: orphaned.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      docId: Number(r.invoiced_doc_id),
    })),
    billedUnbillable: unbillable.map((r) => ({
      lineId: Number(r.id),
      jobId: Number(r.job_card_id),
      description: String(r.description),
      state: String(r.billing_state),
    })),
    stateMismatch: mismatch.map((r) => ({
      jobId: Number(r.id),
      number: text(r.document_number),
      status: String(r.status),
      role: String(r.role),
    })),
    statusesOffEveryBoard: offBoard.map((r) => ({
      statusId: Number(r.id),
      name: String(r.name),
      jobCount: Number(r.job_count ?? 0),
    })),
  }
}

/** Re-exported so a server caller has one import. */
export { listJobStatuses, statusForRole }
