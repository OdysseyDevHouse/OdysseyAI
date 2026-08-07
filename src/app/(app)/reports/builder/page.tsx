import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { sourcesFor, fieldsFor, type CatalogSource } from '@/lib/reportBuilder/catalog'
import { templatesFor, templateSpec } from '@/lib/reportBuilder/templates'
import { emptySpec, validateSpec, type CustomReportSpec } from '@/lib/reportBuilder/spec'
import type { ClientSource } from '@/lib/reportBuilder/clientTypes'
import { getSavedReport } from '@/lib/site/savedReports'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import { PageHeader, PageBody } from '@/components/ui'
import BuilderShell from './BuilderShell'

export const dynamic = 'force-dynamic'

/**
 * The report builder.
 *
 * The catalog is filtered to what THIS user may read before it is handed to the
 * browser, so the field picker cannot even display a column they are not
 * allowed to see. The server re-applies the same rule on every run — the client
 * copy is for the UI, never the boundary.
 */
export default async function BuilderPage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; from?: string; source?: string; spec?: string }>
}) {
  const { siteId, capabilities } = await requireCapability('reports.build')
  const allow = (c: Capability) => can(capabilities, c)

  const query = await searchParams
  const sources = sourcesFor(allow)

  // Three ways in: editing a saved report, customising a built-in, or starting
  // from scratch on a chosen source.
  let initial: CustomReportSpec | null = null
  let savedId: number | null = null

  if (query.saved) {
    const id = Number(query.saved)
    const saved = Number.isInteger(id) ? await getSavedReport(siteId, id) : null
    if (saved?.spec) {
      initial = saved.spec
      savedId = saved.id
    }
  } else if (query.from) {
    const report = await resolveReport(siteId, query.from)
    if (report) {
      // Customising a built-in starts a NEW report — the built-in itself is not
      // editable, and silently overwriting it would be worse than confusing.
      initial = { ...report.spec, name: `${report.spec.name} (copy)` }
    }
  } else if (query.spec) {
    // A generated report handed straight to the builder to adjust. It is
    // re-validated like any other spec — arriving via the URL earns it no
    // trust, and a spec that no longer parses just opens the source picker.
    try {
      const parsed = JSON.parse(query.spec) as CustomReportSpec
      const checked = validateSpec(parsed)
      if (checked.ok && allow(checked.source.permission)) initial = checked.spec
    } catch {
      initial = null
    }
  } else if (query.source && sources.some((s) => s.key === query.source)) {
    initial = emptySpec(query.source)
  }

  return (
    <>
      <PageHeader
        title={savedId ? 'Edit report' : 'Build a report'}
        subtitle="Pick what to read, choose the columns, and save it for everyone."
      />
      <PageBody>
        <BuilderShell
          sources={sources.map((s) => toClientSource(s, allow))}
          initialSpec={initial}
          savedId={savedId}
          // Starting from a report that nearly works beats starting from a
          // blank one, so the built-ins the user may run are offered as
          // starting points. Each carries its own spec, cloned on pick.
          templates={templatesFor(allow)
            .filter((t) => sources.some((s) => s.key === t.spec.source))
            .map((t) => ({
              id: t.id,
              name: t.name,
              description: t.description,
              source: t.spec.source,
              spec: templateSpec(t),
            }))}
        />
      </PageBody>
    </>
  )
}

/** The catalog as the browser sees it — SQL expressions stripped out. */
function toClientSource(source: CatalogSource, allow: (c: Capability) => boolean): ClientSource {
  return {
    key: source.key,
    label: source.label,
    description: source.description,
    category: source.category,
    shape: source.shape,
    note: source.note,
    defaultFilters: source.defaultFilters ?? [],
    // `expr` is deliberately NOT sent. The browser never needs it, and shipping
    // the SQL for every field would put the whole schema in the page source for
    // no benefit.
    fields: fieldsFor(source, allow).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      numeric: f.numeric ?? false,
      starter: f.starter ?? false,
      noTotal: f.noTotal ?? false,
      hasRatio: !!f.ratio,
      group: f.group ?? '',
      hint: f.hint ?? '',
      options: f.options ?? [],
    })),
  }
}
