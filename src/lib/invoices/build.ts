import 'server-only'
import type { RowDataPacket } from 'mysql2/promise'
import { siteQueryOne } from '../siteDb'
import { getDocument } from '../site/salesDocuments'
import { getCustomer } from '../site/customers'
import type { InvoiceData } from './pdf'

/**
 * Assembling what an invoice PDF needs.
 *
 * Separated from pdf.ts so the renderer stays a pure function of its data —
 * which is what lets the layout be checked without a database, and what stops
 * "the PDF is wrong" ever being ambiguous between the figures and the drawing.
 * The same split statements/render.ts and statements/pdf.ts already use.
 *
 * ── THE FIGURES ARE READ, NEVER RECOMPUTED ───────────────────────────────
 *
 * Totals come off the stored document. A posted invoice reports the same
 * figures for ever, even if a VAT rate changes next year — so re-deriving them
 * at print time is how a reprinted invoice stops matching the one the customer
 * was sent, and the ledger it posted.
 */

type Row = RowDataPacket & Record<string, unknown>

export type IssuingSite = {
  displayName: string
  vatNumber: string | null
  registrationNumber: string | null
  address1: string | null
  address2: string | null
  address3: string | null
  postalCode: string | null
  phone: string | null
  email: string | null
}

export type BuildInvoiceOptions = {
  /** A pay-online URL to print, when one has been minted for this invoice. */
  paymentUrl?: string | null
  /** Free text under the totals — "Contract CON000012 · March 2027". */
  footNote?: string | null
  /** Overrides the wall clock, so a test can assert on a stable footer. */
  generatedAt?: Date
}

/**
 * Everything the invoice PDF needs, or null if the document is gone.
 *
 * Deliberately accepts any sales document rather than only a posted invoice:
 * the same renderer produces the proof-of-what-will-be-sent that a draft
 * contract invoice needs, and refusing drafts would mean a second near-identical
 * renderer for previews. The PDF says "DRAFT — not yet issued" when there is no
 * number, so the two can never be confused on paper.
 */
export async function buildInvoice(
  siteId: number,
  site: IssuingSite,
  documentId: number,
  opts: BuildInvoiceOptions = {},
): Promise<InvoiceData | null> {
  const document = await getDocument(siteId, documentId)
  if (!document) return null

  // The customer record is the better source for an address — the document
  // snapshot carries only a single free-text line, and an invoice wants the
  // account's real postal address. Falls back to the snapshot when the account
  // has since been deleted, so an old invoice still prints who it was for.
  const customer = document.customerId ? await getCustomer(siteId, document.customerId) : null

  const addressLines = customer
    ? [
        customer.contactName,
        customer.addressLine1,
        customer.addressLine2,
        [customer.city, customer.postalCode].filter(Boolean).join(' '),
      ]
        .map((l) => (l ?? '').trim())
        .filter(Boolean)
    : (document.customerAddress ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)

  return {
    site: {
      name: site.displayName,
      vatNumber: site.vatNumber,
      registrationNumber: site.registrationNumber,
      addressLines: [
        site.address1,
        site.address2,
        [site.address3, site.postalCode].filter(Boolean).join(' '),
      ]
        .map((l) => (l ?? '').trim())
        .filter(Boolean),
      phone: site.phone,
      email: site.email,
    },
    banking: await bankingDetails(siteId),
    customer: {
      code: customer?.code ?? document.customerCode,
      name: customer?.name ?? document.customerName ?? 'Cash sale',
      vatNumber: customer?.vatNumber ?? document.customerVatNo,
      phone: customer?.phone ?? document.customerPhone,
      addressLines,
    },
    documentNumber: document.documentNumber,
    documentDate: document.documentDate,
    dueDate: document.dueDate,
    reference: document.reference,
    notes: document.notes,
    lines: document.lines.map((line) => ({
      productCode: line.productCode,
      description: line.description,
      qty: line.qty,
      unitPriceIncl: line.unitPriceIncl,
      discountPct: line.discountPct,
      vatRatePct: line.vatRatePct,
      lineTotalIncl: line.lineTotalIncl,
    })),
    subtotalExcl: document.subtotalExcl,
    vatTotal: document.vatTotal,
    discountTotal: document.discountTotal,
    totalIncl: document.totalIncl,
    paymentUrl: opts.paymentUrl ?? null,
    footNote: opts.footNote ?? null,
    generatedAt: opts.generatedAt ?? new Date(),
  }
}

/**
 * Where the customer should pay.
 *
 * The account already nominated for RECEIPTS in the cashbook, rather than a new
 * pair of settings nobody would remember to fill in — the business maintains
 * this record to reconcile against, so it is the one that stays correct. The
 * `is_default_receipts` flag exists precisely to answer "where does money come
 * in", which is the question an invoice asks.
 *
 * Null when there is no such account or it has no number: an invoice with a
 * half-filled banking block is worse than one with none, because it looks like
 * enough information to pay against.
 */
async function bankingDetails(siteId: number): Promise<InvoiceData['banking']> {
  const row = await siteQueryOne<Row>(
    siteId,
    `SELECT name, bank_name, account_number, branch_code
       FROM bank_accounts
      WHERE account_type = 'bank' AND status = 'active'
      ORDER BY is_default_receipts DESC, sort_order, id
      LIMIT 1`,
  ).catch(() => null)

  if (!row) return null

  const accountNumber = (row.account_number as string | null)?.trim() || null
  if (!accountNumber) return null

  return {
    bank: (row.bank_name as string | null)?.trim() || null,
    accountName: (row.name as string | null)?.trim() || null,
    accountNumber,
    branchCode: (row.branch_code as string | null)?.trim() || null,
  }
}
