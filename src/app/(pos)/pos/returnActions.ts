'use server'

import { actorFor, withTillOperator } from '@/lib/auth'
import { can, type CapabilitySet } from '@/lib/site/permissions'
import { verifyOverrideToken } from '@/lib/overrideToken'
import { siteQuery, siteQueryOne } from '@/lib/siteDb'
import { getDocument, saveDraft, type LineInput } from '@/lib/site/salesDocuments'
import { finaliseDocument } from '@/lib/site/salesPosting'
import {
  createCreditNote,
  creditableLines,
  type CreditLineInput,
} from '@/lib/site/salesReversal'
import { getTenderByCode } from '@/lib/site/tenderTypes'
import { documentTotals, lineTotals } from '@/lib/documentMath'
import { round, toNum } from '@/lib/decimals'
import { revalidatePath } from 'next/cache'
import type { RowDataPacket } from 'mysql2/promise'

/**
 * Receipted returns at the till, and the exchange built on them.
 *
 * Its own file rather than more of sales/actions.ts, for two reasons: that
 * file is the hottest shared surface on the till, and these actions must gate
 * on the PIN OPERATOR — the person standing there — where the back-office
 * credit action deliberately reads the browser session.
 *
 * ── THE TILL NEVER STATES A PRICE ─────────────────────────────────────────
 *
 * `tillCreditNoteAction` takes line ids and QUANTITIES only. Everything with
 * money on it — the sold price, the original cost, the VAT rate — is re-read
 * from the invoice server-side, so a till cannot mis-state a price it never
 * sends. The original sold price is the whole point of a receipted return:
 * the customer gets back what they PAID, discounts included.
 *
 * ── ONLINE ONLY, BY DESIGN ────────────────────────────────────────────────
 *
 * The over-credit guard needs every credit note ever raised against the
 * invoice, which a till cannot know offline — the exact reason
 * posOffline/types.ts documents no-receipt-only offline returns.
 */

/**
 * The till guard and the PIN operator in one call, since every action here
 * needs both. The operator swap itself is `withTillOperator` in auth.ts —
 * shared, because this file, shiftActions and the sales actions each used to
 * hold their own copy and the sales one had drifted into attributing sales to
 * the browser user.
 */
async function operatorContext(): Promise<
  | { siteId: number; actor: { userId: number; userName: string }; capabilities: CapabilitySet }
  | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  return withTillOperator(ctx)
}

export type ReceiptLookup =
  | {
      ok: true
      invoice: {
        documentId: number
        documentNumber: string
        documentDate: string
        customerId: number | null
        customerName: string | null
        totalIncl: number
        tenders: { tenderTypeId: number; tenderName: string; amount: number }[]
        lines: {
          lineId: number
          description: string
          productCode: string | null
          qtySold: number
          alreadyCredited: number
          creditable: number
          unitPriceIncl: number
          vatRatePct: number
        }[]
      }
    }
  | { ok: false; error: string }

/** Finds a finalised invoice by the number on the customer's slip. */
export async function findReceiptAction(scan: string): Promise<ReceiptLookup> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  // Scanners may prepend an AIM symbology prefix like ]C1 — strip it.
  const number = scan.trim().toUpperCase().replace(/^\][A-Z]\d/, '')
  if (!number) return { ok: false, error: 'Type or scan the invoice number on the slip.' }

  const row = await siteQueryOne<RowDataPacket & { id: number; status: string; doc_type: string }>(
    siteId,
    `SELECT id, status, doc_type FROM sales_documents WHERE document_number = ? LIMIT 1`,
    [number],
  )
  if (!row) {
    return { ok: false, error: `No invoice ${number} on this site. Check the number on the slip.` }
  }
  if (String(row.doc_type) !== 'invoice') {
    return { ok: false, error: `${number} is not a sale — only an invoice can be credited.` }
  }
  if (String(row.status) === 'cancelled') {
    return { ok: false, error: 'That sale was voided — there is nothing left to credit.' }
  }
  if (String(row.status) !== 'finalised') {
    return { ok: false, error: `A ${row.status} document cannot be credited.` }
  }

  const [doc, lines] = await Promise.all([
    getDocument(siteId, Number(row.id)),
    creditableLines(siteId, Number(row.id)),
  ])
  if (!doc || !lines) return { ok: false, error: 'That invoice no longer exists.' }

  const paidWith = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT tender_type_id, tender_name, SUM(amount - change_given) AS amount
       FROM sales_tenders WHERE document_id = ? GROUP BY tender_type_id, tender_name`,
    [doc.id],
  )

  return {
    ok: true,
    invoice: {
      documentId: doc.id,
      documentNumber: doc.documentNumber ?? number,
      documentDate: doc.documentDate,
      customerId: doc.customerId,
      customerName: doc.customerName,
      totalIncl: doc.totalIncl,
      tenders: paidWith.map((t) => ({
        tenderTypeId: Number(t.tender_type_id),
        tenderName: String(t.tender_name),
        amount: toNum(t.amount),
      })),
      lines: lines
        .filter((l) => l.qty > 0)
        .map((l) => ({
          lineId: l.id,
          description: l.description,
          productCode: l.productCode,
          qtySold: Math.abs(l.qty),
          alreadyCredited: l.alreadyCredited,
          creditable: l.creditable,
          // What they PAID per unit, discounts included — the credit price.
          unitPriceIncl: round(l.lineTotalIncl / Math.abs(l.qty || 1), 2),
          vatRatePct: l.vatRatePct,
        })),
    },
  }
}

/* ── BROWSING FOR THE SLIP ──────────────────────────────────────────────────
 *
 * A cashier holding a slip types its number; a cashier holding a customer who
 * has lost theirs has nothing to type. `findReceiptAction` above answers the
 * first case and is useless for the second, which is most of them — the number
 * on a thermal slip fades, gets folded into a pocket, or was never kept.
 *
 * So the modal opens on a LIST instead: today's sales, newest first, with
 * yesterday and the last week one tap away. That is the whole search a till
 * needs — a return is nearly always same-day or same-week, and anything older
 * is a back-office job with the customer's account to search by.
 */

/** One row of the browse list. Enough to recognise a sale, and nothing more. */
export type ReceiptSummary = {
  documentId: number
  documentNumber: string
  /** yyyy-mm-dd — the accounting date on the document. */
  documentDate: string
  /** Wall-clock HH:MM the sale was posted, which is how a cashier finds it. */
  finalisedAt: string | null
  customerName: string | null
  totalIncl: number
  terminalCode: string | null
  userName: string
  /** True when a credit note already points at this invoice. */
  partlyCredited: boolean
}

/** How far back the list looks. Named windows rather than a date pair: a till
 *  has no room for a date picker and a return is a recent-sale act. */
export type ReceiptRange = 'today' | 'yesterday' | 'week'

const RECEIPT_RANGES: readonly ReceiptRange[] = ['today', 'yesterday', 'week']

/** Ceiling on one page of the list. A till scrolls with a thumb; past this the
 *  search box is the faster tool, and the list says so. */
const RECEIPT_LIMIT = 60

/**
 * The invoices a cashier can pick from, filtered by window and optionally by
 * what they typed.
 *
 * The search runs INSIDE the SQL rather than over the fetched page: filtering
 * a LIMIT-ed page would search today's first sixty sales rather than the day's
 * sales, and quietly find nothing on a busy shop. A search also widens the
 * window to the last 90 days by design — somebody typing a number is holding a
 * slip, and which day it was rung is exactly what they do not have to know.
 */
export async function recentReceiptsAction(input: {
  range: ReceiptRange
  search?: string
}): Promise<
  { ok: true; receipts: ReceiptSummary[]; truncated: boolean } | { ok: false; error: string }
> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const range: ReceiptRange = RECEIPT_RANGES.includes(input.range) ? input.range : 'today'
  // Scanners may prepend an AIM symbology prefix like ]C1 — strip it, same as
  // the single lookup does, so a scan into the search box behaves.
  const search = (input.search ?? '').trim().replace(/^\][A-Z]\d/i, '')

  /* Computed here rather than with CURDATE(), for the reason modules.ts states:
     the app's day and the database server's day are not guaranteed to be the
     same one, and the app's is the one the shop is trading in. */
  const now = new Date()
  const isoOf = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const daysAgo = (n: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() - n)
    return isoOf(d)
  }

  const where: string[] = [`d.doc_type = 'invoice'`, `d.status = 'finalised'`]
  const params: unknown[] = []

  if (search) {
    // A typed number beats the window — see the docblock.
    where.push('d.document_date >= ?')
    params.push(daysAgo(90))
    where.push('(d.document_number LIKE ? OR d.customer_name LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  } else if (range === 'today') {
    where.push('d.document_date = ?')
    params.push(isoOf(now))
  } else if (range === 'yesterday') {
    where.push('d.document_date = ?')
    params.push(daysAgo(1))
  } else {
    where.push('d.document_date >= ?')
    params.push(daysAgo(6))
  }

  const rows = await siteQuery<RowDataPacket & Record<string, unknown>>(
    siteId,
    `SELECT d.id, d.document_number, d.document_date, d.finalised_at, d.customer_name,
            d.total_incl, d.terminal_code, d.user_name,
            EXISTS (SELECT 1 FROM sales_documents c
                     WHERE c.reverses_id = d.id
                       AND c.doc_type = 'credit_sale'
                       AND c.status = 'finalised') AS credited
       FROM sales_documents d
      WHERE ${where.join(' AND ')}
      ORDER BY d.document_date DESC, d.finalised_at DESC, d.id DESC
      LIMIT ${RECEIPT_LIMIT + 1}`,
    params,
  )

  const page = rows.slice(0, RECEIPT_LIMIT)
  return {
    ok: true,
    truncated: rows.length > RECEIPT_LIMIT,
    receipts: page.map((r) => ({
      documentId: Number(r.id),
      documentNumber: String(r.document_number ?? ''),
      documentDate: String(r.document_date),
      /* getUTC*, not getHours: the pool reads DATETIME as UTC, so the wall
         clock the till stamped comes back only through the UTC getters. */
      finalisedAt: r.finalised_at ? wallClockTime(r.finalised_at) : null,
      customerName: r.customer_name ? String(r.customer_name) : null,
      totalIncl: toNum(r.total_incl),
      terminalCode: r.terminal_code ? String(r.terminal_code) : null,
      userName: String(r.user_name ?? ''),
      partlyCredited: Number(r.credited) === 1,
    })),
  }
}

/**
 * HH:MM as the till stamped it.
 *
 * The pool runs at timezone 'Z', so the driver's Date already holds the stored
 * wall-clock reading in its UTC fields — getUTC*, never getHours(). And a Date
 * instance only: re-parsing a String(value) is the "cleverer" path that has
 * produced NaN in this codebase before. Same reasoning, and the same shape, as
 * `wallClock()` in site/cashupBreakdown.ts.
 */
function wallClockTime(value: unknown): string | null {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return null
  const hh = String(value.getUTCHours()).padStart(2, '0')
  const mm = String(value.getUTCMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

/** Builds server-priced credit lines from the invoice, taking only qty from the client. */
async function creditLinesFrom(
  siteId: number,
  invoiceId: number,
  picks: { sourceLineId: number; qty: number }[],
): Promise<{ ok: true; lines: CreditLineInput[]; total: number } | { ok: false; error: string }> {
  const lines = await creditableLines(siteId, invoiceId)
  if (!lines) return { ok: false, error: 'That invoice no longer exists.' }

  const built: CreditLineInput[] = []
  let total = 0
  for (const pick of picks) {
    const original = lines.find((l) => l.id === pick.sourceLineId)
    if (!original) return { ok: false, error: 'One of those lines is not on that invoice.' }
    if (!(pick.qty > 0)) return { ok: false, error: 'A returned quantity must be more than nothing.' }
    if (pick.qty > original.creditable + 0.0005) {
      return {
        ok: false,
        error: `Only ${original.creditable} × ${original.description} can still be credited.`,
      }
    }
    // The EFFECTIVE unit price — what was paid after the line's discount.
    const unit = round(original.lineTotalIncl / Math.abs(original.qty || 1), 2)
    built.push({
      sourceLineId: original.id,
      productId: original.productId,
      productCode: original.productCode,
      description: original.description,
      productType: original.productType,
      departmentId: original.departmentId,
      qty: pick.qty,
      unitPriceIncl: unit,
      vatRatePct: original.vatRatePct,
      unitCostExcl: original.unitCostExcl,
    })
    total = round(total + round(pick.qty * unit, 2), 2)
  }
  if (built.length === 0) return { ok: false, error: 'Choose what is coming back.' }
  return { ok: true, lines: built, total }
}

export type TillCreditResult =
  | { ok: true; documentId: number; documentNumber: string; total: number }
  | { ok: false; error: string }

/** A receipted return: credit chosen lines at their ORIGINAL sold prices. */
export async function tillCreditNoteAction(
  input: {
    invoiceId: number
    reasonId: number
    note?: string | null
    lines: { sourceLineId: number; qty: number }[]
    refunds: { tenderTypeId: number; amount: number; reference?: string | null }[]
    terminalId?: number | null
    terminalCode?: string | null
  },
  overrideToken?: string,
): Promise<TillCreditResult> {
  const ctx = await operatorContext()
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  let allowed = can(ctx.capabilities, 'sales.credit_note')
  if (!allowed && overrideToken) {
    allowed = (await verifyOverrideToken(siteId, overrideToken, 'sales.credit_note')) !== null
  }
  if (!allowed) {
    return { ok: false, error: 'A return against a receipt needs a supervisor. Ask a manager to approve it.' }
  }

  const invoice = await getDocument(siteId, input.invoiceId)
  if (!invoice) return { ok: false, error: 'That invoice no longer exists.' }

  const built = await creditLinesFrom(siteId, input.invoiceId, input.lines)
  if (!built.ok) return built

  const result = await createCreditNote(siteId, actor, {
    invoiceId: input.invoiceId,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    reasonId: input.reasonId,
    note: input.note ?? null,
    reasonPrefix: 'Till return',
    lines: built.lines,
    refunds: input.refunds,
    terminalId: input.terminalId ?? null,
    terminalCode: input.terminalCode ?? null,
  })
  if (!result.ok) return result

  revalidatePath('/invoicing')
  revalidatePath('/products')
  return result
}

export type ExchangeResult =
  | {
      ok: true
      creditNote: { documentNumber: string; total: number }
      sale: { documentId: number; documentNumber: string; change: number }
      /** Credit left over after the new sale, refunded as cash. */
      cashBack: number
    }
  | {
      ok: false
      error: string
      /** Set when the credit note posted but the new sale then failed. */
      creditNotePosted?: { documentNumber: string; total: number }
    }

/**
 * An exchange: a receipted return and a replacement sale, netted.
 *
 * Two engines run SEQUENTIALLY, not in one transaction — each posts through
 * its full machinery (stock, ledger, GL, numbering), and the failure mode is
 * money-safe: if the sale fails after the credit note posted, the caller is
 * told the credit note stands and the cashier re-rings the sale paying with
 * the EXCHANGE tender by hand. Nothing is ever half-posted inside either.
 *
 * The EXCHANGE tender carries the netting: the credit note refunds INTO it,
 * the new sale is paid OUT of it, and per shift it sums to zero — the drawer
 * carries only the difference in real money.
 */
export async function tillExchangeAction(
  returnInput: {
    invoiceId: number
    reasonId: number
    note?: string | null
    lines: { sourceLineId: number; qty: number }[]
  },
  sale: {
    customerId?: number | null
    customerName?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
  /** The REAL tenders covering the balance when the new goods cost more. */
  tenders: { tenderTypeId: number; amount: number; reference?: string | null }[],
  overrideToken?: string,
): Promise<ExchangeResult> {
  const ctx = await operatorContext()
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  let allowed = can(ctx.capabilities, 'sales.credit_note')
  if (!allowed && overrideToken) {
    allowed = (await verifyOverrideToken(siteId, overrideToken, 'sales.credit_note')) !== null
  }
  if (!allowed) {
    return { ok: false, error: 'An exchange needs a supervisor. Ask a manager to approve it.' }
  }

  const exchange = await getTenderByCode(siteId, 'EXCHANGE')
  if (!exchange) {
    return { ok: false, error: 'The EXCHANGE tender is missing — run the site migrations.' }
  }
  if (sale.lines.length === 0) {
    return { ok: false, error: 'Ring up the replacement goods first.' }
  }

  const invoice = await getDocument(siteId, returnInput.invoiceId)
  if (!invoice) return { ok: false, error: 'That invoice no longer exists.' }

  const built = await creditLinesFrom(siteId, returnInput.invoiceId, returnInput.lines)
  if (!built.ok) return built
  const credit = built.total

  /* Price the replacement BEFORE posting anything, so the refund split is
     decided up front and a shortfall refuses while both documents are still
     unposted. Same arithmetic finaliseDocument re-runs. */
  const salePayable = documentTotals(
    sale.lines.map((l) => ({
      ...lineTotals({
        qty: l.qty,
        unitPriceIncl: l.unitPriceIncl,
        discountPct: l.discountPct,
        discountIncl: l.discountIncl,
        vatRatePct: l.vatRatePct,
      }),
      vatRatePct: l.vatRatePct,
    })),
  ).totalIncl

  const exchangeUsed = Math.min(credit, salePayable)
  const cashBack = round(credit - exchangeUsed, 2)
  const realTendered = round(tenders.reduce((sum, t) => sum + t.amount, 0), 2)
  if (round(exchangeUsed + realTendered, 2) < salePayable - 0.005) {
    return {
      ok: false,
      error: `The new goods come to ${salePayable.toFixed(2)} and the credit covers ${exchangeUsed.toFixed(2)} — still ${(salePayable - exchangeUsed - realTendered).toFixed(2)} to pay.`,
    }
  }

  /* Cash back needs a refundable tender for the excess. CASH is the counter's
     answer; a shop that deactivated cash refunds gets the refusal from
     createCreditNote's own allowsRefund check, worded for this screen. */
  const refunds: { tenderTypeId: number; amount: number; reference?: string | null }[] = [
    { tenderTypeId: exchange.id, amount: exchangeUsed },
  ]
  if (cashBack > 0) {
    const cash = await getTenderByCode(siteId, 'CASH')
    if (!cash) return { ok: false, error: 'No CASH tender to refund the difference with.' }
    refunds.push({ tenderTypeId: cash.id, amount: cashBack })
  }

  /* 1. The credit note. */
  const credited = await createCreditNote(siteId, actor, {
    invoiceId: returnInput.invoiceId,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    reasonId: returnInput.reasonId,
    note: returnInput.note ?? null,
    reasonPrefix: 'Exchange',
    lines: built.lines,
    refunds,
    terminalId: sale.terminalId ?? null,
    terminalCode: sale.terminalCode ?? null,
  })
  if (!credited.ok) return credited

  /* 2. The replacement sale, paid with the credit plus the real tenders. */
  const draft = await saveDraft(siteId, actor, {
    docType: 'invoice',
    customerId: sale.customerId ?? null,
    customerName: sale.customerName ?? invoice.customerName ?? 'Walk-in',
    terminalId: sale.terminalId ?? null,
    terminalCode: sale.terminalCode ?? null,
    priceStructureId: sale.priceStructureId ?? null,
    lines: sale.lines,
  })
  if (!draft.ok) {
    return {
      ok: false,
      error: `${draft.error} The credit note ${credited.documentNumber} is posted — the customer's credit is on it. Ring the new sale again and pay with Exchange credit.`,
      creditNotePosted: { documentNumber: credited.documentNumber, total: credited.total },
    }
  }

  // The terminal rides on the draft — FinaliseInput has no terminal field.
  const posted = await finaliseDocument(siteId, actor, {
    documentId: draft.id,
    customerId: sale.customerId ?? null,
    tenders: [
      ...(exchangeUsed > 0
        ? [{ tenderTypeId: exchange.id, amount: exchangeUsed, reference: credited.documentNumber }]
        : []),
      ...tenders,
    ],
  })
  if (!posted.ok) {
    return {
      ok: false,
      error: `${posted.error} The credit note ${credited.documentNumber} is posted — the customer's credit is on it. Ring the new sale again and pay with Exchange credit.`,
      creditNotePosted: { documentNumber: credited.documentNumber, total: credited.total },
    }
  }

  revalidatePath('/invoicing')
  revalidatePath('/products')
  return {
    ok: true,
    creditNote: { documentNumber: credited.documentNumber, total: credited.total },
    sale: { documentId: posted.documentId, documentNumber: posted.documentNumber, change: posted.change },
    cashBack,
  }
}
