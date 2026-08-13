import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { listJobSeries, seriesDueCount } from '@/lib/site/jobSeries'
import { listHeadlines } from '@/lib/site/jobHeadlines'
import { listCustomers } from '@/lib/site/customers'
import {
  PageHeader,
  PageBody,
  Card,
  CardHeader,
  StatStrip,
  StatTile,
  Callout,
  EmptyState,
  Icons,
} from '@/components/ui'
import RecurringClient from './RecurringClient'

export const dynamic = 'force-dynamic'

/**
 * Recurring work: a quarterly service, an annual certificate.
 *
 * ── WHY THE SWITCH IS OFF BY DEFAULT, AND SAID SO HERE ─────────────────────
 *
 * `auto_create` defaults off, so a schedule somebody has just set up raises
 * nothing until they turn it on. That is deliberate — a schedule that generated
 * three months of catch-up the moment it was saved is a schedule nobody trusts
 * again — but it is also surprising, so the screen says which schedules are
 * switched off rather than leaving somebody to wonder why nothing appeared.
 *
 * ── AND WHY IT SAYS WHETHER THE CRON IS RUNNING ────────────────────────────
 *
 * A schedule switched on, with a tick nobody is calling, is a promise the system
 * quietly fails to keep — and the failure has no symptom until a customer rings
 * to ask why nobody came. The banner is the only place that can say so.
 */
export default async function RecurringJobsPage() {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { siteId, capabilities } = await requireCapability('jobs.view')

  const [series, dueCount, headlines, customers] = await Promise.all([
    listJobSeries(siteId, { includeInactive: true }),
    seriesDueCount(siteId),
    listHeadlines(siteId, false).catch(() => []),
    listCustomers(siteId, { limit: 500 }),
  ])

  const active = series.filter((s) => s.isActive)
  const paused = active.filter((s) => !s.autoCreate)
  const cronConfigured = Boolean(process.env.JOB_SERIES_CRON_SECRET)

  return (
    <>
      <PageHeader
        title="Recurring work"
        subtitle="Schedules that raise a job when it is due — a quarterly service, an annual certificate."
      />
      <PageBody>
        <StatStrip>
          <StatTile label="Schedules" value={String(active.length)} />
          <StatTile
            label="Owing a job now"
            value={String(dueCount)}
            tone={dueCount > 0 ? 'warning' : 'default'}
          />
          <StatTile
            label="Switched off"
            value={String(paused.length)}
            tone={paused.length > 0 ? 'warning' : 'default'}
          />
        </StatStrip>

        {/*
          The silent-failure warning. A schedule switched on with nothing calling
          the tick raises nothing, and there is no error anywhere to find — so this
          banner is the only symptom the system can offer.
        */}
        {!cronConfigured && active.some((s) => s.autoCreate) && (
          <Callout tone="warning" title="Nothing is calling the daily run">
            Schedules are switched on, but <code>JOB_SERIES_CRON_SECRET</code> is not set, so
            nothing can trigger <code>/api/jobs/series/tick</code>. Jobs will only appear when
            somebody presses Raise now. Set the secret and point a daily cron at that URL.
          </Callout>
        )}

        {paused.length > 0 && (
          <Callout tone="neutral" title="Some schedules are not raising anything yet">
            {paused.map((s) => s.name).join(', ')} — set up but switched off. That is the default: a
            new schedule raises nothing until somebody turns it on, so it cannot surprise anybody
            with a run of back-dated jobs.
          </Callout>
        )}

        {series.length === 0 ? (
          <Card>
            <CardHeader title="Schedules" />
            <EmptyState
              icon={<Icons.CalendarClock size={22} />}
              title="No recurring work yet"
              hint="Set one up for the work that comes round on its own — a six-monthly aircon service, an annual pressure-vessel certificate. The job appears when it is due, already carrying its checks."
            />
          </Card>
        ) : null}

        <RecurringClient
          series={series}
          headlines={headlines.map((h) => ({ id: h.id, name: h.name, itemCount: h.items.length }))}
          customers={customers.items.map((c) => ({ id: c.id, name: c.name }))}
          canEdit={can(capabilities, 'jobs.edit')}
          canSetup={can(capabilities, 'jobs.setup')}
        />
      </PageBody>
    </>
  )
}
