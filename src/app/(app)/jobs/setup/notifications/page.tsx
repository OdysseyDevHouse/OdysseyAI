import { requireModuleCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { isConfiguredFor } from '@/lib/mail'
import { PageHeader, PageBody } from '@/components/ui'
import NotificationsPanel from './NotificationsPanel'

export const dynamic = 'force-dynamic'

/**
 * Who hears about a job, and what happens on its own.
 *
 * Reads only the nine settings its panel owns. The other thirteen belong to
 * /jobs/setup/signoff, /jobs/setup/parts-stock and /jobs/setup/web-forms, and
 * the save action takes a patch so none of them can be touched from here.
 */
export default async function JobNotificationsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const settings = await getSettings(siteId, [
    'job_notify_enabled',
    'job_notify_assignee',
    'job_notify_events',
    'job_auto_escalate',
    'job_auto_visit_reminder',
    'job_auto_visit_hours',
    'job_auto_invoice',
    'job_feedback_enabled',
    'job_feedback_intro',
  ])

  return (
    <>
      <PageHeader
        title="Notifications"
        subtitle="Telling people — who hears about a job, and at which moment."
      />
      <PageBody>
        <NotificationsPanel
          notifyEnabled={settings.job_notify_enabled !== '0'}
          notifyAssignee={settings.job_notify_assignee !== '0'}
          notifyEvents={settings.job_notify_events
            .split(',')
            .map((e) => e.trim())
            .filter(Boolean)}
          autoEscalate={settings.job_auto_escalate === '1'}
          autoVisitReminder={settings.job_auto_visit_reminder === '1'}
          autoVisitHours={Number(settings.job_auto_visit_hours) || 16}
          autoInvoice={settings.job_auto_invoice === '1'}
          feedbackEnabled={settings.job_feedback_enabled === '1'}
          feedbackIntro={settings.job_feedback_intro}
          /*
           * Both read on the SERVER. `isConfiguredFor` reads this shop's own
           * settings and falls back to process.env, neither of which a client
           * component can see — and a panel that cannot tell whether mail works
           * would let somebody switch on notifications and believe they were
           * covered.
           */
          mailConfigured={await isConfiguredFor(siteId)}
          cronConfigured={Boolean(process.env.JOB_AUTOMATION_CRON_SECRET)}
        />
      </PageBody>
    </>
  )
}
