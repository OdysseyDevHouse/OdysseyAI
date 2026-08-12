'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  saveOrder,
  issueOrder,
  cancelOrder,
  getPurchaseDocument,
  productPositions,
  type OrderInput,
} from '@/lib/site/purchaseDocuments'
import {
  receiveGoods,
  voidReceipt,
  saveDraftReceipt,
  deleteDraftReceipt,
  type ReceiveInput,
} from '@/lib/site/purchasePosting'
import { createSupplierReturn, type SupplierReturnInput } from '@/lib/site/purchaseReversal'
import {
  reorderBySupplier,
  type ReorderBasis,
  type SupplierGroup,
} from '@/lib/site/reorderSuggestions'
import { listVatRates, defaultVat } from '@/lib/site/lookups'
import { availableSerials } from '@/lib/site/serials'
import { searchForTill, browseForTill } from '@/lib/site/tillSearch'
import { listDepartments, flattenTree } from '@/lib/site/departments'
import { pricesFor } from '@/lib/site/supplierPrices'
import { listSuppliers } from '@/lib/site/suppliers'

export type PurchaseResult = { ok: true; id: number; message: string } | { ok: false; error: string }

export async function saveOrderAction(
  documentId: number | null,
  input: OrderInput,
): Promise<PurchaseResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await saveOrder(siteId, actor, input, documentId ?? undefined)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  return { ok: true, id: result.id, message: 'Order saved.' }
}

export async function issueOrderAction(id: number): Promise<PurchaseResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await issueOrder(siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  revalidatePath(`/purchasing/${id}`)
  return { ok: true, id, message: 'Order issued to the supplier.' }
}

export async function cancelOrderAction(id: number, reason: string): Promise<PurchaseResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await cancelOrder(siteId, id, reason)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  return { ok: true, id, message: 'Order cancelled.' }
}

export type ReceiveActionResult =
  | { ok: true; documentId: number; documentNumber: string; totalExcl: number }
  | { ok: false; error: string }

/**
 * Receives goods.
 *
 * The one action in the app that moves average_cost — everything else reads it.
 */
export async function receiveGoodsAction(input: ReceiveInput): Promise<ReceiveActionResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await receiveGoods(siteId, actor, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  revalidatePath('/products')
  revalidatePath(`/suppliers/${input.supplierId}`)
  return result
}

/**
 * Saves a delivery part-keyed, without posting anything.
 *
 * Separate from receiveGoodsAction on purpose: a posting path with a "do not
 * post" branch is one bad condition away from moving stock for a document
 * nobody finished.
 */
export async function saveDraftReceiptAction(
  documentId: number | null,
  input: ReceiveInput,
): Promise<PurchaseResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await saveDraftReceipt(siteId, actor, input, documentId ?? undefined)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  return { ok: true, id: result.id, message: 'Saved. Nothing has been posted yet.' }
}

export async function deleteDraftReceiptAction(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await deleteDraftReceipt(siteId, id)
  if (!result.ok) return result

  revalidatePath('/purchasing')
  return { ok: true }
}

export async function voidReceiptAction(
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await voidReceipt(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidatePath('/purchasing')
  revalidatePath('/products')
  return { ok: true }
}

/** Product search for the order and receiving screens. */
export async function searchProductsForPurchaseAction(term: string) {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  return searchForTill(siteId, term, null)
}

/**
 * Products for the "Add stock" picker — browse, not type-ahead.
 *
 * Distinct from searchProductsForPurchaseAction, which answers keystrokes in a
 * Combobox and needs two characters before it says anything. This one answers
 * "show me what is in Groceries" with no term at all, which is how a receiver
 * works through a delivery note of things they cannot spell.
 *
 * Guarded by purchasing.view rather than reusing the sales action: the same
 * question asked from a different screen is a different boundary, and a buyer
 * who cannot sell should still be able to receive.
 */
export async function browseProductsForPurchaseAction(options: {
  term?: string
  departmentId?: number | null
  limit?: number
}) {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  return browseForTill(siteId, { ...options, priceStructureId: null })
}

/** The department list for that picker's filter, flattened for a <select>. */
export async function purchaseDepartmentsAction(): Promise<
  { id: number; name: string; depth: number }[]
> {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  const all = await listDepartments(siteId)
  return flattenTree(all).map(({ department, depth }) => ({
    id: department.id,
    name: department.name,
    depth,
  }))
}

/**
 * What this supplier has agreed to charge for these products, today.
 *
 * Used when a product is added to an order, and when the supplier on an order
 * is changed: the same product from two suppliers is two different prices, and
 * an order that kept the first one would go out wrong.
 */
export async function agreedPricesAction(supplierId: number, productIds: number[]) {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  if (!supplierId || productIds.length === 0) return []

  const prices = await pricesFor(siteId, supplierId, productIds)
  return [...prices.values()].map((p) => ({
    productId: p.productId,
    costExcl: p.costExcl,
    packSize: p.packSize,
    effectiveFrom: p.effectiveFrom,
    listReference: p.listReference,
  }))
}

export async function listActiveSuppliersAction() {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  const { items } = await listSuppliers(siteId, { statuses: ['active'], limit: 200 })
  return items.map((s) => ({ id: s.id, code: s.code, name: s.name, terms: s.paymentTermsDays }))
}

export async function loadOrderAction(id: number) {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  return getPurchaseDocument(siteId, id)
}

/**
 * Where these products stand right now — stock, cost and shelf price.
 *
 * The line grid previews what a delivery does to average cost and margin, and
 * that needs the position BEFORE the receipt. A line pulled off a purchase
 * order carries none of it: the order snapshotted a cost when it was raised,
 * which may be weeks old, and never knew the stock figure at all.
 *
 * One query for the whole order rather than one per line — a fifty-line
 * delivery would otherwise open fifty round trips as the screen loads.
 */
export async function productPositionsAction(productIds: number[]) {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx

  const ids = [...new Set(productIds.filter((id) => Number.isInteger(id) && id > 0))]
  if (ids.length === 0) return []

  return productPositions(siteId, ids)
}

/* ── Suggested ordering ──────────────────────────────────────────────────── */

export type SuggestResult =
  | { ok: true; groups: SupplierGroup[] }
  | { ok: false; error: string }

/**
 * What to order. Reads only — nothing is written until a draft is raised.
 */
export async function suggestOrdersAction(input: {
  locationId: number
  basis: ReorderBasis
  supplierId?: number
  windowDays?: number
  coverDays?: number
}): Promise<SuggestResult> {
  const ctx = await actorFor('purchasing.view')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  if (!Number.isInteger(input.locationId) || input.locationId <= 0) {
    return { ok: false, error: 'Choose a location.' }
  }

  const groups = await reorderBySupplier(siteId, {
    locationId: input.locationId,
    basis: input.basis,
    supplierId: input.supplierId,
    windowDays: input.windowDays,
    coverDays: input.coverDays,
  })
  return { ok: true, groups }
}

/**
 * Turns a reviewed suggestion into a draft order.
 *
 * A DRAFT, deliberately, and never an issued one: the buyer has corrected
 * quantities on a screen, not checked an order against a supplier's price list.
 * Landing on the edit screen is the last look before it goes out.
 */
export async function createOrdersFromSuggestionAction(input: {
  supplierId: number
  /**
   * The location the suggestion was computed FOR, stamped onto every line.
   *
   * A suggestion answers "what is the warehouse short of", so an order raised
   * from it is an order for the warehouse — leaving the destination blank would
   * throw away the one thing the screen already knew. Still a default: the buyer
   * lands on the edit screen and can move any line.
   */
  locationId?: number | null
  lines: {
    productId: number
    productCode: string | null
    supplierCode: string | null
    description: string
    productType: string
    qtyOrdered: number
    unitCostExcl: number
  }[]
}): Promise<PurchaseResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const lines = input.lines.filter((l) => l.qtyOrdered > 0)
  if (lines.length === 0) return { ok: false, error: 'Every quantity is zero.' }

  // Purchase VAT, resolved here rather than trusted from the client: the rate a
  // document is taxed at is not the browser's to decide.
  const vatRates = await listVatRates(siteId)
  const purchaseVat = defaultVat(vatRates, 'purchase') ?? defaultVat(vatRates, 'sales')

  const result = await saveOrder(siteId, actor, {
    supplierId: input.supplierId,
    lines: lines.map((l) => ({
      productId: l.productId,
      productCode: l.productCode,
      supplierCode: l.supplierCode,
      description: l.description,
      productType: l.productType,
      locationId: input.locationId ?? null,
      qtyOrdered: l.qtyOrdered,
      unitCostExcl: l.unitCostExcl,
      vatRatePct: purchaseVat?.rate ?? 0,
    })),
  })
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  return { ok: true, id: result.id, message: 'Draft order raised.' }
}

/* ── Supplier returns ────────────────────────────────────────────────────── */

export type SupplierReturnActionResult =
  | { ok: true; documentId: number; documentNumber: string }
  | { ok: false; error: string }

export async function createSupplierReturnAction(
  input: SupplierReturnInput,
): Promise<SupplierReturnActionResult> {
  const ctx = await actorFor('purchasing.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await createSupplierReturn(siteId, actor, input)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/purchasing')
  revalidatePath('/products')
  revalidatePath(`/purchasing/${input.grvId}`)
  return { ok: true, documentId: result.documentId, documentNumber: result.documentNumber }
}

/**
 * The units the return screen may offer for a serial line.
 *
 * Scoped to the location the GRV line went into, so a return cannot send back a
 * unit standing in another room — the stock movement leaves that same pile, and
 * the two must agree.
 */
export async function serialsForReturnAction(productId: number, locationId: number | null) {
  const ctx = await actorForOrThrow('purchasing.view')
  const { siteId } = ctx
  const items = await availableSerials(siteId, productId, locationId)
  return items.map((s) => ({
    id: s.id,
    serial: s.serial,
    costExcl: s.costExcl,
    warrantyUntil: s.warrantyUntil,
    locationCode: s.locationCode,
  }))
}
