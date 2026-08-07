import { requireCapability } from '@/lib/auth'
import { can, type Capability } from '@/lib/site/permissions'
import { listSchedules } from '@/lib/site/reportSchedules'
import { listSavedReports } from '@/lib/site/savedReports'
import { templatesFor } from '@/lib/reportBuilder/templates'
import { listUsers } from '@/lib/site/users'
import { isConfigured as mailConfigured } from '@/lib/mail'
import { describeSchedule, nextDueAt } from '@/lib/reportSchedules/due'
import { PageHeader, PageBody, Card, Callout, Icons } from '@/components/ui'
import SchedulesClient from './SchedulesClient'

export const dynamic = 'force-dynamic'

/**
 * Scheduled reports.
 *
 * The "next send" for each rule is computed here rather than stored, so it can
 * never drift from what the scheduler will actually do — both read the same
 * function.
 */
export default async function SchedulesPage() {
  const { siteId, capabilities } = await requireCapability('reports.schedule')
  const allow = (c: Capability) => can(capabilities, c)

  const [schedules, saved, users] = await Promise.all([
    listSchedules(siteId),
    listSavedReports(siteId),
    listUsers(siteId),
  ])

  const now = new Date()
  const templates = templatesFor(allow)

  // Everything schedulable, in the one id space the whole feature uses.
  const reportOptions = [
    ...templates.map((t) => ({ id: t.id, name: t.name, group: t.category })),
    ...saved.filter((s) => s.spec !== null).map((s) => ({
      id: `saved:${s.id}`,
      name: s.name,
      group: 'Built here',
    })),
  ]

  return (
    <>
      <PageHeader
        title="Scheduled reports"
        subtitle="Have a report emailed on a timer, without anyone opening the app."
      />
      <PageBody>
        {!mailConfigured() && (
          <Callout tone="warning" title="Email is not set up">
            Schedules can be created, but nothing will send until an administrator configures the
            mail server under Setup.
          </Callout>
        )}

        <SchedulesClient
          schedules={schedules.map((s) => ({
            id: s.id,
            name: s.name,
            isActive: s.isActive,
            reportId: s.resolvedReportId,
            reportName:
              reportOptions.find((r) => r.id === s.resolvedReportId)?.name ?? 'Report not found',
            cadence: describeSchedule(s),
            // A rule that is off has no next send — showing one would imply it
            // is still going to fire.
            nextSend: s.isActive ? (nextDueAt(s, now)?.toISOString() ?? null) : null,
            periodKey: s.periodKey,
            frequency: s.frequency,
            sendTime: s.sendTime,
            daysOfWeek: s.daysOfWeek,
            dayOfMonth: s.dayOfMonth,
            recipientUserIds: s.recipientUserIds,
            recipientEmails: s.recipientEmails,
            attachCsv: s.attachCsv,
            includeHtml: s.includeHtml,
            message: s.message,
            createdByName: s.createdByName,
            lastRunAt: s.lastRunAt?.toISOString() ?? null,
            lastRunStatus: s.lastRunStatus,
            lastRunError: s.lastRunError,
            recipientCount: s.recipientUserIds.length + s.recipientEmails.length,
          }))}
          reportOptions={reportOptions}
          users={users
            .filter((u) => u.isActive && u.email)
            .map((u) => ({ id: u.id, name: u.name, email: u.email! }))}
        />
      </PageBody>
    </>
  )
}
