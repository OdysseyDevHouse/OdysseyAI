'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId, actorFor, actorForOrThrow } from '@/lib/auth'
import {
  saveOrder,
  issueOrder,
  cancelOrder,
  getPurchaseDocument,
  type OrderInput,
} from '@/lib/site/purchaseDocuments'
import { receiveGoods, voidReceipt, type ReceiveInput } from '@/lib/site/purchasePosting'
import { createSupplierReturn, type SupplierReturnInput } from '@/lib/site/purchaseReversal'
import { availableSerials } from '@/lib/site/serials'
import { searchForTill } from '@/lib/site/tillSearch'
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
