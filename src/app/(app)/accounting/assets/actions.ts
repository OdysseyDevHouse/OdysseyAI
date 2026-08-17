'use server'

import { revalidatePath } from 'next/cache'
import { actorForModule } from '@/lib/auth'
import {
  createAsset,
  updateAsset,
  disposeAsset,
  createFromExpense,
  type AssetInput,
} from '@/lib/site/fixedAssets'
import {
  proposeRun,
  postRun,
  cancelRun,
  excludeItem,
} from '@/lib/site/depreciationRuns'

/**
 * Fixed asset actions.
 *
 * Behind setup.edit rather than a general edit right: an asset's cost and life
 * decide what the profit and loss says every month for years, so getting one
 * wrong is quietly expensive.
 */

export type ActionResult = { ok: true; message: string } | { ok: false; error: string }

function revalidateAssets(id?: number): void {
  revalidatePath('/accounting/assets')
  if (id) revalidatePath(`/accounting/assets/${id}`)
}

export async function saveAssetAction(
  input: AssetInput,
  existingId?: number,
): Promise<ActionResult & { id?: number }> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = existingId
    ? await updateAsset(siteId, actor, existingId, input)
    : await createAsset(siteId, actor, input)
  if (!result.ok) return result

  revalidateAssets(result.id)
  return {
    ok: true,
    id: result.id,
    message: existingId ? 'Asset saved.' : `Added as ${result.assetCode}.`,
  }
}

export async function disposeAssetAction(
  id: number,
  input: { disposedOn: string; proceeds: number; reason: string; bankAccountId?: number | null },
): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await disposeAsset(siteId, actor, id, input)
  if (!result.ok) return result

  revalidateAssets(id)
  revalidatePath('/accounting/trial-balance')

  const outcome = result.result >= 0 ? 'profit' : 'loss'
  return {
    ok: true,
    message: `Disposed. Book value was ${result.bookValue.toFixed(2)}, a ${outcome} of ${Math.abs(result.result).toFixed(2)}.`,
  }
}

export async function createFromExpenseAction(
  expenseId: number,
  overrides: {
    lineId: number
    name: string
    categoryId: number
    lifeMonths?: number
    residualValue?: number
    serialNumber?: string | null
  }[],
): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await createFromExpense(siteId, actor, expenseId, overrides)
  if (!result.ok) return result

  revalidateAssets()
  revalidatePath(`/expenses/${expenseId}`)

  return {
    ok: true,
    message: `${result.created.length} asset${result.created.length === 1 ? '' : 's'} added to the register.`,
  }
}

/* ── Depreciation ────────────────────────────────────────────────────────── */

export async function proposeDepreciationAction(
  periodMonth: string,
): Promise<ActionResult & { runId?: number }> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await proposeRun(siteId, actor, periodMonth)
  if (!result.ok) return result

  revalidatePath('/accounting/assets/depreciation')
  return {
    ok: true,
    runId: result.runId,
    message: `${result.charged} asset${result.charged === 1 ? '' : 's'} would depreciate ${result.total.toFixed(2)}. Nothing has been posted yet.`,
  }
}

export async function postDepreciationAction(runId: number): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await postRun(siteId, actor, runId)
  if (!result.ok) return result

  revalidatePath('/accounting/assets/depreciation')
  revalidateAssets()
  revalidatePath('/accounting/trial-balance')
  revalidatePath('/accounting/income-statement')

  return {
    ok: true,
    message: `Charged ${result.posted} asset${result.posted === 1 ? '' : 's'}, ${result.total.toFixed(2)} total.`,
  }
}

export async function cancelDepreciationAction(runId: number): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await cancelRun(siteId, actor, runId)
  if (!result.ok) return result

  revalidatePath('/accounting/assets/depreciation')
  return { ok: true, message: 'Draft discarded.' }
}

export async function excludeDepreciationItemAction(
  itemId: number,
  reason: string,
): Promise<ActionResult> {
  const ctx = await actorForModule('accounting', 'setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId, actor } = ctx

  const result = await excludeItem(siteId, actor, itemId, reason)
  if (!result.ok) return result

  revalidatePath('/accounting/assets/depreciation')
  return { ok: true, message: 'Asset excluded from this run.' }
}
