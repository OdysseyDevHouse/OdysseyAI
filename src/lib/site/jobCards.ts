import 'server-only'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { supplierDbPrefix } from './customerDb'
import { customerQueryOne } from './customerDb'
import { round, toNum } from '../decimals'
import { nextDocumentNumber } from './sequences'
import { statusForRole, listJobStatuses } from './jobStatuses'
// One-directional: jobSla reads settings and holidays, never jobCards.
import { applyDeadlinesTx } from './jobSla'
// Likewise jobHeadlines — it reads settings and its own tables, never jobCards.
import { itemsBlockClose, outstandingRequiredTx } from './jobHeadlines'
import { outstandingFormsTx } from './jobForms'
import { missingSignoffTx, signoffRule } from './jobSignoff'
// And jobAssets, which reads its own tables plus job_cards but never imports back.
import { recordServiceOnClose } from './jobAssets'
// And jobPeople, which reads its own table plus job_cards and never imports back.
// Everything it exposes here is fire-and-forget: see the call sites.
import { notifyAssigned, notifyClosed, notifyStatusChanged } from './jobPeople'
import { requestFeedback } from './jobFeedback'
import { logActivity, logActivityTx, diffFields, type Actor } from './activityLog'
import { releaseJob } from './jobReservations'
import {
  BILLABLE_STATES,
  BILLING_STATE_LABEL,
  JOB_PRIORITIES,
  canReclassify,
  isBillable,
  isClosed,
  reclassifyNeedsReason,
  validateJobCardFields,
  LINE_KINDS_WITH_SUPPLIER,
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
  /** Who was paid (160). Only ever set on an `expense` line. */
  supplierId: number | null
  supplierName: string | null
  /** Which expense bucket it lands in on the P&L. Reuses 042's categories. */
  expenseCategoryId: number | null
  expenseCategoryName: string | null
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
  /**
   * Who was paid, and what the spend was for (160). Both only meaningful on an
   * `expense` line, and both cleared when the kind changes — see saveLines.
   */
  supplierId: number | null
  expenseCategoryId: number | null
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
         s.is_closed_stage AS status_closed_stage,
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
    // The role OR the stage flag (123). The role still answers for the two
    // reserved meanings; the flag answers for a closing stage a business added
    // itself, which would otherwise read as open everywhere.
    isClosed: isClosed(role) || Number(row.status_closed_stage) === 1,
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
    supplierId: row.supplier_id === null || row.supplier_id === undefined ? null : Number(row.supplier_id),
    supplierName: text(row.supplier_name),
    expenseCategoryId:
      row.expense_category_id === null || row.expense_category_id === undefined
        ? null
        : Number(row.expense_category_id),
    expenseCategoryName: text(row.expense_category_name),
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

/**
 * The figures the operations dashboard leads with (PRD, Phase 1 dashboards).
 *
 * ── WHY THESE ARE COUNTED BY STATUS CODE, NOT BY ROLE ──────────────────────
 *
 * "Awaiting parts" and "ready to invoice" are STAGES a business chose to have,
 * not meanings the code needs — they carry no role, deliberately (see 123). So
 * they are matched on the seeded code, and a site that renamed or deleted one
 * simply reports zero rather than breaking. A role would have been the wrong
 * tool: it exists so code can FIND a stage it depends on, and nothing here
 * depends on these.
 *
 * ── WHY completedNotInvoiced IS NOT "closed jobs with no invoice" ──────────
 *
 * A job is billable when it has lines somebody agreed to charge for and they
 * have not all been invoiced. A closed job with nothing billable on it — a
 * warranty call, a goodwill visit — is finished, not outstanding, and counting
 * it would put permanent noise on the one figure that protects cash flow.
 *
 * One query rather than seven, because this is a dashboard tile: seven round
 * trips to draw a strip of numbers is how a dashboard starts feeling slow.
 */
export type JobOpsCounts = {
  inProgress: number
  awaitingParts: number
  awaitingCustomer: number
  scheduledToday: number
  readyToInvoice: number
  /** Closed with billable work still unbilled. The cash-flow figure. */
  completedNotInvoiced: number
}

export async function jobOpsCounts(siteId: number): Promise<JobOpsCounts> {
  try {
    const row = await siteQueryOne<Row>(
      siteId,
      `SELECT
         SUM(CASE WHEN j.status = 'open' AND s.role = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN j.status = 'open' AND s.code = 'parts' THEN 1 ELSE 0 END) AS awaiting_parts,
         SUM(CASE WHEN j.status = 'open' AND s.code = 'awaiting_customer' THEN 1 ELSE 0 END) AS awaiting_customer,
         SUM(CASE WHEN j.status = 'open' AND s.code = 'ready_invoice' THEN 1 ELSE 0 END) AS ready_invoice,
         SUM(CASE WHEN j.status = 'open' AND EXISTS (
               SELECT 1 FROM job_card_appointments a
                WHERE a.job_card_id = j.id
                  AND a.status IN ('scheduled','confirmed','en_route','on_site')
                  AND DATE(a.starts_at) = CURDATE()
             ) THEN 1 ELSE 0 END) AS scheduled_today,
         SUM(CASE WHEN j.status = 'closed' AND EXISTS (
               SELECT 1 FROM job_card_lines l
                WHERE l.job_card_id = j.id
                  AND l.billing_state IN ('quoted','variation','additional')
                  AND l.invoiced_qty < l.qty
             ) THEN 1 ELSE 0 END) AS completed_not_invoiced
       FROM job_cards j
       JOIN job_statuses s ON s.id = j.status_id`,
    )
    return {
      inProgress: Number(row?.in_progress ?? 0),
      awaitingParts: Number(row?.awaiting_parts ?? 0),
      awaitingCustomer: Number(row?.awaiting_customer ?? 0),
      scheduledToday: Number(row?.scheduled_today ?? 0),
      readyToInvoice: Number(row?.ready_invoice ?? 0),
      completedNotInvoiced: Number(row?.completed_not_invoiced ?? 0),
    }
  } catch {
    /*
     * Tolerant, like every other job read on this screen: a site that has not
     * run 106 has no appointments table and one missing feature must not take
     * down the dashboard — which is the screen somebody opens BECAUSE something
     * looks wrong.
     */
    return {
      inProgress: 0,
      awaitingParts: 0,
      awaitingCustomer: 0,
      scheduledToday: 0,
      readyToInvoice: 0,
      completedNotInvoiced: 0,
    }
  }
}

/**
 * Open jobs grouped by stage and by owner, for the two dashboard charts.
 *
 * ── OPEN ONLY, AND THAT IS THE WHOLE POINT ─────────────────────────────────
 *
 * "Jobs by stage" over all time would be dominated by Work Completed forever,
 * and would answer a question nobody asks. A dispatcher wants to know where the
 * LIVE work is stuck.
 *
 * ── UNASSIGNED IS A BAR, NOT A GAP ─────────────────────────────────────────
 *
 * Jobs with no owner are grouped under a label rather than dropped. Dropping
 * them would make the chart total less than the open count with nothing
 * explaining the difference — and unassigned work is the single thing a
 * dispatcher opens this chart to find.
 */
export type JobBreakdown = { label: string; count: number; href: string }

export async function jobBreakdowns(
  siteId: number,
): Promise<{ byStatus: JobBreakdown[]; byTechnician: JobBreakdown[] }> {
  try {
    const [statusRows, ownerRows] = await Promise.all([
      siteQuery<Row>(
        siteId,
        `SELECT s.id, s.name, COUNT(*) AS n
           FROM job_cards j JOIN job_statuses s ON s.id = j.status_id
          WHERE j.status = 'open'
          GROUP BY s.id, s.name
          ORDER BY n DESC, s.sort_order`,
      ),
      siteQuery<Row>(
        siteId,
        `SELECT j.owner_user_id, j.owner_name, COUNT(*) AS n
           FROM job_cards j
          WHERE j.status = 'open'
          GROUP BY j.owner_user_id, j.owner_name
          ORDER BY n DESC`,
      ),
    ])

    return {
      byStatus: statusRows.map((r) => ({
        label: String(r.name),
        count: Number(r.n),
        href: `/jobs?state=open&status=${Number(r.id)}`,
      })),
      byTechnician: ownerRows
        .map((r) => ({
          label: text(r.owner_name) ?? 'Nobody assigned',
          count: Number(r.n),
          // No owner filter on the list yet, so the unassigned bar lands on the
          // open list rather than pretending to filter. Better an honest link
          // than one that silently ignores half of what it says.
          href: '/jobs?state=open',
          unassigned: r.owner_user_id === null,
        }))
        // Unassigned last regardless of size: it is a different KIND of row, and
        // sorting it among the people would bury it on a busy site.
        .sort((a, b) => (a.unassigned ? 1 : 0) - (b.unassigned ? 1 : 0))
        .map(({ label, count, href }) => ({ label, count, href })),
    }
  } catch {
    return { byStatus: [], byTechnician: [] }
  }
}

export async function getJobCard(siteId: number, id: number): Promise<JobCardDetail | null> {
  const row = await siteQueryOne<Row>(siteId, `${SELECT_JOB} WHERE j.id = ?`, [id])
  if (!row) return null
  const job = mapJob(row)

  // job_card_lines is this shop's; the supplier it names may be the group's.
  // Left unqualified this read the branch's own (empty) suppliers table and
  // every bought-in part on a job card lost its supplier name.
  const sdb = await supplierDbPrefix(siteId)
  const [lineRows, docRows] = await Promise.all([
    siteQuery<Row>(
      siteId,
      // The two names (160) are joined rather than stored, unlike the crew
      // member snapshots: a supplier rename should show through here, because
      // this is a live cost record and not evidence of who somebody once was.
      `SELECT l.*, d.document_number AS invoiced_number,
              sup.name AS supplier_name, ec.name AS expense_category_name
         FROM job_card_lines l
         LEFT JOIN sales_documents d ON d.id = l.invoiced_doc_id
         LEFT JOIN ${sdb}suppliers sup ON sup.id = l.supplier_id
         LEFT JOIN expense_categories ec ON ec.id = l.expense_category_id
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

  /*
   * Snapshot the customer, matching every other document in the schema: a
   * rename must not rewrite what this job said at the time.
   *
   * ── READ BEFORE THE TRANSACTION, AND FROM THE OWNER ──────────────────────
   *
   * This used to run on the job's own `tx`, which is the BRANCH's connection.
   * A branch that shares the customer file has an EMPTY customers table — the
   * switch refuses to turn on otherwise — so the lookup found nothing and
   * every job card for a shared customer was refused with "That customer no
   * longer exists."
   *
   * Hoisted out because no transaction spans two databases, and it is only a
   * read: nothing here needs the job's own atomicity.
   */
  let customerCode: string | null = null
  let customerName = text(input.customerName)
  let customerPhone = text(input.customerPhone)
  let customerEmail = text(input.customerEmail)

  if (input.customerId) {
    const customer = await customerQueryOne<Row>(
      siteId,
      `SELECT code, name, phone, email FROM customers WHERE id = ?`,
      [input.customerId],
    )
    if (!customer) return { ok: false, error: 'That customer no longer exists.' }
    customerCode = text(customer.code)
    customerName = text(customer.name)
    customerPhone = customerPhone ?? text(customer.phone)
    customerEmail = customerEmail ?? text(customer.email)
  }

  return siteTransaction(siteId, async (tx) => {

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
  /**
   * May this caller move a job to an office-only stage? See the audience check
   * below for why it is a parameter rather than a lookup.
   *
   * Defaults to true so every existing call site behaves as it did; the action
   * layer passes the real answer.
   */
  isOffice = true,
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
      `SELECT id, name, role, is_active, requires_reason, blocks_on_incomplete,
              audience, is_closed_stage
         FROM job_statuses WHERE id = ?`,
      [statusId],
    )
    const status = statusRows[0]
    if (!status) return { ok: false as const, error: 'That status no longer exists.' }
    if (Number(status.is_active) !== 1) {
      return { ok: false as const, error: `${String(status.name)} has been switched off.` }
    }

    if (Number(job.status_id) === statusId) return { ok: true as const }

    const role = String(status.role) as JobStatusRole

    /*
     * Closed-ness comes from the role OR from is_closed_stage (123).
     *
     * The role still wins where it exists, because code depends on it —
     * statusForRole('completed') has to keep finding the completion stage. The
     * column answers for stages that carry no role, which is what lets a business
     * add a closing stage of its own without claiming one of the two reserved
     * roles.
     */
    const closedStage = Number(status.is_closed_stage) === 1
    const recordState =
      role === 'cancelled' ? 'cancelled' : isClosed(role) || closedStage ? 'closed' : 'open'

    /*
     * A reason, where the stage asks for one (10.1).
     *
     * Checked here rather than on the screen because the action is the boundary,
     * and because setStatus is reached from the board drag and the bulk bar as
     * well as the job card — three call sites, one rule.
     */
    if (Number(status.requires_reason) === 1 && text(reason) === null) {
      return {
        ok: false as const,
        error: `${String(status.name)} needs a reason. Say why in a sentence.`,
      }
    }

    /*
     * Office-only stages (10.1).
     *
     * `isOffice` is passed in rather than read here: this module takes a siteId
     * and an actor, never a CapabilitySet, and reaching for permissions inside a
     * data module is how the boundary between "what is true" and "who may do it"
     * gets lost. The action layer holds the capabilities and answers the
     * question; this enforces the answer.
     *
     * Defaults to true, so every existing caller keeps working and only the ones
     * that know about the rule pass false.
     */
    if (String(status.audience) === 'office' && !isOffice) {
      return {
        ok: false as const,
        error: `${String(status.name)} is an office stage. Somebody who bills jobs has to move it there.`,
      }
    }

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

      /*
       * And required tasks or checks that nobody has answered.
       *
       * This is what makes the required flag mean something — a marking that did
       * not block anything would teach people it was decorative. The names are
       * listed rather than counted, because "3 items outstanding" sends somebody
       * hunting through a list while "Gas leak test, Customer signature" tells
       * them what to go and do.
       *
       * Switchable, and TOLERANT of a site without migration 114: a missing
       * feature must never stop a job being closed.
       */
      /*
       * The STAGE decides, falling back to the site setting.
       *
       * Per-status rather than one global switch, because the two closing stages
       * want opposite answers: Work Completed must demand its checks, and
       * Cancelled must not — refusing to cancel a job because a check is unticked
       * is how a job nobody wants stays open forever. 123 seeds exactly that.
       *
       * NULL means the status has not decided, so the site setting answers. That
       * is what every status created before 123 carries, which is why migrating
       * changed nothing.
       */
      const stageRule =
        status.blocks_on_incomplete === null || status.blocks_on_incomplete === undefined
          ? null
          : Number(status.blocks_on_incomplete) === 1
      const blocking = stageRule ?? (await itemsBlockClose(siteId))

      if (blocking) {
        /*
         * Checks and FORMS, in one list (222).
         *
         * The same rule governs both because they answer the same question —
         * has the work been recorded — and a job blocked by one while silently
         * ignoring the other would be a gate people learn to distrust.
         *
         * Both reads run inside this transaction so the check and the close see
         * the same state: a form submitted in the moment between them must not
         * let a job through that should have been held.
         */
        const [items, forms] = await Promise.all([
          outstandingRequiredTx(tx, jobId),
          outstandingFormsTx(tx, jobId),
        ])
        const outstanding = [...items, ...forms]
        if (outstanding.length > 0) {
          const listed = outstanding.slice(0, 3).join(', ')
          const more = outstanding.length > 3 ? ` and ${outstanding.length - 3} more` : ''
          return {
            ok: false as const,
            error: `Still to do before this job can be closed: ${listed}${more}.`,
          }
        }
      }

      /*
       * And the sign-off the site asks for (159).
       *
       * A SEPARATE rule from the checklist guard above, deliberately, because it
       * answers a different question. `blocking` asks whether this STAGE demands
       * its checks — and Cancelled must not, or a job nobody wants stays open
       * forever. A signature rule is about the business's paperwork and applies
       * wherever a job is being closed as done.
       *
       * It is skipped for a cancellation for the same reason 123 seeds Cancelled
       * with blocks_on_incomplete = 0: refusing to cancel a job because the
       * customer never signed for work that never happened is nonsense.
       */
      if (role !== 'cancelled') {
        // The RULE is a setting, read through the pool exactly as
        // itemsBlockClose above does; the JOB's own columns are read on the
        // transaction, because that is the row this transaction has locked.
        const missing = await missingSignoffTx(tx, jobId, await signoffRule(siteId))
        if (missing) return { ok: false as const, error: missing }
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

    /*
     * A job that is no longer open holds no stock (220).
     *
     * Nothing more is going to be issued against it, so a surviving claim is
     * stock held for work that is finished — a phantom shortage at the till that
     * only reconcileJobReservations could ever explain. Cancelling matters most:
     * the parts were promised and now never will be, and that promise must not
     * outlive the job that made it.
     *
     * Not restored on reopen. What a reopened job needs is decided by its quote,
     * and re-accepting is what makes a promise again — silently reinstating one
     * here would claim stock nobody agreed to.
     */
    if (recordState !== 'open') {
      await releaseJob(tx, jobId)
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'status_changed',
      detail: reason ? `${String(status.name)} — ${reason}` : String(status.name),
      changes: { status: { from: String(job.status_name), to: String(status.name) } },
    })

    // Carried out of the transaction so the follow-up work below knows what to do
    // without re-reading the row it just wrote.
    return {
      ok: true as const,
      closed: recordState === 'closed',
      statusName: String(status.name),
    }
  }).then(async (result) => {
    /*
     * Rolling an asset's service dates forward happens AFTER the commit, on its own
     * connection, deliberately: it must see the job as closed, and a failure must
     * not roll back the closure. A service date is a convenience; the status change
     * is the record.
     *
     * recordServiceOnClose is itself tolerant of a site without migration 115.
     */
    if (result.ok && 'closed' in result && result.closed) {
      await recordServiceOnClose(siteId, jobId).catch(() => {})
    }

    /*
     * Telling people, on the same terms and for the same reason: after the commit,
     * on its own connection, and swallowed. jobPeople is itself defensive at every
     * step, so this catch is the outermost of several -- a mail server being down
     * must never be why a technician cannot move a job.
     */
    if (result.ok && 'statusName' in result && typeof result.statusName === 'string') {
      const name = result.statusName
      if ('closed' in result && result.closed) {
        void notifyClosed(siteId, actor, jobId).catch(() => {})
        /*
         * And ask the customer what they thought (§ feedback).
         *
         * Same terms again, and one more reason on top: requestFeedback CLAIMS a
         * row before it sends, so a job closed, reopened and closed again asks
         * once. It reads its own switch, which is off by default, and it returns
         * a reason rather than throwing whatever goes wrong.
         */
        void requestFeedback(siteId, jobId).catch(() => {})
      } else {
        void notifyStatusChanged(siteId, actor, jobId, name).catch(() => {})
      }
    }
    return result
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
  }).then((result) => {
    // The owner is an assignee in everything but which table holds them, so being
    // made owner sends the same email being made an assignee does. After the
    // commit and swallowed, like every other notification here.
    if (result.ok && ownerUserId !== null) {
      void notifyAssigned(siteId, jobId, ownerUserId).catch(() => {})
    }
    return result
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
/**
 * Which money fields the caller is allowed to write (§26.6).
 *
 * Passed in rather than read here, because this module has no session: the
 * action resolves the capability set at the boundary and hands down the answer,
 * exactly as it already does for `actor`.
 *
 * ── WHY THIS PARAMETER IS REQUIRED AND NOT DEFAULTED ───────────────────────
 *
 * It was written with a default of "may write nothing", on the reasoning that a
 * forgetful call site should fail closed. That default is worse than no default:
 * failing closed here does not refuse the save, it SILENTLY WRITES ZERO over
 * every cost and price on the job, because the safe value for a field you may
 * not set is the stored one and a new line has no stored one.
 *
 * A caller that forgets should not compile. Ten call sites in the test suite
 * proved the point the moment the default existed — every one of them zeroed the
 * figures it had just written and reported a job that gave away a R4 200 part.
 * In production the same mistake would be a margin quietly going to zero.
 *
 * So: no default. `MONEY_FROM_TRUSTED_CALLER` exists for the callers that are
 * not a user request at all — a test fixture, a migration, a recurrence template
 * copying a priced line forward — and it is named to be conspicuous in review.
 */
export type MoneyRights = {
  readonly cost: boolean
  readonly price: boolean
  readonly discount: boolean
}

/**
 * For callers that are not acting on behalf of a person: fixtures, series
 * generation, anything copying figures that were already authorised once.
 *
 * Never reach for this in a server action. An action has a capability set, and
 * the whole point of §26.6 is that it is consulted.
 */
export const MONEY_FROM_TRUSTED_CALLER: MoneyRights = { cost: true, price: true, discount: true }

export async function saveLines(
  siteId: number,
  actor: Actor,
  jobId: number,
  lines: readonly JobLineInput[],
  money: MoneyRights,
): Promise<JobActionResult> {
  for (const line of lines) {
    if (!line.description.trim()) return { ok: false, error: 'Every line needs a description.' }
    if (line.qty < 0) return { ok: false, error: 'A quantity cannot be negative.' }
    if (line.discountPct < 0 || line.discountPct > 100) {
      return { ok: false, error: 'A discount must be between 0 and 100 per cent.' }
    }
  }

  /*
   * A supplier and a category belong to an EXPENSE and to nothing else (160).
   *
   * Cleared here rather than trusted from the client, because the kind can be
   * changed on a line that already has them: somebody records a subcontractor
   * invoice, then switches the row to Labour. Leaving the supplier behind would
   * make a spend report count that money against a supplier on a line that no
   * longer claims to be an expense — a figure nothing on screen explains.
   *
   * Done at the action's own boundary rather than in the UI so the three call
   * sites that reach saveLines all get the same answer.
   */
  const supplierFor = (line: JobLineInput) =>
    LINE_KINDS_WITH_SUPPLIER.has(line.lineKind) ? line.supplierId : null
  const categoryFor = (line: JobLineInput) =>
    LINE_KINDS_WITH_SUPPLIER.has(line.lineKind) ? line.expenseCategoryId : null

  return siteTransaction(siteId, async (tx) => {
    const [jobRows] = await tx.query<Row[]>(`SELECT status FROM job_cards WHERE id = ?`, [jobId])
    if (!jobRows[0]) return { ok: false as const, error: 'That job no longer exists.' }

    const [existingRows] = await tx.query<Row[]>(
      `SELECT id, invoiced_doc_id, invoiced_qty, description,
              unit_cost_excl, unit_price_incl, discount_pct
         FROM job_card_lines WHERE job_card_id = ?`,
      [jobId],
    )

    /*
     * ── The money the caller may not write ─────────────────────────────────
     *
     * PRD §39.2: "Server-side authorisation is required. Hiding a field or
     * button in the interface is not sufficient protection." The line editor
     * already omits the cost and price inputs for somebody without the right,
     * but the action takes a JSON payload, and a payload can say anything.
     *
     * So each money field is resolved here, from the STORED row rather than the
     * request, whenever the caller lacks the matching right. Rejecting the save
     * instead would be worse: a technician legitimately editing a description on
     * a priced line would be told to go away because the form round-tripped a
     * figure they were never shown and cannot change.
     *
     * A NEW line has no stored row to fall back to, so it takes zero. That is
     * the honest answer — a technician may record that a part was fitted, and
     * somebody with the right prices it afterwards. It also means an unpriced
     * line reads as unpriced rather than as free, which the billing states and
     * the "costs nobody has decided about" report already know how to surface.
     */
    const storedMoney = new Map(
      existingRows.map((r) => [
        Number(r.id),
        {
          cost: toNum(r.unit_cost_excl),
          price: toNum(r.unit_price_incl),
          discount: toNum(r.discount_pct),
        },
      ]),
    )

    const moneyFor = (line: JobLineInput) => {
      const stored = line.id === null ? null : storedMoney.get(line.id)
      return {
        cost: money.cost ? line.unitCostExcl : (stored?.cost ?? 0),
        price: money.price ? line.unitPriceIncl : (stored?.price ?? 0),
        discount: money.discount ? line.discountPct : (stored?.discount ?? 0),
      }
    }

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
      const cash = moneyFor(line)
      if (line.id === null) {
        await tx.execute(
          `INSERT INTO job_card_lines
             (job_card_id, line_number, line_kind, billing_state, product_id, product_code,
              supplier_id, expense_category_id,
              description, qty, unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            jobId,
            lineNumber,
            line.lineKind,
            line.billingState,
            line.productId,
            text(line.productCode),
            supplierFor(line),
            categoryFor(line),
            line.description.trim(),
            line.qty,
            cash.cost,
            cash.price,
            line.vatRatePct,
            cash.discount,
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
                  supplier_id = ?, expense_category_id = ?,
                  description = ?, qty = ?, unit_cost_excl = ?, unit_price_incl = ?,
                  vat_rate_pct = ?, discount_pct = ?, note = ?
            WHERE id = ? AND job_card_id = ?`,
          [
            lineNumber,
            line.lineKind,
            line.productId,
            text(line.productCode),
            supplierFor(line),
            categoryFor(line),
            line.description.trim(),
            line.qty,
            cash.cost,
            cash.price,
            line.vatRatePct,
            cash.discount,
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
/**
 * Change only the priority, re-stamping the SLA promise that depends on it.
 *
 * saveJobCard already does this, but it needs the whole record — which a bulk
 * action does not have and should not have to reconstruct, because sending back
 * fields nobody edited is how a bulk action quietly overwrites somebody else's
 * change to the same job.
 *
 * The deadlines are recomputed from the ORIGINAL reported_at, not from now. A
 * job logged on Monday and escalated to urgent on Wednesday promised a response
 * from when it was REPORTED; re-stamping from today would silently forgive two
 * days of a promise already broken.
 */
export async function setPriority(
  siteId: number,
  actor: Actor,
  jobId: number,
  priority: JobPriority,
): Promise<JobActionResult> {
  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT id, priority, status, reported_at FROM job_cards WHERE id = ?`,
      [jobId],
    )
    const job = rows[0]
    if (!job) return { ok: false as const, error: 'That job no longer exists.' }
    if (String(job.status) !== 'open') {
      return { ok: false as const, error: 'This job is closed, so its priority cannot change.' }
    }
    if (String(job.priority) === priority) return { ok: true as const }

    await tx.execute(`UPDATE job_cards SET priority = ? WHERE id = ?`, [priority, jobId])

    const reportedAt = job.reported_at
    if (reportedAt !== undefined && reportedAt !== null) {
      await applyDeadlinesTx(tx, siteId, jobId, priority, reportedAt as string | Date)
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'priority_changed',
      detail: priority,
      changes: { priority: { from: String(job.priority), to: priority } },
    })

    return { ok: true as const }
  })
}

/* ── Bulk actions (37.2) ───────────────────────────────────────────────────── */

/**
 * What a bulk action did, and what it refused to do.
 *
 * Reporting the refusals BY NAME is the whole point — "38 changed, 2 skipped"
 * with no list of which two, and why, is worse than not offering the action at
 * all, because the user cannot tell whether the two that mattered went through.
 * The shape matches bulkUpdateCustomers deliberately.
 */
export type JobBulkResult = {
  changed: number
  skipped: { id: number; documentNumber: string | null; reason: string }[]
}

export type JobBulkChange =
  | { kind: 'status'; statusId: number }
  | { kind: 'priority'; priority: JobPriority }
  | { kind: 'owner'; ownerUserId: number | null; ownerName: string }

/**
 * Applies one change to many jobs.
 *
 * ── WHY THIS LOOPS RATHER THAN ISSUING ONE UPDATE ──────────────────────────
 *
 * A single `UPDATE ... WHERE id IN (...)` would be one statement and would be
 * wrong. Moving a job to a status runs setStatus, which stamps SLA deadlines,
 * refuses a close over outstanding required checks, records the change in the
 * activity log and notifies whoever is watching. A blind UPDATE would skip every
 * one of those, and the jobs changed in bulk would quietly differ from the ones
 * changed one at a time.
 *
 * So each job goes through the same door a person uses, and a refusal is
 * reported rather than swallowed. Slower, and correct.
 */
export async function bulkUpdateJobs(
  siteId: number,
  actor: Actor,
  ids: readonly number[],
  change: JobBulkChange,
  /** Passed straight through to setStatus. See its own parameter for why. */
  isOffice = true,
): Promise<JobBulkResult> {
  const unique = [...new Set(ids)].filter((id) => Number.isFinite(id) && id > 0)
  if (unique.length === 0) return { changed: 0, skipped: [] }

  // A cap, reported rather than silently applied. Fifty jobs through the full
  // status machinery is already a slow request; five hundred is a timeout that
  // leaves half the work done and says nothing.
  const CAP = 100
  const skipped: JobBulkResult['skipped'] = []
  const targets = unique.slice(0, CAP)
  for (const id of unique.slice(CAP)) {
    skipped.push({ id, documentNumber: null, reason: `More than ${CAP} at once — not attempted.` })
  }

  if (change.kind === 'priority' && !JOB_PRIORITIES.includes(change.priority)) {
    return {
      changed: 0,
      skipped: targets.map((id) => ({ id, documentNumber: null, reason: 'That is not a priority.' })),
    }
  }

  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, document_number, status FROM job_cards WHERE id IN (${targets.map(() => '?').join(',')})`,
    [...targets],
  )
  const byId = new Map(rows.map((r) => [Number(r.id), r]))

  let changed = 0
  for (const id of targets) {
    const row = byId.get(id)
    if (!row) {
      skipped.push({ id, documentNumber: null, reason: 'No longer exists.' })
      continue
    }
    const documentNumber = row.document_number === null ? null : String(row.document_number)

    // A closed job is not editable in bulk any more than it is one at a time.
    if (String(row.status) !== 'open' && change.kind !== 'status') {
      skipped.push({ id, documentNumber, reason: 'This job is closed.' })
      continue
    }

    let result: JobActionResult
    if (change.kind === 'status') {
      // Same door, same rules — including the office and reason checks. A stage
      // needing a reason is refused BY NAME here rather than skipped silently,
      // which is exactly what the skipped list exists to show.
      result = await setStatus(siteId, actor, id, change.statusId, undefined, isOffice)
    } else if (change.kind === 'priority') {
      result = await setPriority(siteId, actor, id, change.priority)
    } else {
      result = await assignOwner(siteId, actor, id, change.ownerUserId, change.ownerName)
    }

    if (result.ok) changed++
    else skipped.push({ id, documentNumber, reason: result.error })
  }

  return { changed, skipped }
}

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
