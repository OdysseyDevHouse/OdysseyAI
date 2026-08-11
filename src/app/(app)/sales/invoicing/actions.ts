'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import { checkPricing } from '@/lib/site/priceGuard'
import {
  saveDraft,
  getDocument,
  createBlankInvoice,
  type LineInput,
} from '@/lib/site/salesDocuments'
import { finaliseDocument } from '@/lib/site/salesPosting'
import { terminalForDevice } from '@/lib/site/terminals'
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
  salesRepUserId: number | null
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
  /**
   * Which MACHINE is capturing, not which till.
   *
   * The screen never picks a till and cannot name one: it sends the browser's
   * own device id and the server turns that into a terminal. That is the whole
   * point of sending the device rather than a terminalId — a posted invoice
   * says which register it was captured on, and nothing a client can send
   * decides that. Null on a browser that has never been claimed to a till,
   * which is the ordinary state of a back-office PC and not an error.
   */
  deviceId: string | null
  lines: InvoiceLinePayload[]
}

function toLineInputs(lines: InvoiceLinePayload[]): LineInput[] {
  return lines.map((line) => ({
    productId: line.productId,
    productCode: line.productCode,
    description: line.description,
    productType: (line.productType ?? 'normal') as LineInput['productType'],
    departmentId: line.departmentId,
    salesRepUserId: line.salesRepUserId,
    qty: line.qty,
    unitPriceIncl: line.unitPriceIncl,
    discountPct: line.discountPct,
    vatRatePct: line.vatRatePct,
    unitCostExcl: line.unitCostExcl,
  }))
}

/** The first page of the debtors book, for a picker that has just opened. */
export async function listCustomersAction(): Promise<TillCustomer[]> {
  const ctx = await actorForOrThrow('sales.edit')
  const { siteId } = ctx
  return listCustomersForPicker(siteId, 100)
}

/**
 * The customer's credit position, fetched when one is attached.
 *
 * The finalise dialog needs the live balance to decide whether the account
 * tender may be used, and the editor is only given an id and a name.
 */
export async function getInvoiceCustomerAction(customerId: number): Promise<TillCustomer | null> {
  const ctx = await actorForOrThrow('sales.edit')
  const { siteId } = ctx
  return getTillCustomer(siteId, customerId)
}

/**
 * Starts a blank invoice and hands back its id, so the editor has a document
 * to attach lines to. Nothing is posted and no number is issued.
 */
export async function newInvoiceAction(): Promise<InvoiceResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await createBlankInvoice(siteId, actor)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales/invoicing')
  return { ok: true, documentId: result.id }
}

/** Writes the document without posting it. Stock has not moved. */
export async function saveInvoiceAction(payload: InvoicePayload): Promise<InvoiceResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // `finaliseInvoiceAction` routes through here, so both paths are covered by
  // the one check. The editor also disables the cells, but that is a courtesy
  // to the user rather than the thing that stops a crafted request.
  const refused = await checkPricing(
    siteId,
    ctx.capabilities,
    payload.priceStructureId ?? null,
    payload.lines,
  )
  if (refused) return { ok: false, error: refused }

  /*
   * Which till this invoice was captured on, resolved from the machine.
   *
   * Nobody is asked. The device id the browser sent is matched against the
   * terminal claimed to it — the same lookup the till and the clock-in screen
   * use — so an invoice captured at a register is attributed to that register
   * and the operator who is signed in, without a picker to get wrong.
   *
   * Re-resolved on every save rather than pinned when the draft was started, so
   * an invoice begun on one machine and finished on another names the one that
   * actually finished it. Finalising saves first, so this is the machine that
   * posted it.
   *
   * An unclaimed back-office PC resolves to null and the invoice carries no
   * till, exactly as before. It stays 'back_office' either way, which is what
   * keeps it on the shared number run — see migration 099.
   */
  const terminal = payload.deviceId ? await terminalForDevice(siteId, payload.deviceId) : null

  const result = await saveDraft(
    siteId,
    actor,
    {
      docType: 'invoice',
      documentDate: payload.documentDate,
      customerId: payload.customerId,
      customerName: payload.customerName,
      priceStructureId: payload.priceStructureId,
      terminalId: terminal?.id ?? null,
      terminalCode: terminal?.code ?? null,
      origin: 'back_office',
      reference: payload.reference,
      notes: payload.notes,
      lines: toLineInputs(payload.lines),
    },
    payload.documentId,
  )

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath(`/sales/invoicing/${payload.documentId}`)
  revalidatePath('/sales/invoicing')
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
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

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
  /* Finalising moves the invoice from the editor to the record screen, so that
     is the URL the user lands on next — it must not serve a cached draft. */
  revalidatePath(`/sales/${saved.documentId}`)
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
