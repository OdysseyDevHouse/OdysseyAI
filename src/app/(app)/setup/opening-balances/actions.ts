'use server'

import { revalidatePath } from 'next/cache'
import { requireActor, requireSiteId } from '@/lib/auth'
import {
  planOpeningBalances,
  applyOpeningBalances,
  parseOpeningCsv,
  type OpeningSide,
  type OpeningPlan,
  type ImportResult,
} from '@/lib/site/openingBalances'

/**
 * Opening-balance import.
 *
 * Two steps on purpose: `previewAction` writes nothing and returns exactly what
 * would happen, and only `importAction` posts. Carrying in a book of debt is
 * the least reversible thing a new store does — every problem this file can
 * find is findable before a single row is written, so it is.
 */

export async function previewAction(
  side: OpeningSide,
  csv: string,
): Promise<{ ok: true; plan: OpeningPlan; skipped: number } | { ok: false; error: string }> {
  const siteId = await requireSiteId()

  const { rows, skipped } = parseOpeningCsv(csv)
  if (rows.length === 0) {
    return { ok: false, error: 'Nothing to import — check the file has an account code in each row.' }
  }

  const plan = await planOpeningBalances(siteId, side, rows)
  return { ok: true, plan, skipped }
}

export async function importAction(
  plan: OpeningPlan,
): Promise<{ ok: true; result: ImportResult } | { ok: false; error: string }> {
  const { siteId, actor } = await requireActor()

  if (plan.ready.length === 0) {
    return { ok: false, error: 'There is nothing ready to import.' }
  }

  // Re-planned server-side from the same rows rather than trusting the client's
  // copy: the browser has held this object across a review step, and an account
  // could have been closed or deleted in between.
  const rechecked = await planOpeningBalances(siteId, plan.side, plan.ready)
  if (rechecked.problems.length > 0) {
    return {
      ok: false,
      error: `${rechecked.problems.length} row${rechecked.problems.length === 1 ? '' : 's'} became invalid since the preview — ${rechecked.problems[0].reason} Preview again.`,
    }
  }

  const result = await applyOpeningBalances(siteId, actor, rechecked)

  revalidatePath('/customers')
  revalidatePath('/suppliers')
  revalidatePath('/customers/age-analysis')
  revalidatePath('/suppliers/age-analysis')

  return { ok: true, result }
}
