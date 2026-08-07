'use server'

import { revalidatePath } from 'next/cache'
import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { askForReport, AskNotConfiguredError } from '@/lib/site/askReport'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { PREVIEW_ROWS, type CustomReportSpec, type ReportColumn } from '@/lib/reportBuilder/spec'
import { createSavedReport } from '@/lib/site/savedReports'

/**
 * Generating a report from a question.
 *
 * The AI call is metered, so it is gated on its own capability
 * (`reports.ai`) rather than riding on `reports.build` — a shop may want
 * everyone building reports by hand and only supervisors spending on model
 * calls.
 */

export type AskResult =
  | {
      ok: true
      spec: CustomReportSpec
      reasoning: string
      columns: ReportColumn[]
      rows: Record<string, unknown>[]
      totals: Record<string, number>
      range: { from: string; to: string }
    }
  | { ok: false; error: string }

export async function askReportAction(question: string): Promise<AskResult> {
  const { siteId, capabilities } = await requireCapability('reports.ai')
  const allow = (c: Capability) => can(capabilities, c)

  try {
    // The model resolves relative periods against the STORE's today, passed in
    // rather than assumed — a model has no clock.
    const today = isoToday()
    const { spec, reasoning } = await askForReport(question, allow, today)

    // Run it immediately: a generated report nobody can see the numbers of is
    // just a promise. This is also the first check that the spec is runnable.
    const result = await runBuilderSpec(siteId, spec, allow, { limit: PREVIEW_ROWS })

    return {
      ok: true,
      spec,
      reasoning,
      columns: result.columns,
      rows: result.rows,
      totals: result.totals,
      range: result.range,
    }
  } catch (e) {
    if (e instanceof AskNotConfiguredError) return { ok: false, error: e.message }
    if (e instanceof ReportAccessError) {
      return { ok: false, error: 'That question needs data you do not have access to.' }
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Could not generate that report.',
    }
  }
}

export type SaveAskResult = { ok: true; id: number } | { ok: false; error: string }

export async function saveAskReportAction({
  spec,
  question,
}: {
  spec: CustomReportSpec
  question: string
}): Promise<SaveAskResult> {
  const { siteId, actor } = await requireCapability('reports.ai')

  try {
    const id = await createSavedReport(siteId, {
      kind: 'ask',
      name: spec.name,
      // The original question is the most useful description a generated report
      // could carry — it says what was actually asked, not what it was named.
      description: question.slice(0, 255),
      question,
      spec,
      userId: actor.userId,
      userName: actor.userName,
    })
    revalidatePath('/reports')
    return { ok: true, id }
  } catch {
    return { ok: false, error: 'Could not save that report. Try again.' }
  }
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
