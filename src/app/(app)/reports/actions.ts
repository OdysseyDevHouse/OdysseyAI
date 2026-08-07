'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import { toggleFavorite } from '@/lib/site/reportFavorites'
import { deleteSavedReport } from '@/lib/site/savedReports'

/**
 * Hub actions.
 *
 * Each one re-checks its own capability. A server action is a public HTTP
 * endpoint — the fact that the button rendering it was hidden proves nothing
 * about who is calling.
 */

export type ActionResult = { ok: true } | { ok: false; error: string }

/** Deleting also cancels any schedule pointing at the report — the caller says so. */
export type DeleteResult = { ok: true; schedulesRemoved: number } | { ok: false; error: string }

export async function toggleFavoriteAction(reportId: string): Promise<ActionResult> {
  const { siteId, actor } = await requireCapability('reports.view')
  if (!reportId || reportId.length > 64) return { ok: false, error: 'Unknown report.' }

  try {
    await toggleFavorite(siteId, actor.userId, reportId)
    return { ok: true }
  } catch {
    return { ok: false, error: 'Could not save that favourite. Try again.' }
  }
}

export async function deleteSavedReportAction(id: number): Promise<DeleteResult> {
  // Deleting a report everyone can see is an edit to shared state, so it needs
  // the build permission rather than the view one.
  const { siteId } = await requireCapability('reports.build')
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'Unknown report.' }

  try {
    const schedulesRemoved = await deleteSavedReport(siteId, id)
    revalidatePath('/reports')
    revalidatePath('/reports/schedules')
    // The caller surfaces this: silently cancelling someone's scheduled email is
    // exactly the kind of side effect that erodes trust in the feature.
    return { ok: true, schedulesRemoved }
  } catch {
    return { ok: false, error: 'Could not delete that report. Try again.' }
  }
}
