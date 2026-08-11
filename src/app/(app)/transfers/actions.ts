'use server'

import { revalidatePath } from 'next/cache'
import { requireSiteId, requireActor, actorFor, actorForOrThrow } from '@/lib/auth'
import { postTransfer, voidTransfer, type TransferInput } from '@/lib/site/stockTransfers'
import {
  dispatchToStore,
  receiveFromStore,
  cancelDispatch,
  settleDispatch,
  findPeerReceipt,
  type DispatchInput,
  type ReceiveInput,
} from '@/lib/site/storeTransfers'
import { searchForTill } from '@/lib/site/tillSearch'
import { locationStockFor } from '@/lib/site/stockLocations'
import { availableSerials } from '@/lib/site/serials'

export type TransferActionResult =
  | { ok: true; id: number; documentNumber: string }
  | { ok: false; error: string }

/**
 * Posting moves stock, so every screen that reads a pile has to be
 * revalidated: the product pages show the breakdown, and the till reads the
 * main location.
 */
function revalidateStock() {
  revalidatePath('/transfers')
  revalidatePath('/products')
}

export async function postTransferAction(input: TransferInput): Promise<TransferActionResult> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await postTransfer(siteId, actor, input)
  if (!result.ok) return result

  revalidateStock()
  return result
}

export async function voidTransferAction(
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await voidTransfer(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateStock()
  return { ok: true }
}

/* ── Between stores ──────────────────────────────────────────────────────── */

export type DispatchActionResult =
  | { ok: true; id: number; documentNumber: string; warning?: string }
  | { ok: false; error: string }

/** Sends stock to another store: out of the room, onto the truck. */
export async function dispatchToStoreAction(input: DispatchInput): Promise<DispatchActionResult> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await dispatchToStore(siteId, actor, input)
  if (!result.ok) return result

  revalidateStock()
  return result
}

/**
 * Confirms what arrived from another store.
 *
 * Writes to TWO databases and can succeed here while failing there, so the
 * result may carry a warning alongside ok:true. The screen shows it — the stock
 * is genuinely on the shelf and the receipt must not read as a failure.
 */
export async function receiveFromStoreAction(input: ReceiveInput): Promise<DispatchActionResult> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await receiveFromStore(siteId, actor, input)
  if (!result.ok) return result

  revalidateStock()
  revalidatePath('/transfers/inbound')
  return result
}

/** Pulls a dispatch back before the other store has received it. */
export async function cancelDispatchAction(
  id: number,
  reason: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await cancelDispatch(siteId, actor, id, reason)
  if (!result.ok) return result

  revalidateStock()
  return { ok: true }
}

/**
 * Finishes a dispatch whose receiving half went through but whose sending half
 * did not — the one failure the two-database receive can leave behind.
 *
 * Reads the far end for what was actually received rather than trusting the
 * caller, and settleDispatch is idempotent, so pressing this twice is safe.
 */
export async function settleDispatchAction(
  id: number,
  peerSiteId: number,
): Promise<{ ok: true; settled: boolean } | { ok: false; error: string }> {
  const ctx = await actorFor('stock.transfer')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  // The receiver's copy of this dispatch, which is the only place the received
  // quantities actually live.
  const theirs = await findPeerReceipt(siteId, peerSiteId, id)
  if (!theirs) {
    return {
      ok: false,
      error:
        'That store has no record of receiving this dispatch, or its database could not be reached. Nothing has been changed.',
    }
  }

  const result = await settleDispatch(siteId, actor, {
    transferId: id,
    receiverSiteId: peerSiteId,
    receiverTransferId: theirs.id,
    receiverDocumentNumber: theirs.documentNumber ?? '',
    received: theirs.lines.map((l) => ({
      productCode: l.productCode,
      qty: l.qtyReceived ?? l.qty,
    })),
  })
  if (!result.ok) return result

  revalidateStock()
  return result
}

/** Product search for the transfer screen. */
export async function searchProductsForTransferAction(term: string) {
  const ctx = await actorForOrThrow('stock.view')
  const { siteId } = ctx
  return searchForTill(siteId, term, null)
}

/**
 * What a product holds in each location.
 *
 * The transfer screen needs the FROM pile specifically — moving 10 out of a
 * room holding 3 is refused at post, and showing the figure while the line is
 * being typed is what stops it being attempted.
 */
export async function locationStockAction(productId: number) {
  const ctx = await actorForOrThrow('stock.view')
  const { siteId } = ctx
  return locationStockFor(siteId, productId)
}

/**
 * The individual units sitting in one room, for a serialised line.
 *
 * A serial product cannot be transferred by quantity alone — postTransfer
 * refuses it — so the screen has to offer the actual units to pick from, and
 * only the ones in the room the stock is leaving.
 */
export async function serialsInLocationAction(productId: number, locationId: number) {
  const ctx = await actorForOrThrow('stock.view')
  const { siteId } = ctx
  const units = await availableSerials(siteId, productId, locationId)
  return units.map((s) => ({ id: s.id, serial: s.serial }))
}
