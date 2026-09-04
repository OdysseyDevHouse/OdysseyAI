'use server'

import { revalidatePath } from 'next/cache'
import { actorFor } from '@/lib/auth'
import {
  createScaleRule,
  updateScaleRule,
  deleteScaleRule,
  type ScaleRuleInput,
} from '@/lib/site/scaleBarcodes'

export type ScaleActionResult = { ok: true; message: string } | { ok: false; error: string }

/**
 * Adding or changing a scale barcode shape.
 *
 * `setup.edit` rather than a stock capability: this decides how the till reads
 * the MONEY out of a weighed label, so a wrong prefix or a wrong decimal count
 * misprices every scale item in the shop silently. That is a setup decision,
 * beside numbering and tender types, not something a stock clerk does.
 */
export async function saveScaleRuleAction(
  id: number | null,
  input: ScaleRuleInput,
): Promise<ScaleActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx
  const { siteId } = ctx

  const result = id
    ? await updateScaleRule(siteId, id, input)
    : await createScaleRule(siteId, input)

  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/scale-barcodes')
  return { ok: true, message: id ? 'Barcode setup updated.' : 'Barcode setup added.' }
}

export async function deleteScaleRuleAction(id: number): Promise<ScaleActionResult> {
  const ctx = await actorFor('setup.edit')
  if ('ok' in ctx) return ctx

  const result = await deleteScaleRule(ctx.siteId, id)
  if (!result.ok) return { ok: false, error: result.error }

  revalidatePath('/setup/scale-barcodes')
  return { ok: true, message: 'Barcode setup removed.' }
}
