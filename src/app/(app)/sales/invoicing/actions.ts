'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId } from '@/lib/auth'
import {
  saveDraft,
  getDocument,
  createBlankInvoice,
  type LineInput,
} from '@/lib/site/salesDocuments'
import { finaliseDocument } from '@/lib/site/salesPosting'
import { listTenderTypes } from '@/lib/site/tenderTypes'
import {
  getTillCustomer,
  listCustomersForPicker,
  type TillCustomer,
} from '@/lib/site/tillCustomers'

/**
 * Invoicing actions.
 *
 * The back-office counterpart to the till's actions.ts: same engine underneath,
 * but the shape of the work is different. Here a document is captured, saved,
 * corrected and only then finalised — often across several sittings — rather
 * than rung up and tendered in one go.
 */

export type InvoiceResult = { ok: true; documentId: number } | { ok: false; error: string }

export type InvoiceLinePayload = {
  productId: number | null
  productCode: string | null
  description: string
  productType?: string
  departmentId: number | null
  salesRepId: number | null
  qty: number
  unitPriceIncl: number
  discountPct: number
  vatRatePct: number
  unitCostExcl: number
}

export type InvoicePayload = {
  documentId: number
  customerId: number | null
  customerName: string | null
  priceStructureId: number | null
  documentDate: string
  /** The customer's own order number, shown as "Invoice order number". */
  reference: string | null
  notes: string | null
  lines: InvoiceLinePayload[]
}

function toLineInputs(lines: InvoiceLinePayload[]): LineInput[] {
  return lines.map((line) => ({
    productId: line.productId,
    productCode: line.productCode,
    description: line.description,
    productType: (line.productType ?? 'normal') as LineInput['productType'],
    departmentId: line.departmentId,
    salesRepId: line.salesRepId,
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: line.discountPct,
    vatRatePct: line.vatRatePct,
    unitCostExcl: line.unitCostExcl,
  }))
}

/** The first page of the debtors book, for a picker that has just opened. */
export async function listCustomersAction(): Promise<TillCustomer[]> {
  const siteId = await requireSiteId()
  return listCustomersForPicker(siteId, 100)
}

/**
 * The customer's credit position, fetched when one is attached.
 *
 * The finalise dialog needs the live balance to decide whether the account
 * tender may be used, and the editor is only given an id and a name.
 */
export async function getInvoiceCustomerAction(customerId: number): Promise<TillCustomer | null> {
  const siteId = await requireSiteId()
  return getTillCustomer(siteId, customerId)
}

/**
 * Starts a blank invoice and hands back its id, so the editor has a document
 * to attach lines to. Nothing is posted and no number is issued.
 */
export async function newInvoiceAction(): Promise<InvoiceResult> {
  const { siteId, actor } = await requireActor()

  const result = await createBlankInvoice(siteId, actor)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/invoicing')
  return { ok: true, documentId: result.id }
}

/** Writes the document without posting it. Stock has not moved. */
export async function saveInvoiceAction(payload: InvoicePayload): Promise<InvoiceResult> {
  const { siteId, actor } = await requireActor()

  const result = await saveDraft(
    siteId,
    actor,
    {
      docType: 'invoice',
      documentDate: payload.documentDate,
      customerId: payload.customerId,
      customerName: payload.customerName,
      priceStructureId: payload.priceStructureId,
      reference: payload.reference,
      notes: payload.notes,
      lines: toLineInputs(payload.lines),
    },
    payload.documentId,
  )

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/sales/invoicing/${payload.documentId}`)
  revalidatePath('/sales/invoicing')
  revalidatePath('/sales')
  return { ok: true, documentId: result.id }
}

/** One payment, as the finalise dialog captured it. */
export type InvoiceTenderPayload = {
  tenderTypeId: number
  /** What the customer handed over — gross, not the amount owed. */
  amount: number
  reference?: string | null
}

export type FinaliseInvoiceResult =
  | { ok: true; documentId: number; documentNumber: string; change: number }
  | { ok: false; error: string }

/**
 * Saves, then posts the invoice.
 *
 * The invoice screen takes payment the same way the till does — cash, card,
 * account or any mix of them — because a back-office invoice is not always a
 * credit sale: plenty are settled on the spot by someone standing at the
 * counter. So the tenders come from the caller and go straight to the same
 * posting engine the till uses, which is what records them in sales_tenders,
 * moves the stock and posts the debtor ledger for whatever part went on account.
 *
 * Called with no tenders it keeps the old behaviour — the whole amount on the
 * account tender — so a pure credit invoice is still one click.
 */
export async function finaliseInvoiceAction(
  payload: InvoicePayload,
  tenders?: InvoiceTenderPayload[],
): Promise<FinaliseInvoiceResult> {
  const { siteId, actor } = await requireActor()

  const saved = await saveInvoiceAction(payload)
  if (!saved.ok) return saved

  const document = await getDocument(siteId, saved.documentId)
  if (!document) return { ok: false, error: 'That invoice no longer exists.' }

  // Resolved server-side rather than trusted from the screen: the amount posted
  // must come from the stored lines, not from a total the browser calculated.
  const taken = tenders?.length
    ? tenders
    : await accountTenderFor(siteId, document.customerId, document.totalIncl)

  if (!Array.isArray(taken)) return taken

  // Every tender that posts to a debtor needs an account behind it, and the
  // message should name the problem rather than let the engine say "attach a
  // customer first" about a screen with no obvious place to do that.
  if (!document.customerId) {
    const types = await listTenderTypes(siteId)
    const needsAccount = taken.some(
      (t) => types.find((x) => x.id === t.tenderTypeId)?.requiresCustomer,
    )
    if (needsAccount) {
      return {
        ok: false,
        error: 'Select a customer before finalising — this payment posts to their account.',
      }
    }
  }

  const result = await finaliseDocument(siteId, actor, {
    documentId: saved.documentId,
    customerId: document.customerId,
    tenders: taken,
  })

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/sales/invoicing/${saved.documentId}`)
  revalidatePath('/sales/invoicing')
  revalidatePath('/sales')
  revalidatePath('/products')
  return {
    ok: true,
    documentId: saved.documentId,
    documentNumber: result.documentNumber,
    change: result.change,
  }
}

/**
 * The whole amount on the account tender — the default when the caller took no
 * payment. Returns the error itself rather than throwing, so the caller can
 * hand it straight back to the screen.
 */
async function accountTenderFor(
  siteId: number,
  customerId: number | null,
  totalIncl: number,
): Promise<InvoiceTenderPayload[] | { ok: false; error: string }> {
  if (!customerId) {
    return {
      ok: false,
      error: 'Select an account customer before finalising — an invoice posts to their account.',
    }
  }

  const tenders = await listTenderTypes(siteId)
  const account = tenders.find((t) => t.postsToDebtor && t.isActive)
  if (!account) {
    return {
      ok: false,
      error: 'No account payment method is set up, so this invoice cannot post to the customer.',
    }
  }

  return [{ tenderTypeId: account.id, amount: totalIncl }]
}
