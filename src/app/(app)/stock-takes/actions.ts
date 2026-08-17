'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule, actorForModuleOrThrow } from '@/lib/auth'
import {
  createStockTake,
  recountStockTake,
  saveCounts,
  freezeStockTake,
  postStockTake,
  cancelStockTake,
  deleteStockTake,
  type StockTakeInput,
  type CountEntry,
} from '@/lib/site/stockTakes'
import { searchForTill } from '@/lib/site/tillSearch'

/**
 * Posting a count moves stock, so every screen that reads a pile has to be
 * revalidated: the product pages show the breakdown, and the till reads main.
 */
function revalidateStock() {
  revalidatePath('/stock-takes')
  revalidatePath('/products')
}

export async function generateCycleCountsAction(): Promise<
  | { ok: true; generated: number; skipped: { name: string; reason: string }[] }
  | { ok: false; error: string }
> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { generateDueCycleCounts } = await import('@/lib/site/cycleCounts')
  const outcome = await generateDueCycleCounts(ctx.siteId, ctx.actor)
  revalidatePath('/stock-takes')
  return {
    ok: true,
    generated: outcome.generated.length,
    skipped: outcome.skipped.map((s) => ({ name: s.name, reason: s.reason })),
  }
}

export async function saveCycleProgrammeAction(
  id: number | null,
  input: import('@/lib/site/cycleCounts').SaveProgrammeInput,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { saveCycleProgramme } = await import('@/lib/site/cycleCounts')
  const result = await saveCycleProgramme(ctx.siteId, ctx.actor, id, input)
  if (result.ok) revalidatePath('/stock-takes')
  return result
}

export async function deleteCycleProgrammeAction(
  id: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { deleteCycleProgramme } = await import('@/lib/site/cycleCounts')
  await deleteCycleProgramme(ctx.siteId, ctx.actor, id)
  revalidatePath('/stock-takes')
  return { ok: true }
}

export async function createStockTakeAction(input: StockTakeInput) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await createStockTake(siteId, actor, input)
  if (result.ok) revalidatePath('/stock-takes')
  return result
}

/**
 * Saves a batch of counts.
 *
 * A batch rather than one line at a time because the grid autosaves as someone
 * works down a shelf, and a round trip per keystroke would make counting feel
 * like filling in a form.
 */
export async function saveCountsAction(takeId: number, entries: CountEntry[]) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  // Deliberately no revalidatePath: this fires constantly while someone counts,
  // and re-rendering the page under them would fight the inputs they are typing
  // into. The screen already holds the saved values in its own state.
  return saveCounts(siteId, actor, takeId, entries)
}

/**
 * Builds a fresh sheet from a posted one's variance lines.
 *
 * The second pass over a count is the one people skip when it means re-typing
 * forty product codes, and skipping it is how a bad count becomes the books.
 */
export async function recountStockTakeAction(takeId: number) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await recountStockTake(siteId, actor, takeId)
  if (result.ok) revalidatePath('/stock-takes')
  return result
}

export async function freezeStockTakeAction(takeId: number) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await freezeStockTake(siteId, actor, takeId)
  if (result.ok) revalidatePath(`/stock-takes/${takeId}`)
  return result
}

export async function postStockTakeAction(takeId: number) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await postStockTake(siteId, actor, takeId)
  if (result.ok) revalidateStock()
  return result
}

export async function cancelStockTakeAction(takeId: number, reason: string) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx
  const result = await cancelStockTake(siteId, actor, takeId, reason)
  if (result.ok) revalidateStock()
  return result
}

export async function deleteStockTakeAction(takeId: number) {
  const ctx = await actorForModule('inventory_advanced', 'stock.adjust')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx
  const result = await deleteStockTake(siteId, takeId)
  if (result.ok) revalidatePath('/stock-takes')
  return result
}

/** Product search, for adding a line to a manual sheet. */
export async function searchProductsForCountAction(term: string) {
  const ctx = await actorForModuleOrThrow('inventory_advanced', 'stock.view')
  return searchForTill(ctx.siteId, term, null)
}
