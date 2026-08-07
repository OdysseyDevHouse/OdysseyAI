'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { PREVIEW_ROWS, validateSpec, type CustomReportSpec, type ReportColumn } from '@/lib/reportBuilder/spec'
import { createSavedReport, updateSavedReport } from '@/lib/site/savedReports'

/**
 * Builder actions.
 *
 * The spec arriving here is NEVER trusted — it went to a browser and came back.
 * runBuilderSpec re-validates it against the catalog and re-applies the
 * caller's own capabilities on every call, so a hand-edited spec can only ever
 * express something the catalog already allows and the caller may already see.
 */

export type PreviewResult =
  | {
      ok: true
      columns: ReportColumn[]
      rows: Record<string, unknown>[]
      totals: Record<string, number>
      range: { from: string; to: string }
      hiddenColumns: string[]
    }
  | { ok: false; error: string }

export async function previewReportAction(spec: CustomReportSpec): Promise<PreviewResult> {
  const { siteId, capabilities } = await requireCapability('reports.build')
  const allow = (c: Capability) => can(capabilities, c)

  try {
    const result = await runBuilderSpec(siteId, spec, allow, { limit: PREVIEW_ROWS })
    return {
      ok: true,
      columns: result.columns,
      rows: result.rows,
      totals: result.totals,
      range: result.range,
      hiddenColumns: result.hiddenColumns,
    }
  } catch (e) {
    if (e instanceof ReportAccessError) {
      return { ok: false, error: 'You do not have access to this data.' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'This report could not be run.',
    }
  }
}

export type SaveResult = { ok: true; id: number } | { ok: false; error: string }

export async function saveReportAction({
  savedId,
  spec,
}: {
  savedId: number | null
  spec: CustomReportSpec
}): Promise<SaveResult> {
  const { siteId, actor, capabilities } = await requireCapability('reports.build')
  const allow = (c: Capability) => can(capabilities, c)

  const checked = validateSpec(spec)
  if (!checked.ok) return { ok: false, error: checked.error }

  // Saving is also a permission check: a spec reading data the caller cannot
  // see must not become a stored report that someone else's run would happily
  // execute against.
  if (!allow(checked.source.permission)) {
    return { ok: false, error: 'You do not have access to this data.' }
  }

  try {
    if (savedId) {
      await updateSavedReport(siteId, savedId, { name: checked.spec.name, spec: checked.spec })
      revalidatePath('/reports')
      revalidatePath(`/reports/saved:${savedId}`)
      return { ok: true, id: savedId }
    }

    const id = await createSavedReport(siteId, {
      kind: 'builder',
      name: checked.spec.name,
      spec: checked.spec,
      userId: actor.userId,
      userName: actor.userName,
    })
    revalidatePath('/reports')
    return { ok: true, id }
  } catch {
    return { ok: false, error: 'Could not save the report. Try again.' }
  }
}
