import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQuery, siteQueryOne, siteExecute, siteTransaction } from '../siteDb'
import { round, toNum } from '../decimals'
import { logActivity, logActivityTx, type Actor } from './activityLog'
import { getDocument, listDocuments } from './salesDocuments'
import { getNumericSetting } from './settings'
import { nextDocumentNumber } from './sequences'
import { today } from './ledger'
// The pure half, imported for use here as well as re-exported below —
// `export *` re-publishes these names but does not bring them into scope.
import {
  quoteState,
  type QuoteOutcome,
  type QuoteState,
} from '../quotesModel'

/**
 * Quotes.
 *
 * ── A QUOTE IS A SALES DOCUMENT ──────────────────────────────────────────
 *
 * Not a parallel type. It has a customer, lines, prices, VAT and a total,
 * computed by the same documentMath as an invoice, and it lives in
 * sales_documents under `doc_type = 'quote'`. This module adds only what a
 * quote has that an invoice does not: a validity date, an outcome, and the
 * conversion that turns it into an invoice.
 *
 * Everything else — capture, editing, line maths, the editor screen — is the
 * invoicing machinery, used unchanged. That is the point: one place where a
 * line total is worked out means one place it can be wrong.
 *
 * ── IT NEVER POSTS ───────────────────────────────────────────────────────
 *
 * No stock moves, no ledger entry, no VAT declared, because a quote is an
 * offer rather than a tax document. finaliseGuards() in salesPosting.ts has
 * refused to post one since sales orders were built; this module never asks it
 * to. "Finalising" a quote means issuing it to the customer.
 *
 * ── CONVERSION CREATES, IT DOES NOT MUTATE ───────────────────────────────
 *
 * Accepting a quote produces a NEW invoice linked by converted_from_id. The
 * quote stays exactly as it was offered, which is the whole point: what the
 * customer was quoted is precisely what gets disputed, and turning the quote
 * into the invoice destroys the evidence.
 */

/*
 * The states, labels and `quoteState` live in lib/quotesModel.ts, which
 * carries no `server-only` marker so the register table in the browser can
 * apply the identical rules. Re-exported here so a server caller keeps one
 * import.
 */
export * from '../quotesModel'

export type Quote = {
  id: number
  documentNumber: string | null
  documentDate: string
  status: string
  customerId: number | null
  customerName: string | null
  subtotalExcl: number
  vatTotal: number
  totalIncl: number
  validUntil: string | null
  outcome: QuoteOutcome
  outcomeAt: Date | null
  lostReason: string | null
  /** When it was last emailed, and to whom (227). */
  sentAt: Date | null
  sentTo: string | null
  /** When the customer first opened it, and how often since (227). */
  viewedAt: Date | null
  viewCount: number
  /** The invoice this quote became, if it was accepted. */
  convertedToId: number | null
  convertedToNumber: string | null
  /** Derived — see QuoteState. */
  state: QuoteState
  /** Days until it expires. Negative once past. Null when it never expires. */
  daysRemaining: number | null
  userName: string
  createdAt: Date
}

type Row = RowDataPacket & Record<string, unknown>

function mapQuote(r: Row, asAt: string): Quote {
  const validUntil = r.valid_until === null ? null : String(r.valid_until)
  const outcome = String(r.quote_outcome ?? 'open') as QuoteOutcome
  const status = String(r.status)

  return {
    id: Number(r.id),
    documentNumber: (r.document_number as string | null) ?? null,
    documentDate: String(r.document_date),
    status,
    customerId: r.customer_id === null ? null : Number(r.customer_id),
    customerName: (r.customer_name as string | null) ?? null,
    subtotalExcl: toNum(r.subtotal_excl),
    vatTotal: toNum(r.vat_total),
    totalIncl: toNum(r.total_incl),
    validUntil,
    outcome,
    outcomeAt: (r.quote_outcome_at as Date | null) ?? null,
    lostReason: (r.quote_lost_reason as string | null) ?? null,
    /*
     * Read defensively. SELECT_QUOTE is `d.*`, so on a site that has not run
     * 227 these columns are simply absent from the row rather than null — and
     * a bare cast would hand undefined to quoteState, which reads it as falsy
     * and correctly reports 'open'. Spelled out so that is a decision.
     */
    sentAt: (r.quote_sent_at as Date | null) ?? null,
    sentTo: (r.quote_sent_to as string | null) ?? null,
    viewedAt: (r.quote_viewed_at as Date | null) ?? null,
    viewCount: r.quote_view_count === undefined ? 0 : Number(r.quote_view_count ?? 0),
    convertedToId: r.converted_to_id === null ? null : Number(r.converted_to_id),
    convertedToNumber: (r.converted_to_number as string | null) ?? null,
    state: quoteState({
      status,
      outcome,
      validUntil,
      sentAt: (r.quote_sent_at as Date | null) ?? null,
      viewedAt: (r.quote_viewed_at as Date | null) ?? null,
      asAt,
    }),
    daysRemaining: validUntil ? daysBetween(asAt, validUntil) : null,
    userName: String(r.user_name ?? ''),
    createdAt: r.created_at as Date,
  }
}

const SELECT_QUOTE = `
  SELECT d.*,
         inv.id AS converted_to_id,
         inv.document_number AS converted_to_number
    FROM sales_documents d
    LEFT JOIN sales_documents inv
           ON inv.converted_from_id = d.id AND inv.doc_type = 'invoice'
                                           AND inv.status <> 'cancelled'
`

/* ── Reads ───────────────────────────────────────────────────────────────── */

export type QuoteListOptions = {
  /** Filter by derived state. 'expired' is computed, so it filters in SQL by date. */
  state?: QuoteState
  search?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
}

export async function listQuotes(
  siteId: number,
  opts: QuoteListOptions = {},
): Promise<{ items: Quote[]; total: number }> {
  const asAt = today()
  const where: string[] = ["d.doc_type = 'quote'"]
  const params: unknown[] = []

  switch (opts.state) {
    case 'draft':
      where.push("d.status IN ('draft','saved')")
      break
    case 'open':
      // Issued, no answer yet, and still inside its validity.
      where.push(
        "d.status IN ('issued','finalised') AND d.quote_outcome = 'open' AND (d.valid_until IS NULL OR d.valid_until >= ?)",
      )
      params.push(asAt)
      break
    case 'expired':
      where.push(
        "d.status IN ('issued','finalised') AND d.quote_outcome = 'open' AND d.valid_until < ?",
      )
      params.push(asAt)
      break
    case 'accepted':
      where.push("d.quote_outcome = 'accepted'")
      break
    case 'declined':
      where.push("d.quote_outcome = 'declined'")
      break
    case 'cancelled':
      where.push("d.status = 'cancelled'")
      break
    default:
      where.push("d.status <> 'cancelled'")
  }

  if (opts.from) {
    where.push('d.document_date >= ?')
    params.push(opts.from)
  }
  if (opts.to) {
    where.push('d.document_date <= ?')
    params.push(opts.to)
  }
  if (opts.search?.trim()) {
    const term = `%${opts.search.trim()}%`
    where.push('(d.document_number LIKE ? OR d.customer_name LIKE ? OR d.reference LIKE ?)')
    params.push(term, term, term)
  }

  const whereSql = `WHERE ${where.join(' AND ')}`
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const offset = Math.max(opts.offset ?? 0, 0)

  const [rows, countRow] = await Promise.all([
    siteQuery<Row>(
      siteId,
      `${SELECT_QUOTE} ${whereSql}
        ORDER BY d.document_date DESC, d.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    siteQueryOne<Row>(
      siteId,
      `SELECT COUNT(*) AS n FROM sales_documents d ${whereSql}`,
      params,
    ),
  ])

  return { items: rows.map((r) => mapQuote(r, asAt)), total: Number(countRow?.n ?? 0) }
}

export async function getQuote(siteId: number, id: number): Promise<Quote | null> {
  const row = await siteQueryOne<Row>(
    siteId,
    `${SELECT_QUOTE} WHERE d.id = ? AND d.doc_type = 'quote' LIMIT 1`,
    [id],
  )
  return row ? mapQuote(row, today()) : null
}

export type QuoteSummary = {
  openCount: number
  openValue: number
  /** Open, and expiring within a week — the ones worth a phone call. */
  expiringSoon: number
  expiringSoonValue: number
  expiredCount: number
  expiredValue: number
  /** Accepted and declined over the period, for the conversion rate. */
  acceptedCount: number
  acceptedValue: number
  declinedCount: number
  /** Accepted as a percentage of decided quotes. Null when none were decided. */
  conversionRate: number | null
}

/**
 * The figures the quote register is actually for.
 *
 * The conversion rate is the number a business owner wants and almost never
 * has: of the quotes that got an answer, what share became work. Quotes still
 * open are deliberately excluded from the denominator — counting undecided
 * quotes as losses would make the rate look worse the more quoting you do.
 */
export async function quoteSummary(
  siteId: number,
  range?: { from: string; to: string },
): Promise<QuoteSummary> {
  const asAt = today()
  const soon = addDays(asAt, 7)

  const dateFilter = range ? 'AND d.document_date BETWEEN ? AND ?' : ''
  const dateParams = range ? [range.from, range.to] : []

  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT
       COUNT(CASE WHEN d.quote_outcome = 'open' AND d.status IN ('issued','finalised')
                   AND (d.valid_until IS NULL OR d.valid_until >= ?) THEN 1 END) AS open_n,
       COALESCE(SUM(CASE WHEN d.quote_outcome = 'open' AND d.status IN ('issued','finalised')
                   AND (d.valid_until IS NULL OR d.valid_until >= ?) THEN d.total_incl END), 0) AS open_value,
       COUNT(CASE WHEN d.quote_outcome = 'open' AND d.status IN ('issued','finalised')
                   AND d.valid_until BETWEEN ? AND ? THEN 1 END) AS soon_n,
       COALESCE(SUM(CASE WHEN d.quote_outcome = 'open' AND d.status IN ('issued','finalised')
                   AND d.valid_until BETWEEN ? AND ? THEN d.total_incl END), 0) AS soon_value,
       COUNT(CASE WHEN d.quote_outcome = 'open' AND d.status IN ('issued','finalised')
                   AND d.valid_until < ? THEN 1 END) AS expired_n,
       COALESCE(SUM(CASE WHEN d.quote_outcome = 'open' AND d.status IN ('issued','finalised')
                   AND d.valid_until < ? THEN d.total_incl END), 0) AS expired_value,
       COUNT(CASE WHEN d.quote_outcome = 'accepted' THEN 1 END) AS accepted_n,
       COALESCE(SUM(CASE WHEN d.quote_outcome = 'accepted' THEN d.total_incl END), 0) AS accepted_value,
       COUNT(CASE WHEN d.quote_outcome = 'declined' THEN 1 END) AS declined_n
     FROM sales_documents d
    WHERE d.doc_type = 'quote' AND d.status <> 'cancelled' ${dateFilter}`,
    [asAt, asAt, asAt, soon, asAt, soon, asAt, asAt, ...dateParams],
  )

  const acceptedCount = Number(row?.accepted_n ?? 0)
  const declinedCount = Number(row?.declined_n ?? 0)
  const decided = acceptedCount + declinedCount

  return {
    openCount: Number(row?.open_n ?? 0),
    openValue: toNum(row?.open_value),
    expiringSoon: Number(row?.soon_n ?? 0),
    expiringSoonValue: toNum(row?.soon_value),
    expiredCount: Number(row?.expired_n ?? 0),
    expiredValue: toNum(row?.expired_value),
    acceptedCount,
    acceptedValue: toNum(row?.accepted_value),
    declinedCount,
    conversionRate: decided > 0 ? round((acceptedCount / decided) * 100, 1) : null,
  }
}

/** Why quotes were lost, grouped. A pattern is worth more than any one loss. */
export async function lostReasons(
  siteId: number,
  range?: { from: string; to: string },
): Promise<{ reason: string; count: number; value: number }[]> {
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT COALESCE(NULLIF(TRIM(quote_lost_reason), ''), 'Not stated') AS reason,
            COUNT(*) AS n, COALESCE(SUM(total_incl), 0) AS value
       FROM sales_documents
      WHERE doc_type = 'quote' AND quote_outcome = 'declined'
        ${range ? 'AND document_date BETWEEN ? AND ?' : ''}
      GROUP BY reason
      ORDER BY n DESC`,
    range ? [range.from, range.to] : [],
  )

  return rows.map((r) => ({
    reason: String(r.reason),
    count: Number(r.n),
    value: toNum(r.value),
  }))
}

/* ── Validity ────────────────────────────────────────────────────────────── */

/** The default validity date for a quote raised today. */
export async function defaultValidUntil(siteId: number, from?: string): Promise<string | null> {
  const days = await getNumericSetting(siteId, 'quote_validity_days')
  if (days <= 0) return null
  return addDays(from ?? today(), Math.round(days))
}

export async function setValidUntil(
  siteId: number,
  actor: Actor,
  id: number,
  validUntil: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    return { ok: false, error: 'That date is not valid.' }
  }

  const quote = await getQuote(siteId, id)
  if (!quote) return { ok: false, error: 'That quote no longer exists.' }
  if (quote.outcome !== 'open') {
    return { ok: false, error: 'That quote has already been answered.' }
  }

  await siteExecute(siteId, 'UPDATE sales_documents SET valid_until = ? WHERE id = ?', [
    validUntil,
    id,
  ])
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: quote.customerId,
    action: 'quote_validity',
    detail: `${quote.documentNumber ?? `Quote #${id}`} valid until ${validUntil ?? 'no expiry'}`,
  })
  return { ok: true }
}

/* ── Outcomes ────────────────────────────────────────────────────────────── */

export type OutcomeResult = { ok: true } | { ok: false; error: string }

/**
 * Records that a quote was declined.
 *
 * The reason is asked for rather than optional. One lost quote tells you
 * nothing; a hundred with "price" against sixty of them tells you something
 * worth acting on, and that only exists if the reason is captured at the moment
 * somebody knows it.
 */
export async function declineQuote(
  siteId: number,
  actor: Actor,
  id: number,
  reason: string,
): Promise<OutcomeResult> {
  if (!reason?.trim()) return { ok: false, error: 'Why was it lost? A pattern in the reasons is worth having.' }

  const quote = await getQuote(siteId, id)
  if (!quote) return { ok: false, error: 'That quote no longer exists.' }
  if (quote.outcome === 'accepted') {
    return { ok: false, error: 'That quote was accepted and converted to an invoice.' }
  }

  await siteExecute(
    siteId,
    `UPDATE sales_documents
        SET quote_outcome = 'declined', quote_outcome_at = NOW(), quote_lost_reason = ?
      WHERE id = ?`,
    [reason.trim().slice(0, 190), id],
  )

  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: quote.customerId,
    action: 'quote_declined',
    detail: `${quote.documentNumber ?? `Quote #${id}`} declined — ${reason.trim()}`,
  })

  /*
   * Stop the deposit link on a declined quote.
   *
   * The customer said no, and the emailed PDF with its square is still in their
   * inbox. Taking a deposit against an offer that has been turned down is money
   * arriving for work nobody is going to do.
   *
   * Best effort and last: the decline is recorded and correct either way.
   */
  try {
    const { revokePayLinks } = await import('./payLinks')
    await revokePayLinks(siteId, 'document_deposit', id)
  } catch (error) {
    console.error('[pay-links] revoke failed for declined quote', id, error)
  }

  return { ok: true }
}

/** Puts a decided quote back to open, for an answer recorded in error. */
export async function reopenQuote(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<OutcomeResult> {
  const quote = await getQuote(siteId, id)
  if (!quote) return { ok: false, error: 'That quote no longer exists.' }
  if (quote.convertedToId) {
    return {
      ok: false,
      error: `That quote became invoice ${quote.convertedToNumber ?? `#${quote.convertedToId}`}. Void the invoice first.`,
    }
  }

  await siteExecute(
    siteId,
    `UPDATE sales_documents
        SET quote_outcome = 'open', quote_outcome_at = NULL, quote_lost_reason = NULL
      WHERE id = ?`,
    [id],
  )
  await logActivity(siteId, actor, {
    entity: 'customer',
    entityId: quote.customerId,
    action: 'quote_reopened',
    detail: `${quote.documentNumber ?? `Quote #${id}`} reopened`,
  })
  return { ok: true }
}

/* ── Issuing ─────────────────────────────────────────────────────────────── */

export type IssueResult =
  | { ok: true; documentNumber: string }
  | { ok: false; error: string }

/**
 * Issues a quote to the customer.
 *
 * Gives it its QUO number and marks it issued. POSTS NOTHING — no stock moves,
 * no ledger entry, no VAT declared — because a quote is an offer rather than a
 * tax document. That is why this does not call finaliseDocument: the posting
 * engine correctly refuses a quote, and asking it to would be asking for the
 * wrong thing.
 */
export async function issueQuote(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<IssueResult> {
  const quote = await getQuote(siteId, id)
  if (!quote) return { ok: false, error: 'That quote no longer exists.' }
  if (quote.status === 'cancelled') return { ok: false, error: 'That quote was cancelled.' }
  if (quote.documentNumber) {
    return { ok: false, error: `That quote is already issued as ${quote.documentNumber}.` }
  }

  const document = await getDocument(siteId, id)
  if (!document || document.lines.length === 0) {
    return { ok: false, error: 'Add at least one line before issuing the quote.' }
  }

  const documentNumber = await siteTransaction(siteId, async (tx) => {
    const number = await nextDocumentNumber(tx, 'quote')

    await tx.execute(
      `UPDATE sales_documents
          SET status = 'issued', document_number = ?
        WHERE id = ? AND status IN ('draft','saved')`,
      [number, id] as never,
    )

    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'issued', ?, ?, ?)`,
      [
        id,
        `${number} issued${quote.validUntil ? `, valid until ${quote.validUntil}` : ''}`,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: quote.customerId,
      action: 'quote_issued',
      detail: `${number} · ${quote.totalIncl.toFixed(2)}${quote.customerName ? ` · ${quote.customerName}` : ''}`,
    })

    return number
  })

  return { ok: true, documentNumber }
}

/* ── Conversion ──────────────────────────────────────────────────────────── */

export type ConvertResult =
  | { ok: true; invoiceId: number; warnings: string[] }
  | { ok: false; error: string }

/**
 * Turns an accepted quote into an invoice.
 *
 * ── IT CREATES, IT DOES NOT MUTATE ───────────────────────────────────────
 *
 * A NEW draft invoice, linked by converted_from_id. The quote stays exactly as
 * it was offered — because what the customer was quoted is precisely what gets
 * disputed, and turning the quote into the invoice destroys the evidence.
 *
 * The invoice is a DRAFT, not a posted sale. Prices may have moved, stock may
 * be short, and the person converting has to see it before money and stock
 * move. Conversion removes the re-keying, not the judgement — the same rule the
 * recurring-expense schedule follows.
 *
 * ── EXPIRY WARNS, IT DOES NOT BLOCK ──────────────────────────────────────
 *
 * A customer accepting a day late is ordinary business, and refusing would mean
 * re-keying the whole quote. So an expired quote converts with a warning
 * attached, which the screen shows.
 */
export async function convertToInvoice(
  siteId: number,
  actor: Actor,
  id: number,
): Promise<ConvertResult> {
  const quote = await getQuote(siteId, id)
  if (!quote) return { ok: false, error: 'That quote no longer exists.' }
  if (quote.status === 'cancelled') return { ok: false, error: 'That quote was cancelled.' }
  if (quote.convertedToId) {
    return {
      ok: false,
      error: `That quote is already invoice ${quote.convertedToNumber ?? `#${quote.convertedToId}`}.`,
    }
  }

  const document = await getDocument(siteId, id)
  if (!document || document.lines.length === 0) {
    return { ok: false, error: 'That quote has no lines to invoice.' }
  }

  const warnings: string[] = []

  if (quote.state === 'expired') {
    warnings.push(
      `This quote expired on ${quote.validUntil}. Check the prices still stand before finalising.`,
    )
  }

  // Prices that have moved since the quote was raised. A warning rather than an
  // adjustment: honouring a quote is a commercial decision, not an arithmetic
  // one, and silently re-pricing would break the promise made to the customer.
  const moved = await pricesMoved(siteId, document.lines)
  if (moved.length > 0) {
    warnings.push(
      `${moved.length} line${moved.length === 1 ? "'s price has" : "s' prices have"} changed since the quote was raised: ${moved.slice(0, 3).join(', ')}${moved.length > 3 ? '…' : ''}.`,
    )
  }

  // Stock that will not cover it. Quotes reserve nothing — an offer is not a
  // commitment, and ten open quotes for the last unit would each hold it — so
  // this is checked at conversion instead.
  const short = await stockShortfall(siteId, document.lines)
  if (short.length > 0) {
    warnings.push(
      `Not enough stock for ${short.length} line${short.length === 1 ? '' : 's'}: ${short.slice(0, 3).join(', ')}${short.length > 3 ? '…' : ''}.`,
    )
  }

  const invoiceId = await siteTransaction(siteId, async (tx) => {
    const [res] = await tx.execute(
      `INSERT INTO sales_documents
         (doc_type, status, document_date, customer_id, customer_code, customer_name,
          customer_vat_no, customer_phone, customer_address, price_structure_id,
          user_id, user_name, terminal_id, terminal_code,
          subtotal_excl, vat_total, discount_total, total_incl,
          reference, notes, converted_from_id)
       SELECT 'invoice', 'draft', ?, customer_id, customer_code, customer_name,
              customer_vat_no, customer_phone, customer_address, price_structure_id,
              ?, ?, terminal_id, terminal_code,
              subtotal_excl, vat_total, discount_total, total_incl,
              reference, notes, id
         FROM sales_documents WHERE id = ?`,
      [today(), actor.userId, actor.userName.slice(0, 120), id] as never,
    )
    const newId = (res as { insertId: number }).insertId

    // Lines copied verbatim: the quote's prices are what was offered, and
    // re-deriving them from today's price list would silently break the offer.
    await tx.execute(
      `INSERT INTO sales_document_lines
         (document_id, line_number, product_id, product_code, description, product_type,
          department_id, sales_rep_id, qty, unit_price_incl, discount_pct, discount_incl,
          vat_rate_pct, line_total_incl, line_total_excl, line_vat, unit_cost_excl)
       SELECT ?, line_number, product_id, product_code, description, product_type,
              department_id, sales_rep_id, qty, unit_price_incl, discount_pct, discount_incl,
              vat_rate_pct, line_total_incl, line_total_excl, line_vat, unit_cost_excl
         FROM sales_document_lines WHERE document_id = ?
         ORDER BY line_number`,
      [newId, id] as never,
    )

    await tx.execute(
      `UPDATE sales_documents
          SET quote_outcome = 'accepted', quote_outcome_at = NOW()
        WHERE id = ?`,
      [id] as never,
    )

    /*
     * The deposit follows the quote onto the invoice (172).
     *
     * A quote converts by creating a NEW document, so money held against the
     * quote would otherwise be stranded on a record nobody looks at again — and
     * the customer would be asked to pay in full for something they had already
     * put money down on.
     *
     * Moved rather than copied: it is the same money, and a copy would show as
     * held twice. The quote keeps its document_audit trail, which is what says
     * a deposit was taken against it and where the money went.
     *
     * Only rows still HELD move. An 'applied' row belongs to a sale that has
     * already posted, and re-pointing it at a new invoice would credit that
     * invoice with money another document has spent. Refund rows move with
     * their deposits so the sum stays honest.
     */
    await tx.execute(
      `UPDATE sale_deposits
          SET document_id = ?
        WHERE document_id = ? AND kind <> 'applied'`,
      [newId, id] as never,
    )

    await tx.execute(
      `INSERT INTO document_audit (document_id, action, detail, user_id, user_name)
       VALUES (?, 'converted', ?, ?, ?)`,
      [
        id,
        `Accepted and converted to a draft invoice (#${newId})`,
        actor.userId,
        actor.userName.slice(0, 120),
      ] as never,
    )

    await logActivityTx(tx, actor, {
      entity: 'customer',
      entityId: quote.customerId,
      action: 'quote_accepted',
      detail: `${quote.documentNumber ?? `Quote #${id}`} accepted — ${quote.totalIncl.toFixed(2)}`,
    })

    return newId
  })

  return { ok: true, invoiceId, warnings }
}

/** Lines whose product price has moved since the quote was raised. */
async function pricesMoved(
  siteId: number,
  lines: {
    productId: number | null
    productCode: string | null
    unitPriceIncl: number
    description: string
  }[],
): Promise<string[]> {
  const withProduct = lines.filter((l) => l.productId)
  if (withProduct.length === 0) return []

  const ids = withProduct.map((l) => l.productId as number)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, price_incl FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  ).catch(() => [] as Row[])

  const current = new Map(rows.map((r) => [Number(r.id), toNum(r.price_incl)]))

  return withProduct
    .filter((l) => {
      const now = current.get(l.productId as number)
      return now !== undefined && round(now, 2) !== round(l.unitPriceIncl, 2)
    })
    .map((l) => l.productCode || l.description)
}

/** Lines the current stock will not cover. */
async function stockShortfall(
  siteId: number,
  lines: {
    productId: number | null
    productCode: string | null
    qty: number
    productType: string
    description: string
  }[],
): Promise<string[]> {
  const stocked = lines.filter((l) => l.productId && l.productType === 'normal')
  if (stocked.length === 0) return []

  const ids = stocked.map((l) => l.productId as number)
  const rows = await siteQuery<Row>(
    siteId,
    `SELECT id, qty_on_hand FROM products WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  ).catch(() => [] as Row[])

  const onHand = new Map(rows.map((r) => [Number(r.id), toNum(r.qty_on_hand)]))

  return stocked
    .filter((l) => (onHand.get(l.productId as number) ?? 0) < l.qty)
    .map((l) => l.productCode || l.description)
}

/* ── Dates ───────────────────────────────────────────────────────────────── */

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime()
  const b = new Date(`${to}T00:00:00`).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}
