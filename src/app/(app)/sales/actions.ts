'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, requireSiteUser, actorFor, actorForOrThrow } from '@/lib/auth'
import { can, capabilitiesForRole, type CapabilitySet } from '@/lib/site/permissions'
import { checkPricing } from '@/lib/site/priceGuard'
import { getTillSession } from '@/lib/tillSession'
import { getUser } from '@/lib/site/users'
import { createCreditNote, creditableLines, type CreditNoteInput } from '@/lib/site/salesReversal'
import {
  saveDraft,
  saveForLaterDocument,
  recallDocument,
  discardDocument,
  getDocument,
  type LineInput,
} from '@/lib/site/salesDocuments'
import { finaliseDocument, voidDocument, recordPrint } from '@/lib/site/salesPosting'
import { setOrderDetails } from '@/lib/site/salesOrders'
import { searchForTill, resolveScan, type TillProduct } from '@/lib/site/tillSearch'
import {
  searchCustomersForTill,
  getTillCustomer,
  type TillCustomer,
} from '@/lib/site/tillCustomers'

/**
 * Till actions.
 *
 * Everything that changes a sale goes through here, and everything returns its
 * outcome rather than redirecting: the capture screen is a client component
 * that keeps the basket in state, and a redirect mid-sale would lose it.
 */

export type SaleResult = { ok: true; documentId: number } | { ok: false; error: string }

export type FinaliseSaleResult =
  | { ok: true; documentId: number; documentNumber: string; change: number; roundingAdj: number }
  | { ok: false; error: string }

export async function searchProductsAction(
  term: string,
  priceStructureId: number | null,
): Promise<TillProduct[]> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return searchForTill(siteId, term, priceStructureId)
}

/** Resolves a scan, including weighed-goods barcodes. */
export async function scanAction(
  code: string,
  priceStructureId: number | null,
): Promise<TillProduct | null> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return resolveScan(siteId, code, priceStructureId)
}

export async function searchCustomersAction(term: string): Promise<TillCustomer[]> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return searchCustomersForTill(siteId, term)
}

/**
 * Re-reads a customer's credit position.
 *
 * Called when a customer is attached and again before tendering: a basket can
 * sit on screen for ten minutes while someone else settles the same account,
 * and the till should not offer credit that has since been used up.
 */
export async function refreshCustomerAction(customerId: number): Promise<TillCustomer | null> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  return getTillCustomer(siteId, customerId)
}

export async function saveSaleAction(
  documentId: number | null,
  input: {
    customerId?: number | null
    customerName?: string | null
    customerPhone?: string | null
    customerVatNo?: string | null
    reference?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
): Promise<SaleResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // Checked here, not only where the input was greyed out: this action is a
  // public endpoint and the price arrives from the client.
  const refused = await checkPricing(
    siteId,
    await operatorCapabilities(siteId, ctx.capabilities),
    input.priceStructureId ?? null,
    input.lines,
  )
  if (refused) return { ok: false, error: refused }

  const result = await saveDraft(
    siteId,
    actor,
    { docType: 'invoice', ...input, lines: attributeTo(input.lines, actor.userId) },
    documentId ?? undefined,
  )
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, documentId: result.id }
}

/**
 * Stamps every till line with whoever is at the till.
 *
 * Done on the SERVER from the PIN session rather than sent up by the browser:
 * this decides who gets paid commission, and a value the client supplies is a
 * value the client can choose. `requireActor` already resolves the till
 * operator ahead of the browser session, so `actor.userId` is the person
 * standing there rather than whoever opened the browser that morning.
 *
 * A line that already names someone keeps them — the back-office invoicing
 * screen sets it explicitly per line, and that is a deliberate answer this
 * must not overwrite.
 */
function attributeTo<T extends { salesRepUserId?: number | null }>(
  lines: T[],
  userId: number,
): T[] {
  return lines.map((line) => ({ ...line, salesRepUserId: line.salesRepUserId ?? userId }))
}

/**
 * The capabilities of whoever is actually at the till.
 *
 * NOT the browser session's. A manager signed into the back office who hands
 * the till to a junior must not leave their own price and discount rights
 * behind on the screen — the PIN decides, exactly as it does for attribution.
 * Falls back to the session when no till session exists, which is the
 * back-office case.
 */
async function operatorCapabilities(siteId: number, fallback: CapabilitySet) {
  const till = await getTillSession(siteId)
  if (!till) return fallback
  const operator = await getUser(siteId, till.userId)
  return operator ? capabilitiesForRole(siteId, operator.roleId) : fallback
}

/**
 * Turns the basket on screen into a sales order rather than a sale.
 *
 * Same lines, same prices, same customer — only the doc type differs, because
 * an order IS an invoice at an earlier moment in its life. It posts nothing:
 * no stock movement, no ledger entry, no number. What it does do is reserve
 * the stock, so the goods stop being available to the next person through the
 * door.
 *
 * A customer is required. An order is a promise to a specific someone, and a
 * walk-in who is not coming back cannot hold stock off the shelf.
 */
export async function saveAsOrderAction(
  documentId: number | null,
  input: {
    customerId?: number | null
    customerName?: string | null
    customerPhone?: string | null
    customerVatNo?: string | null
    reference?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
  details?: { deliveryDate?: string | null; customerOrderNo?: string | null },
): Promise<SaleResult> {
  const ctx = await actorFor('sales.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  if (!input.customerId) {
    return { ok: false, error: 'Attach a customer before saving an order — an order is a promise to someone.' }
  }
  if (input.lines.length === 0) {
    return { ok: false, error: 'Add at least one line before saving an order.' }
  }

  const result = await saveDraft(
    siteId,
    actor,
    { docType: 'sales_order', ...input, lines: attributeTo(input.lines, actor.userId) },
    documentId ?? undefined,
  )
  if (!result.ok) return { ok: false, error: result.error }

  const attached = await setOrderDetails(siteId, result.id, {
    deliveryDate: details?.deliveryDate ?? null,
    customerOrderNo: details?.customerOrderNo ?? null,
    reservesStock: true,
  })
  if (!attached.ok) return { ok: false, error: attached.error }

  revalidatePath('/sales/orders')
  return { ok: true, documentId: result.id }
}

/**
 * Sets a basket aside so the counter can serve someone else.
 *
 * Not `saveSaleAction` — that already means "persist the draft's lines", which
 * this calls first. Two different operations, two names.
 */
export async function saveForLaterAction(documentId: number): Promise<SaleResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await saveForLaterDocument(siteId, documentId)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales')
  return { ok: true, documentId: result.id }
}

export async function recallSaleAction(documentId: number): Promise<SaleResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await recallDocument(siteId, documentId)
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, documentId: result.id }
}

export async function discardSaleAction(
  documentId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await discardDocument(siteId, documentId)
  revalidatePath('/sales')
  return result
}

/**
 * Saves and posts in one call.
 *
 * Deliberately one round trip: the basket is saved and finalised together so
 * there is no window where a sale exists as a draft nobody meant to keep. If
 * the post is refused, the draft is left behind for the cashier to fix rather
 * than discarded — they have a customer standing there.
 */
export async function finaliseSaleAction(
  documentId: number | null,
  sale: {
    customerId?: number | null
    customerName?: string | null
    customerPhone?: string | null
    customerVatNo?: string | null
    reference?: string | null
    terminalId?: number | null
    terminalCode?: string | null
    priceStructureId?: number | null
    lines: LineInput[]
  },
  tenders: { tenderTypeId: number; amount: number; reference?: string | null }[],
  /** Loyalty reward codes the cashier applied. Priced and spent server-side. */
  voucherCodes: string[] = [],
): Promise<FinaliseSaleResult> {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // The one that takes money. Same check as the draft path, repeated rather
  // than assumed: a basket can be saved by one person and finalised by another.
  const refusedPrice = await checkPricing(
    siteId,
    await operatorCapabilities(siteId, ctx.capabilities),
    sale.priceStructureId ?? null,
    sale.lines,
  )
  if (refusedPrice) return { ok: false, error: refusedPrice }

  const saved = await saveDraft(
    siteId,
    actor,
    { docType: 'invoice', ...sale, lines: attributeTo(sale.lines, actor.userId) },
    documentId ?? undefined,
  )
  if (!saved.ok) return { ok: false, error: saved.error }

  const posted = await finaliseDocument(siteId, actor, {
    documentId: saved.id,
    tenders,
    customerId: sale.customerId ?? null,
    voucherCodes,
  })
  if (!posted.ok) return { ok: false, error: posted.error }

  revalidatePath('/sales')
  revalidatePath('/products')
  return posted
}

export async function voidSaleAction(
  documentId: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // The Void button on /sales/[id] is already hidden without this capability.
  // Hiding a button changes what is EASY, not what is possible — and voiding
  // reverses stock and a debtor's balance, so this is the check that counts.
  const ctx = await actorFor('sales.void')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await voidDocument(siteId, actor, documentId, reason)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/sales')
  revalidatePath(`/sales/${documentId}`)
  revalidatePath('/products')
  return { ok: true }
}

export async function recordPrintAction(documentId: number): Promise<void> {
  const ctx = await actorForOrThrow('sales.till')
  const { siteId } = ctx
  await recordPrint(siteId, documentId)
}

export type CreditNoteActionResult =
  | { ok: true; documentId: number; documentNumber: string; total: number }
  | { ok: false; error: string }

/**
 * Raises a credit note.
 *
 * Permission is re-checked here rather than trusted from the screen that
 * offered the button — a server action is a public endpoint, and the only place
 * a capability check counts is the one the client cannot skip.
 */
export async function createCreditNoteAction(
  input: CreditNoteInput,
): Promise<CreditNoteActionResult> {
  const { site, user, capabilities } = await requireSiteUser()

  if (!can(capabilities, 'sales.credit_note')) {
    return { ok: false, error: 'You do not have permission to credit a sale.' }
  }

  const result = await createCreditNote(site.id, { userId: user.id, userName: user.name }, input)
  if (!result.ok) return result

  revalidatePath('/sales')
  revalidatePath(`/sales/${input.invoiceId ?? ''}`)
  revalidatePath('/products')
  if (input.customerId) revalidatePath(`/customers/${input.customerId}`)

  return result
}

/**
 * Credits a whole sale in one step.
 *
 * The common case by a distance: the customer brings back everything they
 * bought. Making that a per-line form with a quantity box on every row is
 * ceremony — the answer is always "all of it".
 *
 * The lines are read on the SERVER from what is still creditable, never sent
 * up by the browser. A client that miscounted, or a second credit raised in
 * another tab between opening this screen and pressing the button, would
 * otherwise credit more than was sold. The partial screen still exists for
 * when only some of it comes back.
 */
export async function creditWholeSaleAction(
  invoiceId: number,
  reason: string,
  refunds?: { tenderTypeId: number; amount: number; reference?: string | null }[],
): Promise<CreditNoteActionResult> {
  const { site, user, capabilities } = await requireSiteUser()

  if (!can(capabilities, 'sales.credit_note')) {
    return { ok: false, error: 'You do not have permission to credit a sale.' }
  }
  if (!reason?.trim()) {
    return { ok: false, error: 'Give a reason for the credit.' }
  }

  const lines = await creditableLines(site.id, invoiceId)
  if (!lines) return { ok: false, error: 'That sale no longer exists.' }

  const outstanding = lines.filter((line) => line.creditable > 0)
  if (outstanding.length === 0) {
    return { ok: false, error: 'Every line on this sale has already been credited.' }
  }

  const result = await createCreditNote(site.id, { userId: user.id, userName: user.name }, {
    invoiceId,
    reason: reason.trim(),
    lines: outstanding.map((line) => ({
      sourceLineId: line.id,
      productId: line.productId,
      productCode: line.productCode,
      description: line.description,
      productType: line.productType,
      departmentId: line.departmentId,
      qty: line.creditable,
      unitPriceIncl: line.unitPriceIncl,
      vatRatePct: line.vatRatePct,
      // From the original line. Re-reading the product would credit at today's
      // cost and manufacture margin that was never earned.
      unitCostExcl: line.unitCostExcl,
    })),
    refunds,
  })
  if (!result.ok) return result

  revalidatePath('/sales')
  revalidatePath(`/sales/${invoiceId}`)
  revalidatePath('/products')

  return result
}

/** Reloads a saved sale's lines into the till. */
export async function loadSaleAction(documentId: number) {
  const ctx = await actorFor('sales.till')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  return getDocument(siteId, documentId)
}
