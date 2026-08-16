import 'server-only'
import { getSavedReport } from '../site/savedReports'
import {
  getTemplate,
  getLegacyVariant,
  resolveVariant,
  templateSpec,
  type ReportVariant,
} from './templates'
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
  /**
   * The cuts this report offers, and which one is showing. Empty for a report
   * with only one way of being read, which is nearly all of them.
   */
  variants: readonly ReportVariant[]
  variantKey: string | null
  /**
   * Where this report's STORED preferences live — columns and banding.
   *
   * Normally the report's own id. For a cut it is the id that cut replaced, so
   * consolidating the catalogue does not throw away the column choices a shop
   * already made on "Sales by product". Each cut has its own columns, which is
   * right: they do not even share a source.
   */
  prefsId: string
}

export async function resolveReport(
  siteId: number,
  id: string,
  /** Which cut to show, for a report that offers them. */
  variantKey?: string | null,
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
      variants: [],
      variantKey: null,
      prefsId: id,
    }
  }

  /*
   * A retired id — 'sales-by-product' and its five siblings.
   *
   * Resolved to the cut that replaced it, keeping its OWN id throughout: a
   * favourite, a schedule or an API caller naming it gets exactly the report it
   * always got, under the name it always had. It is not redirected to the
   * consolidated report, because a 06:00 email that silently changed which
   * figures it carried would be worse than one that kept working.
   */
  const legacy = getLegacyVariant(id)
  if (legacy) {
    return {
      id,
      name: legacy.variant.name,
      description: legacy.variant.description,
      spec: { ...legacy.variant.spec, name: legacy.variant.name },
      savedId: null,
      kind: 'builtin',
      question: '',
      permission: legacy.template.permission,
      // No switch on a legacy id: it names ONE cut, and offering the other five
      // would quietly turn a stable integration key into a different report.
      variants: [],
      variantKey: null,
      prefsId: id,
    }
  }

  const template = getTemplate(id)
  if (!template) return null

  const variant = resolveVariant(template, variantKey)
  if (variant) {
    return {
      id,
      name: variant.name,
      description: variant.description,
      spec: { ...variant.spec, name: variant.name },
      savedId: null,
      kind: 'builtin',
      question: '',
      permission: template.permission,
      variants: template.variants ?? [],
      variantKey: variant.key,
      // Inherit the retired report's stored columns — see ResolvedReport.prefsId.
      prefsId: variant.legacyId ?? `${template.id}:${variant.key}`,
    }
  }

  return {
    id,
    name: template.name,
    description: template.description,
    spec: templateSpec(template),
    savedId: null,
    kind: 'builtin',
    question: '',
    permission: template.permission,
    variants: [],
    variantKey: null,
    prefsId: id,
  }
}
