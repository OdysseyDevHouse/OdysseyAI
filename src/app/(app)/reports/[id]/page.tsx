import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { runAcrossSites, mergeRefusalFor } from '@/lib/reportBuilder/runAcrossSites'
import { groupScopeFor, capabilitiesForSiteUser } from '@/lib/groupReporting'
import { listFavorites } from '@/lib/site/reportFavorites'
import { reportColumnsFor, applyStoreColumns } from '@/lib/site/reportColumns'
import { listUsers, getUser } from '@/lib/site/users'
import { PERIOD_KEYS, PERIOD_LABELS, type PeriodKey } from '@/lib/reportBuilder/spec'
import { PageHeader, PageBody, Card, Callout, Icons, LinkTabs, Badge } from '@/components/ui'
import { hrefBuilder } from '@/lib/searchParams'
import ReportView from './ReportView'

export const dynamic = 'force-dynamic'

/**
 * Running one report.
 *
 * Built-ins and saved reports arrive here through the same id space and run
 * through the same engine, so this screen is the only place a report is ever
 * displayed — there is no second rendering path to keep in step.
 */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ period?: string; from?: string; to?: string; stores?: string }>
}) {
  const { siteId, actor, capabilities } = await requireCapability('reports.view')
  const allow = (c: Capability) => can(capabilities, c)

  const { id } = await params
  const query = await searchParams

  const report = await resolveReport(siteId, decodeURIComponent(id))
  if (!report) notFound()

  // A built-in's own capability, on top of reports.view — someone who may run
  // sales reports is not thereby allowed to run the activity log.
  if (report.permission && !allow(report.permission)) notFound()

  // The period can be overridden on screen without changing the saved report.
  // Anything unrecognised falls back to the spec's own period rather than
  // erroring, so a hand-edited URL degrades quietly.
  const periodKey = PERIOD_KEYS.includes(query.period as PeriodKey)
    ? (query.period as PeriodKey)
    : null
  const spec = periodKey
    ? {
        ...report.spec,
        period:
          periodKey === 'custom'
            ? { key: periodKey, from: query.from, to: query.to }
            : { key: periodKey },
      }
    : report.spec

  const favorites = await listFavorites(siteId, actor.userId)

  // Only fetched when the schedule dialog could actually open — a report screen
  // has no other reason to know who works here.
  const scheduleUsers = allow('reports.schedule')
    ? (await listUsers(siteId))
        .filter((u) => u.isActive && u.email)
        .map((u) => ({ id: u.id, name: u.name, email: u.email! }))
    : []

  /*
   * ── ONE STORE, OR ALL OF THEM ────────────────────────────────────────────
   *
   * The same spec, run against every linked store and merged. Offered only when
   * the site is in a group AND the arithmetic survives the merge — a report
   * built on averages or a per-group top ten cannot be combined honestly, and
   * `mergeRefusalFor` says so in a sentence rather than producing a wrong
   * figure. The toggle is hidden entirely for a single-store site.
   */
  /* requireCapability narrows the actor to id and name, so the control-user id
     — which is what identifies this person ACROSS stores — is read here rather
     than by widening an auth helper every screen in the app depends on. */
  const me = await getUser(siteId, actor.userId)
  const controlUserId = me?.controlUserId ?? null

  const groupScope =
    controlUserId === null
      ? null
      : await groupScopeFor(siteId, controlUserId, 'reports.view')
  const canGoGroupWide = (groupScope?.sites.length ?? 0) > 1
  const refusal = canGoGroupWide ? mergeRefusalFor(spec) : null
  const allStores = query.stores === 'all' && canGoGroupWide && !refusal

  let result
  let multiSite: Awaited<ReturnType<typeof runAcrossSites>> | null = null
  let error: string | null = null
  try {
    if (allStores && groupScope) {
      /* Capabilities are resolved per store BEFORE the run, because a user
         holds a different role in each shop and the predicate the engine takes
         is synchronous. A store where they may not read the source drops out
         with a reason rather than contributing an empty column. */
      const perStore = new Map<number, (c: Capability) => boolean>([[siteId, allow]])
      await Promise.all(
        groupScope.sites
          .filter((s) => s.siteId !== siteId)
          .map(async (s) => {
            const caps = await capabilitiesForSiteUser(s.siteId, controlUserId!)
            perStore.set(s.siteId, (c: Capability) => (caps ? can(caps, c) : false))
          }),
      )
      multiSite = await runAcrossSites(
        groupScope.sites,
        spec,
        (site) => perStore.get(site) ?? (() => false),
      )
      result = multiSite
    } else {
      result = await runBuilderSpec(siteId, spec, allow)
    }
  } catch (e) {
    if (e instanceof ReportAccessError) notFound()
    error = e instanceof Error ? e.message : 'This report could not be run.'
  }

  /*
   * The store's columns and their order, applied over what the engine produced.
   *
   * Read against the keys THIS RUN yielded, so a stored key for a column the
   * report no longer has is dropped rather than leaving a hole. Null when the
   * store has never chosen, in which case the report's own order stands.
   *
   * Applied here rather than inside runBuilderSpec because the builder preview
   * must keep showing the SPEC's columns — you are editing the report there,
   * and a preview filtered by the store's choice would hide the column you just
   * added.
   */
  // Keeps the period the reader chose while flipping which stores are counted.
  const storeHref = hrefBuilder(`/reports/${encodeURIComponent(id)}`, query)

  const producedKeys = result ? result.columns.map((c) => c.key) : []
  const storeColumns = result
    ? await reportColumnsFor(siteId, report.id, producedKeys)
    : null
  const shownColumns = result ? applyStoreColumns(result.columns, storeColumns) : []

  return (
    <>
      <PageHeader
        title={report.name}
        subtitle={
          result
            ? `${PERIOD_LABELS[spec.period.key]} · ${result.range.from} to ${result.range.to}`
            : report.description
        }
      />
      <PageBody>
        {/* One store, or every linked one. Hidden entirely for a single-store
            site, and shown disabled with its reason when the spec's arithmetic
            cannot survive a merge — a toggle that silently does nothing is
            worse than one that explains itself. */}
        {canGoGroupWide && (
          <div className="flex flex-wrap items-center gap-3">
            <LinkTabs
              items={[
                { value: 'one', label: 'This store', href: storeHref({ stores: null }) },
                { value: 'all', label: 'All stores', href: storeHref({ stores: 'all' }) },
              ]}
              value={allStores ? 'all' : 'one'}
              aria-label="Which stores"
            />
            {refusal && (
              <span className="text-xs text-muted">
                <Badge tone="neutral">One store only</Badge>
                <span className="ml-2">{refusal.message}</span>
              </span>
            )}
            {multiSite && multiSite.failures.length > 0 && (
              <span className="text-xs text-muted">
                <Badge tone="warning">
                  {multiSite.failures.length} store
                  {multiSite.failures.length === 1 ? '' : 's'} left out
                </Badge>
                <span className="ml-2">
                  {multiSite.failures.map((f) => `${f.name}: ${f.error}`).join('; ')}
                </span>
              </span>
            )}
            {multiSite && multiSite.failures.length === 0 && (
              <span className="text-xs text-muted">
                Combining {multiSite.sites.map((s) => s.name).join(', ')}.
              </span>
            )}
          </div>
        )}

        {error ? (
          <Card>
            <div className="p-4">
              <Callout tone="danger" title="This report could not be run">
                {error}
              </Callout>
            </div>
          </Card>
        ) : result ? (
          <ReportView
            reportId={report.id}
            name={report.name}
            description={report.description}
            columns={shownColumns}
            allColumns={result.columns}
            storeColumns={storeColumns}
            canSetColumns={allow('setup.edit')}
            rows={result.rows}
            totals={result.totals}
            range={result.range}
            truncated={result.truncated}
            hiddenColumns={result.hiddenColumns}
            periodKey={spec.period.key}
            spec={spec}
            savedId={report.savedId}
            kind={report.kind}
            starred={favorites.has(report.id)}
            canBuild={allow('reports.build')}
            canSchedule={allow('reports.schedule')}
            chartType={spec.chartType ?? 'bar'}
            scheduleUsers={scheduleUsers}
          />
        ) : null}
      </PageBody>
    </>
  )
}
