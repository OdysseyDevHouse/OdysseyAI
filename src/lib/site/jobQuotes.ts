import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteTransaction } from '../siteDb'
import { customerDbPrefix } from './customerDb'
import { round, toNum } from '../decimals'
import { lineTotals } from '../documentMath'
import { nextDocumentNumber } from './sequences'
import { getSetting } from './settings'
import { logActivityTx, type Actor } from './activityLog'
import { reserveForQuote } from './jobReservations'
import {
  ACCEPT_METHODS,
  ACCEPT_METHOD_LABEL,
  BILLABLE_STATES,
  methodNeedsReference,
  type AcceptMethod,
  type BillingState,
} from '../jobStatusModel'

/**
 * Quoting a job, and recording that the customer said yes.
 *
 * ── A JOB QUOTE IS A SALES DOCUMENT ────────────────────────────────────────
 *
 * `doc_type = 'quote'` with a `job_card_id`, and that is the whole of it. 048
 * argued a quote needed no new table because a quote IS a sales document — same
 * lines, same VAT, same documentMath — and nothing about a job quote disturbs
 * that. The quote register at /invoicing/quotes lists these alongside counter quotes
 * and the conversion-rate figure counts them, for free.
 *
 * ── WHY REVISIONS ARE NEW DOCUMENTS ────────────────────────────────────────
 *
 * The PRD is emphatic: a commercial amendment to an accepted quote creates a new
 * version, returns it to pending approval, and requires acceptance again. The
 * system must never silently overwrite an accepted quote.
 *
 * So re-quoting INSERTs a new quote and points it at the old one through
 * supersedes_id. v1 keeps its number, its lines, its acceptance and its date,
 * because what the customer was quoted is precisely what gets disputed. This is
 * the same reasoning convertToInvoice() uses for not turning the quote into the
 * invoice, and the same shape.
 *
 * ── ACCEPTANCE IS ITS OWN EVENT ────────────────────────────────────────────
 *
 * quotes.ts has no acceptQuote(): acceptance happens as a side effect of
 * conversion. That works at a counter and not on a job, where days of work
 * happen between the yes and the invoice. acceptQuote() below records it on its
 * own, with the method and the evidence, and job_cards.accepted_quote_id names
 * which version is live.
 *
 * ── AND IT NEVER POSTS ─────────────────────────────────────────────────────
 *
 * Nothing here moves stock, claims an invoice number or touches a ledger. A
 * quote is an offer. finaliseGuards() has refused to post one since sales orders
 * were built, and billing a job goes through jobInvoicing.ts.
 */

/**
 * The acceptance vocabulary lives in jobStatusModel.ts, which is free of
 * `server-only` — the acceptance dialog is a client component and needs the same
 * labels this file writes to the database. Re-exported so a server caller still
 * has one import, matching how quotes.ts re-exports quotesModel.
 */
export { ACCEPT_METHODS, ACCEPT_METHOD_LABEL, methodNeedsReference }
export type { AcceptMethod }

export type JobQuote = {
  id: number
  documentNumber: string | null
  status: string
  documentDate: string
  validUntil: string | null
  outcome: 'open' | 'accepted' | 'declined'
  outcomeAt: string | null
  lostReason: string | null
  acceptMethod: AcceptMethod | null
  acceptedBy: string | null
  acceptReference: string | null
  acceptedByUserId: number | null
  supersedesId: number | null
  revision: number
  totalIncl: number
  lineCount: number
  /** True when this is the version job_cards.accepted_quote_id names. */
  isLive: boolean
  /** A later revision points at this one, so it has been replaced. */
  supersededById: number | null
}

export type QuoteJobResult =
  | { ok: true; quoteId: number; documentNumber: string | null; revision: number; lineCount: number }
  | { ok: false; error: string }

export type AcceptResult = { ok: true } | { ok: false; error: string }

type Row = RowDataPacket & Record<string, unknown>

function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  return s === '' ? null : s
}

/** A DATETIME as a stable wall clock. See the header in jobAppointments.ts. */
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

/**
 * Every quote raised for a job, newest revision first.
 *
 * The whole chain, not just the live one: "what did we offer, and what changed"
 * is the question a customer asks when the final invoice surprises them.
 */
export async function jobQuotes(siteId: number, jobId: number): Promise<JobQuote[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT d.id, d.document_number, d.status, d.document_date, d.valid_until,
            d.quote_outcome, d.quote_outcome_at, d.quote_lost_reason,
            d.quote_accept_method, d.quote_accepted_by, d.quote_accept_reference,
            d.quote_accepted_by_user_id, d.supersedes_id, d.quote_revision, d.total_incl,
            (SELECT COUNT(*) FROM sales_document_lines l WHERE l.document_id = d.id) AS line_count,
            (SELECT s.id FROM sales_documents s WHERE s.supersedes_id = d.id LIMIT 1) AS superseded_by,
            j.accepted_quote_id
       FROM sales_documents d
       JOIN job_cards j ON j.id = d.job_card_id
      WHERE d.job_card_id = ? AND d.doc_type = 'quote'
      ORDER BY d.quote_revision DESC, d.id DESC`,
    [jobId],
  )

  return rows.map((row) => ({
    id: Number(row.id),
    documentNumber: text(row.document_number),
    status: String(row.status),
    documentDate: String(row.document_date),
    validUntil: row.valid_until === null ? null : String(row.valid_until),
    outcome: String(row.quote_outcome) as 'open' | 'accepted' | 'declined',
    // wallClock, not String(): mysql2 hands back a Date whose String() is a locale
    // string. Only displayed here, but the same shape everywhere is worth more
    // than the saved line — see the helper's header in jobAppointments.ts.
    outcomeAt: wallClock(row.quote_outcome_at),
    lostReason: text(row.quote_lost_reason),
    acceptMethod: row.quote_accept_method === null ? null : (String(row.quote_accept_method) as AcceptMethod),
    acceptedBy: text(row.quote_accepted_by),
    acceptReference: text(row.quote_accept_reference),
    acceptedByUserId:
      row.quote_accepted_by_user_id === null ? null : Number(row.quote_accepted_by_user_id),
    supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id),
    revision: Number(row.quote_revision ?? 1),
    totalIncl: toNum(row.total_incl),
    lineCount: Number(row.line_count ?? 0),
    isLive: row.accepted_quote_id !== null && Number(row.accepted_quote_id) === Number(row.id),
    supersededById: row.superseded_by === null ? null : Number(row.superseded_by),
  }))
}

/**
 * Raise a quote from the job's billable lines.
 *
 * ── WHICH LINES GO ON IT ───────────────────────────────────────────────────
 *
 * The billable ones, by BILLABLE_STATES — the same exported list jobInvoicing
 * filters on, so a line that can be quoted is a line that can be invoiced and
 * neither screen can disagree about which. `internal` and `written_off` are
 * excluded because they are costs the business is absorbing, and putting them in
 * front of a customer would be quoting for work nobody intends to charge for.
 *
 * `pending` is excluded too, and that is the interesting one: an undecided cost
 * has no agreed price, so quoting it would be inventing a commercial position
 * somebody has not taken. Deciding is a separate act, with its own capability.
 */
export async function quoteJob(
  siteId: number,
  actor: Actor,
  jobId: number,
  options: { validUntil?: string | null; notes?: string | null } = {},
): Promise<QuoteJobResult> {
  const cdb = await customerDbPrefix(siteId)
  const job = await siteQueryOne<Row>(
    siteId,
    `SELECT j.id, j.document_number, j.status, j.title, j.customer_id, j.customer_code,
            j.customer_name, j.customer_phone, j.reference, j.accepted_quote_id,
            c.vat_number AS customer_vat_no,
            c.address_line1, c.address_line2, c.city, c.postal_code
       FROM job_cards j
       LEFT JOIN ${cdb}customers c ON c.id = j.customer_id
      WHERE j.id = ?`,
    [jobId],
  )
  if (!job) return { ok: false, error: 'That job no longer exists.' }
  if (String(job.status) === 'cancelled') {
    return { ok: false, error: 'A cancelled job cannot be quoted.' }
  }

  /*
   * A quote has to go TO somebody. Unlike the job itself — which a walk-in may
   * have with only a name — a quote is a document that gets sent, and the
   * snapshot columns need an account to copy from.
   */
  if (job.customer_id === null) {
    return { ok: false, error: 'This job has no customer account. Attach one before quoting it.' }
  }

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT id, line_kind, product_id, product_code, description, qty,
            unit_cost_excl, unit_price_incl, vat_rate_pct, discount_pct
       FROM job_card_lines
      WHERE job_card_id = ?
        AND billing_state IN (${BILLABLE_STATES.map(() => '?').join(',')})
      ORDER BY line_number, id`,
    [jobId, ...BILLABLE_STATES],
  )
  if (lines.length === 0) {
    return {
      ok: false,
      error:
        'Nothing on this job is marked as chargeable yet. Decide who pays for the lines first, then quote it.',
    }
  }

  // The revision this becomes, and what it replaces.
  const prior = await siteQueryOne<Row>(
    siteId,
    `SELECT id, quote_revision FROM sales_documents
      WHERE job_card_id = ? AND doc_type = 'quote'
      ORDER BY quote_revision DESC, id DESC LIMIT 1`,
    [jobId],
  )
  const revision = prior ? Number(prior.quote_revision) + 1 : 1
  const supersedesId = prior ? Number(prior.id) : null

  const validityDays = Number(await getSetting(siteId, 'quote_validity_days'))
  let validUntil = options.validUntil ?? null
  if (!validUntil && Number.isFinite(validityDays) && validityDays > 0) {
    const until = new Date()
    until.setDate(until.getDate() + validityDays)
    validUntil = until.toISOString().slice(0, 10)
  }

  const address = [job.address_line1, job.address_line2, job.city, job.postal_code]
    .map((part) => (part === null || part === undefined ? '' : String(part).trim()))
    .filter(Boolean)
    .join(', ')

  const jobLabel = job.document_number ? String(job.document_number) : `#${jobId}`

  const result = await siteTransaction(siteId, async (tx) => {
    /*
     * A DRAFT quote, and a number claimed straight away — unlike an invoice.
     *
     * A quote is read out and emailed the moment it exists, so it needs a
     * reference the same way a job does. It is also cheap to be wrong about: a
     * quote number is not a tax number, so a gap in the QUO run costs nothing
     * beyond a report noting it. The invoice run keeps its stricter rule for the
     * reason that rule exists.
     */
    const [res] = await tx.execute(
      `INSERT INTO sales_documents
         (doc_type, status, document_date, valid_until, customer_id, customer_code,
          customer_name, customer_vat_no, customer_phone, customer_address,
          user_id, user_name, reference, notes, job_card_id, origin,
          quote_outcome, supersedes_id, quote_revision,
          subtotal_excl, vat_total, discount_total, total_incl)
       VALUES ('quote','draft',?,?,?,?,?,?,?,?,?,?,?,?,?,'back_office','open',?,?,0,0,0,0)`,
      [
        todayIso(),
        validUntil,
        job.customer_id,
        job.customer_code ?? null,
        job.customer_name,
        job.customer_vat_no ?? null,
        job.customer_phone ?? null,
        address || null,
        actor.userId,
        actor.userName.slice(0, 120),
        job.reference ?? null,
        options.notes ?? `Job ${jobLabel} — ${String(job.title)}`,
        jobId,
        supersedesId,
        revision,
      ] as never,
    )
    const quoteId = Number((res as { insertId: number }).insertId)

    let lineNumber = 0
    for (const line of lines) {
      lineNumber += 1
      const qty = toNum(line.qty)
      const unitPriceIncl = toNum(line.unit_price_incl)
      const discountPct = toNum(line.discount_pct)
      const vatRatePct = toNum(line.vat_rate_pct)

      // documentMath owns the arithmetic, exactly as it does on the invoice, so
      // the quote and the invoice raised from the same lines agree to the cent.
      const totals = lineTotals({ qty, unitPriceIncl, discountPct, vatRatePct })

      await tx.execute(
        `INSERT INTO sales_document_lines
           (document_id, line_number, product_id, job_card_line_id, product_code, description,
            product_type, qty, unit_price_incl, discount_pct, discount_incl, vat_rate_pct,
            line_total_incl, line_total_excl, line_vat, unit_cost_excl)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          quoteId,
          lineNumber,
          line.product_id,
          Number(line.id),
          text(line.product_code),
          String(line.description),
          line.product_id === null ? 'service' : 'normal',
          qty.toFixed(3),
          unitPriceIncl.toFixed(4),
          discountPct.toFixed(3),
          totals.discountIncl.toFixed(4),
          vatRatePct.toFixed(3),
          totals.lineTotalIncl.toFixed(4),
          totals.lineTotalExcl.toFixed(4),
          totals.lineVat.toFixed(4),
          toNum(line.unit_cost_excl).toFixed(4),
        ] as never,
      )
    }

    await tx.execute(
      `UPDATE sales_documents d
          SET subtotal_excl  = (SELECT COALESCE(SUM(line_total_excl),0) FROM sales_document_lines WHERE document_id = d.id),
              vat_total      = (SELECT COALESCE(SUM(line_vat),0)        FROM sales_document_lines WHERE document_id = d.id),
              discount_total = (SELECT COALESCE(SUM(discount_incl),0)   FROM sales_document_lines WHERE document_id = d.id),
              total_incl     = (SELECT COALESCE(SUM(line_total_incl),0) FROM sales_document_lines WHERE document_id = d.id)
        WHERE d.id = ?`,
      [quoteId] as never,
    )

    const documentNumber = await nextDocumentNumber(tx, 'quote')
    await tx.execute(`UPDATE sales_documents SET document_number = ? WHERE id = ?`, [
      documentNumber,
      quoteId,
    ])

    /*
     * A NEW revision un-accepts the job.
     *
     * This is the PRD requirement that matters most here: amending an accepted
     * quote returns it to pending approval. Leaving accepted_quote_id pointing at
     * v1 while v2 is the live offer would make the job claim authorisation for a
     * price nobody has agreed to.
     */
    if (supersedesId !== null) {
      await tx.execute(`UPDATE job_cards SET accepted_quote_id = NULL WHERE id = ?`, [jobId])
    }

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: revision === 1 ? 'quoted' : 're_quoted',
      detail:
        revision === 1
          ? `Quote ${documentNumber} raised for ${lineNumber} ${lineNumber === 1 ? 'line' : 'lines'}`
          : `Quote ${documentNumber} (v${revision}) replaces the previous version — acceptance is needed again`,
    })

    return { quoteId, documentNumber, revision, lineCount: lineNumber }
  })

  return { ok: true, ...result }
}

/**
 * Record that the customer said yes.
 *
 * ── WHAT ACCEPTANCE DOES, AND DOES NOT DO ──────────────────────────────────
 *
 * It stamps the quote, names the live version on the job, and marks the lines it
 * covers as `quoted` — the baseline every quoted-versus-actual figure is measured
 * against. It does NOT invoice anything, move stock or post: those are separate
 * acts with their own capabilities, and the PRD says so explicitly.
 *
 * ── AN EXPIRED QUOTE IS ACCEPTED WITH A NOTE, NOT REFUSED ──────────────────
 *
 * A customer accepting a day late is ordinary business, and refusing would mean
 * re-keying the whole quote for nothing. convertToInvoice() takes the same view.
 * The lateness is recorded in the activity note so it is answerable later.
 */
export async function acceptQuote(
  siteId: number,
  actor: Actor,
  quoteId: number,
  input: { method: AcceptMethod; acceptedBy: string; reference?: string | null },
): Promise<AcceptResult> {
  if (!input.acceptedBy?.trim()) {
    return { ok: false, error: 'Who accepted it? A name is what makes this answerable later.' }
  }
  if (methodNeedsReference(input.method) && !input.reference?.trim()) {
    return {
      ok: false,
      error:
        input.method === 'email'
          ? 'Point at the email — a subject line or a date is enough to find it again.'
          : 'Say what was signed, so it can be found again.',
    }
  }

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT id, job_card_id, doc_type, status, document_number, quote_outcome, valid_until,
              quote_revision
         FROM sales_documents WHERE id = ?`,
      [quoteId],
    )
    const quote = rows[0]
    if (!quote) return { ok: false as const, error: 'That quote no longer exists.' }
    if (String(quote.doc_type) !== 'quote') {
      return { ok: false as const, error: 'That document is not a quote.' }
    }
    if (quote.job_card_id === null) {
      return { ok: false as const, error: 'That quote is not attached to a job.' }
    }
    if (String(quote.status) === 'cancelled') {
      return { ok: false as const, error: 'That quote was cancelled.' }
    }
    if (String(quote.quote_outcome) === 'accepted') {
      return { ok: false as const, error: 'That version has already been accepted.' }
    }

    /*
     * A superseded version cannot be accepted. v1 is history the moment v2 exists,
     * and accepting it would leave the job authorised for a price the business has
     * already replaced.
     */
    const [laterRows] = await tx.query<Row[]>(
      `SELECT document_number, quote_revision FROM sales_documents WHERE supersedes_id = ? LIMIT 1`,
      [quoteId],
    )
    if (laterRows[0]) {
      return {
        ok: false as const,
        error: `This version was replaced by ${laterRows[0].document_number ?? `v${laterRows[0].quote_revision}`}. Accept that one instead.`,
      }
    }

    const jobId = Number(quote.job_card_id)
    const late = quote.valid_until !== null && String(quote.valid_until) < todayIso()

    await tx.execute(
      `UPDATE sales_documents
          SET quote_outcome = 'accepted',
              quote_outcome_at = NOW(),
              quote_lost_reason = NULL,
              quote_accept_method = ?,
              quote_accepted_by = ?,
              quote_accept_reference = ?,
              quote_accepted_by_user_id = ?,
              status = CASE WHEN status = 'draft' THEN 'issued' ELSE status END
        WHERE id = ?`,
      [
        input.method,
        input.acceptedBy.trim().slice(0, 160),
        text(input.reference),
        actor.userId,
        quoteId,
      ] as never,
    )

    await tx.execute(`UPDATE job_cards SET accepted_quote_id = ? WHERE id = ?`, [quoteId, jobId])

    /*
     * The lines this quote covers become the QUOTED baseline.
     *
     * Matched by job_card_line_id, the same link jobInvoicing uses, so two lines
     * reading the same are two different lines. Only lines still awaiting a
     * decision or already additional are moved: a line already marked internal is
     * a cost the business chose to absorb, and being on a quote does not undo that
     * decision — see BILLING_TRANSITIONS, which refuses the same move by hand.
     */
    const [moved] = await tx.execute(
      `UPDATE job_card_lines l
         JOIN sales_document_lines s ON s.job_card_line_id = l.id
          SET l.billing_state = 'quoted'
        WHERE s.document_id = ?
          AND l.job_card_id = ?
          AND l.billing_state IN ('pending','additional')`,
      [quoteId, jobId] as never,
    )

    /*
     * And the COST is snapshotted at the same moment (228).
     *
     * unit_cost_excl is the cost NOW — overwritten every time a receipt moves
     * the weighted average. So the figure the quote was priced on stops
     * existing the moment the next delivery arrives, and "did we make what we
     * expected on this job" becomes unanswerable after the fact.
     *
     * Stamped here rather than at quoting, because a quote that was never
     * accepted has no expectation to hold anybody to. Same rows as the rebase
     * above and in the same transaction: a job whose lines say 'quoted' with no
     * quoted cost beside them would be the drift this avoids by construction.
     *
     * The qty goes with it so a line whose SCOPE grew is distinguishable from
     * one whose supplier put the price up. Different problems, different fixes.
     */
    await tx.execute(
      `UPDATE job_card_lines l
         JOIN sales_document_lines s ON s.job_card_line_id = l.id
          SET l.quoted_cost_excl = l.unit_cost_excl,
              l.quoted_qty = l.qty
        WHERE s.document_id = ?
          AND l.job_card_id = ?
          AND l.billing_state = 'quoted'`,
      [quoteId, jobId] as never,
    )

    const label = quote.document_number ? String(quote.document_number) : `Quote #${quoteId}`
    const rebased = (moved as { affectedRows: number }).affectedRows

    /*
     * The parts on an accepted quote are now claimed (§46.6: "Reserved = when it
     * is on an accepted quote").
     *
     * Inside this transaction, so a quote is never accepted without its claim or
     * vice versa. The claim is released the instant the stock actually moves —
     * see the header of jobReservations, where that rule is the whole design.
     */
    const claimed = await reserveForQuote(tx, jobId, quoteId)

    await logActivityTx(tx, actor, {
      entity: 'job_card',
      entityId: jobId,
      action: 'quote_accepted',
      detail:
        `${label} accepted by ${input.acceptedBy.trim()} — ${ACCEPT_METHOD_LABEL[input.method].toLowerCase()}` +
        (input.reference ? ` (${input.reference.trim()})` : '') +
        (late ? '. Accepted after the quote had expired.' : '') +
        (rebased > 0 ? ` ${rebased} ${rebased === 1 ? 'line is' : 'lines are'} now the quoted baseline.` : '') +
        (claimed > 0 ? ` ${claimed} ${claimed === 1 ? 'part is' : 'parts are'} now set aside.` : ''),
    })

    return { ok: true as const, jobId }
  }).then((result) => {
    /*
     * The workflow rules (225), after the commit and swallowed.
     *
     * Same terms as every other hook: a rule may move the job, and a writer
     * inside this transaction would deadlock on the rows it is still holding.
     * "When a customer accepts, move it to Ready to Schedule" is the rule §12
     * names first, so this is the hook it depends on.
     */
    if (result.ok && 'jobId' in result && typeof result.jobId === 'number') {
      const jid = result.jobId
      void import('./jobRules')
        .then((m) => m.fireJobEvent(siteId, actor, { event: 'quote_accepted', jobId: jid }))
        .catch(() => {})
    }
    return result
  })
}

/**
 * Record that the customer said no.
 *
 * The reason is required, for the same purpose declineQuote() gives: one lost
 * quote tells you nothing, a hundred with "price" against sixty of them tells you
 * something worth acting on, and that only exists if it is captured the moment
 * somebody knows it.
 */
export async function declineJobQuote(
  siteId: number,
  actor: Actor,
  quoteId: number,
  reason: string,
): Promise<AcceptResult> {
  if (!reason?.trim()) {
    return { ok: false, error: 'Why was it turned down? A pattern in the reasons is worth having.' }
  }

  return siteTransaction(siteId, async (tx) => {
    const [rows] = await tx.query<Row[]>(
      `SELECT id, job_card_id, doc_type, document_number, quote_outcome
         FROM sales_documents WHERE id = ?`,
      [quoteId],
    )
    const quote = rows[0]
    if (!quote) return { ok: false as const, error: 'That quote no longer exists.' }
    if (String(quote.doc_type) !== 'quote') {
      return { ok: false as const, error: 'That document is not a quote.' }
    }
    if (String(quote.quote_outcome) === 'accepted') {
      return {
        ok: false as const,
        error: 'That version was accepted. Raise a new version rather than un-accepting this one.',
      }
    }

    await tx.execute(
      `UPDATE sales_documents
          SET quote_outcome = 'declined', quote_outcome_at = NOW(), quote_lost_reason = ?
        WHERE id = ?`,
      [reason.trim().slice(0, 190), quoteId] as never,
    )

    if (quote.job_card_id !== null) {
      await logActivityTx(tx, actor, {
        entity: 'job_card',
        entityId: Number(quote.job_card_id),
        action: 'quote_declined',
        detail: `${quote.document_number ?? `Quote #${quoteId}`} declined — ${reason.trim()}`,
      })
    }

    return { ok: true as const, jobId: quote.job_card_id === null ? null : Number(quote.job_card_id) }
  }).then((result) => {
    /* The rules (225). Only when the quote belongs to a job — a standalone
       sales quote has nothing for a job rule to fire on. */
    if (result.ok && 'jobId' in result && typeof result.jobId === 'number') {
      const jid = result.jobId
      void import('./jobRules')
        .then((m) => m.fireJobEvent(siteId, actor, { event: 'quote_declined', jobId: jid }))
        .catch(() => {})
    }
    return result
  })
}

export type QuoteVariance = {
  /** What the accepted quote came to. Null when nothing is accepted. */
  quotedTotal: number | null
  quotedNumber: string | null
  quotedRevision: number | null
  /** Chargeable work on the job now, whether or not it was on the quote. */
  chargeableTotal: number
  /** chargeable - quoted. Positive means the job grew past what was agreed. */
  variance: number | null
  variancePct: number | null
  /** Lines added since acceptance that were never quoted. */
  unquotedLines: { id: number; description: string; state: BillingState; value: number }[]

  /* ── The COST side (228) ──────────────────────────────────────────────
     What the job was expected to cost when the quote was accepted, against
     what it is costing now. The price side above is what the customer argues
     about; this is where the margin quietly goes. */

  /**
   * The cost the accepted quote was priced on. Null when nothing was
   * snapshotted — a job accepted before 228, or one never quoted.
   */
  quotedCost: number | null
  /** What those same lines cost now. Null for the same reasons. */
  actualCost: number | null
  /** actualCost - quotedCost. Positive means the job is costing more. */
  costVariance: number | null
  /**
   * Lines costing more than the quote assumed, worst first.
   *
   * qtyGrew separates the two causes: a line whose SCOPE grew is a
   * conversation about what was agreed, a line whose unit cost grew is a
   * conversation with the supplier. Reporting one number for both would send
   * somebody to argue with the wrong person.
   */
  costOverruns: {
    id: number
    description: string
    quotedCost: number
    actualCost: number
    variance: number
    qtyGrew: boolean
  }[]
}

/**
 * Quoted versus actual, for one job.
 *
 * The figure the PRD asks for in three separate places, computed once here so the
 * job screen and any later report cannot disagree about it.
 *
 * `chargeableTotal` deliberately re-derives from the lines rather than reading the
 * invoice: this answers "has the job grown past what we agreed", which is a
 * question about scope and must be answerable BEFORE anything is invoiced. What
 * was actually billed is jobTotals().invoiced, and that reads the invoice.
 */
export async function quoteVariance(siteId: number, jobId: number): Promise<QuoteVariance> {
  const accepted = await siteQueryOne<Row>(
    siteId,
    `SELECT d.id, d.document_number, d.quote_revision, d.total_incl
       FROM job_cards j
       JOIN sales_documents d ON d.id = j.accepted_quote_id
      WHERE j.id = ?`,
    [jobId],
  )

  const lines = await siteQuery<Row>(
    siteId,
    `SELECT l.id, l.description, l.billing_state, l.qty, l.unit_price_incl, l.discount_pct,
            l.unit_cost_excl, l.quoted_cost_excl, l.quoted_qty,
            (SELECT COUNT(*) FROM sales_document_lines s
              WHERE s.job_card_line_id = l.id AND s.document_id = ?) AS on_quote
       FROM job_card_lines l
      WHERE l.job_card_id = ?
        AND l.billing_state IN (${BILLABLE_STATES.map(() => '?').join(',')})`,
    [accepted ? Number(accepted.id) : 0, jobId, ...BILLABLE_STATES],
  )

  let chargeable = 0
  const unquoted: QuoteVariance['unquotedLines'] = []

  /*
   * The cost totals count ONLY lines carrying a snapshot.
   *
   * A NULL quoted_cost_excl means "never quoted", never "cost nothing" — see
   * 228's header. Counting it as zero would report a 100% overrun on every line
   * added after acceptance, which is the shape of figure somebody acts on and
   * then cannot explain. So both sides of the comparison are summed over the
   * same subset, and a job with no snapshot at all reports null rather than 0.
   */
  let quotedCost = 0
  let actualCost = 0
  let haveSnapshot = false
  const overruns: QuoteVariance['costOverruns'] = []

  for (const line of lines) {
    const gross = toNum(line.qty) * toNum(line.unit_price_incl)
    const value = round(gross - gross * (toNum(line.discount_pct) / 100), 2)
    chargeable += value
    if (Number(line.on_quote ?? 0) === 0) {
      unquoted.push({
        id: Number(line.id),
        description: String(line.description),
        state: String(line.billing_state) as BillingState,
        value,
      })
    }

    if (line.quoted_cost_excl === null || line.quoted_cost_excl === undefined) continue
    haveSnapshot = true

    const qtyThen = toNum(line.quoted_qty)
    const qtyNow = toNum(line.qty)
    const wasCost = round(toNum(line.quoted_cost_excl) * qtyThen, 2)
    const nowCost = round(toNum(line.unit_cost_excl) * qtyNow, 2)
    quotedCost += wasCost
    actualCost += nowCost

    const variance = round(nowCost - wasCost, 2)
    // Cents of tolerance: a rounding artefact is not an overrun worth a row.
    if (variance > 0.004) {
      overruns.push({
        id: Number(line.id),
        description: String(line.description),
        quotedCost: wasCost,
        actualCost: nowCost,
        variance,
        qtyGrew: qtyNow > qtyThen + 0.0001,
      })
    }
  }

  // Worst first: a list nobody can rank is a list nobody reads past the top.
  overruns.sort((a, b) => b.variance - a.variance)

  const quotedTotal = accepted ? toNum(accepted.total_incl) : null
  const chargeableTotal = round(chargeable, 2)
  const variance = quotedTotal === null ? null : round(chargeableTotal - quotedTotal, 2)

  return {
    quotedTotal,
    quotedNumber: accepted ? text(accepted.document_number) : null,
    quotedRevision: accepted ? Number(accepted.quote_revision) : null,
    chargeableTotal,
    variance,
    variancePct:
      variance === null || quotedTotal === null || quotedTotal === 0
        ? null
        : round((variance / quotedTotal) * 100, 2),
    unquotedLines: unquoted,
    quotedCost: haveSnapshot ? round(quotedCost, 2) : null,
    actualCost: haveSnapshot ? round(actualCost, 2) : null,
    costVariance: haveSnapshot ? round(actualCost - quotedCost, 2) : null,
    costOverruns: overruns,
  }
}

/**
 * Whether work may proceed on this job.
 *
 * Off by default. The commonest real case is a technician already on site finding
 * a second fault, and refusing outright would strand them — so the setting exists
 * for the businesses that genuinely gate work on a signature, and everybody else
 * is unaffected. Returns a sentence rather than a boolean so the caller can say
 * WHY rather than just refusing.
 */
export async function workBlockedReason(siteId: number, jobId: number): Promise<string | null> {
  const required = (await getSetting(siteId, 'job_require_quote_acceptance')) === '1'
  if (!required) return null

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT j.accepted_quote_id,
            (SELECT COUNT(*) FROM sales_documents d
              WHERE d.job_card_id = j.id AND d.doc_type = 'quote') AS quote_count
       FROM job_cards j WHERE j.id = ?`,
    [jobId],
  )
  if (!row) return null
  if (row.accepted_quote_id !== null) return null

  return Number(row.quote_count ?? 0) === 0
    ? 'This business requires an accepted quote before work starts, and this job has not been quoted yet.'
    : 'The quote for this job has not been accepted yet.'
}
