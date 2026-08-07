import { notFound } from 'next/navigation'
import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { resolveReport } from '@/lib/reportBuilder/resolve'
import { runBuilderSpec, ReportAccessError } from '@/lib/reportBuilder/run'
import { listFavorites } from '@/lib/site/reportFavorites'
import { listUsers } from '@/lib/site/users'
import { PERIOD_KEYS, PERIOD_LABELS, type PeriodKey } from '@/lib/reportBuilder/spec'
import { PageHeader, PageBody, Card, Callout, Icons } from '@/components/ui'
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
  searchParams: Promise<{ period?: string; from?: string; to?: string }>
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

  let result
  let error: string | null = null
  try {
    result = await runBuilderSpec(siteId, spec, allow)
  } catch (e) {
    if (e instanceof ReportAccessError) notFound()
    error = e instanceof Error ? e.message : 'This report could not be run.'
  }

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
            columns={result.columns}
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
