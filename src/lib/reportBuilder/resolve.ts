import 'server-only'
import { getSavedReport } from '../site/savedReports'
import { getTemplate, templateSpec } from './templates'
import type { CustomReportSpec } from './spec'
import type { Capability } from '../site/permissions'

/**
 * Turning a report ID into something runnable.
 *
 * ONE id space covers both kinds of report: a built-in is its template key
 * ('sales-by-product'), a saved one is 'saved:12'. Every consumer — the viewer,
 * favourites, schedules, exports — takes that single string and gets back a
 * spec, so none of them needs to know the difference. Adding a third kind later
 * is a case in this function, not a change to five call sites.
 */

export type ResolvedReport = {
  id: string
  name: string
  description: string
  spec: CustomReportSpec
  /** Built-ins cannot be edited in place; a saved report can. */
  savedId: number | null
  kind: 'builtin' | 'builder' | 'ask'
  /** The question behind an AI-generated report, for the follow-up box. */
  question: string
  /** Capability that gates the report as a whole. */
  permission: Capability | null
}

export async function resolveReport(
  siteId: number,
  id: string,
): Promise<ResolvedReport | null> {
  if (id.startsWith('saved:')) {
    const savedId = Number(id.slice(6))
    if (!Number.isInteger(savedId) || savedId <= 0) return null
    const saved = await getSavedReport(siteId, savedId)
    // A spec that no longer validates is a real state, not an error: the
    // catalog may have lost a field since it was saved. The caller shows a
    // repair prompt rather than a crash.
    if (!saved || !saved.spec) return null
    return {
      id,
      name: saved.name,
      description: saved.description,
      spec: saved.spec,
      savedId,
      kind: saved.kind,
      question: saved.question,
      permission: null,
    }
  }

  const template = getTemplate(id)
  if (!template) return null
  return {
    id,
    name: template.name,
    description: template.description,
    spec: templateSpec(template),
    savedId: null,
    kind: 'builtin',
    question: '',
    permission: template.permission,
  }
}
