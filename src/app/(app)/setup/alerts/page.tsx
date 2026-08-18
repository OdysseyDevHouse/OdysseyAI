import { requireCapability } from '@/lib/auth'
import { listRules } from '@/lib/site/alerts'
import { listUsers } from '@/lib/site/users'
import { isConfigured as mailConfigured } from '@/lib/mail'
import { isSmsConfigured } from '@/lib/site/sms'
import { isWhatsAppConfigured } from '@/lib/whatsapp'
import { describeSchedule, nextDueAt } from '@/lib/reportSchedules/due'
import { ALERT_KIND_LABELS } from '@/lib/alerts/types'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import AlertsClient from './AlertsClient'

export const dynamic = 'force-dynamic'

/**
 * Alerts & automations.
 *
 * "Next check" is computed here rather than stored, using the same nextDueAt()
 * the scheduler reads — so what the screen promises and what the engine does
 * cannot drift.
 *
 * Which channels are actually set up is resolved server-side too, because the
 * answer differs per site (SMS and WhatsApp are settings; email is the
 * deployment's SMTP). A rule pointed at a channel nobody configured would run
 * every morning and tell nobody, so the screen says so before it is built.
 */
export default async function AlertsPage() {
  const { siteId } = await requireCapability('setup.edit')

  const [rules, users, smsReady, whatsappReady] = await Promise.all([
    listRules(siteId),
    listUsers(siteId),
    isSmsConfigured(siteId),
    isWhatsAppConfigured(siteId),
  ])

  const now = new Date()
  const emailReady = mailConfigured()

  const missing = [
    emailReady ? null : 'email',
    whatsappReady ? null : 'WhatsApp',
    smsReady ? null : 'SMS',
  ].filter(Boolean) as string[]

  return (
    <>
      <PageHeader
        title="Alerts & automations"
        subtitle="Watch for something, tell the right people, and offer the fix."
      />
      <PageBody>
        {missing.length > 0 && (
          <Callout tone="warning" title={`Not every channel is set up`}>
            {sentence(missing)} not been set up for this shop, so an alert using{' '}
            {missing.length === 1 ? 'it' : 'them'} would find things and tell nobody. The bell
            always works. Email is configured by an administrator; WhatsApp and SMS live under
            Setup → Text messages.
          </Callout>
        )}

        <AlertsClient
          rules={rules.map((r) => ({
            id: r.id,
            kind: r.kind,
            kindLabel: ALERT_KIND_LABELS[r.kind] ?? r.kind,
            name: r.name,
            isActive: r.isActive,
            frequency: r.frequency,
            sendTime: r.sendTime,
            daysOfWeek: r.daysOfWeek,
            dayOfMonth: r.dayOfMonth,
            cadence: describeSchedule(r),
            /*
             * Null while paused: a "next check" on a rule that will not run is
             * a promise the screen cannot keep.
             *
             * toISOString() is right HERE and wrong for lastRunAt below: this
             * Date is built by nextDueAt() from local calendar parts, so it is
             * a genuine instant, while a stored DATETIME read through a 'Z'
             * connection is a wall clock wearing a Date's clothes.
             */
            nextCheck: r.isActive ? (nextDueAt(r, now)?.toISOString() ?? null) : null,
            config: r.config,
            notifyBell: r.notifyBell,
            notifyEmail: r.notifyEmail,
            notifyWhatsapp: r.notifyWhatsapp,
            notifySms: r.notifySms,
            recipientUserIds: r.recipientUserIds,
            recipientEmails: r.recipientEmails,
            whatsappNumbers: r.whatsappNumbers,
            smsNumbers: r.smsNumbers,
            recipientCount:
              r.recipientUserIds.length +
              r.recipientEmails.length +
              r.whatsappNumbers.length +
              r.smsNumbers.length,
            createdByName: r.createdByName,
            lastRunAt: wallClock(r.lastRunAt),
            lastRunStatus: r.lastRunStatus,
            lastRunError: r.lastRunError,
          }))}
          users={users
            .filter((u) => u.isActive && u.userType === 'back_office')
            .map((u) => ({ id: u.id, name: u.name, email: u.email }))}
          channels={{ email: emailReady, whatsapp: whatsappReady, sms: smsReady }}
        />
      </PageBody>
    </>
  )
}

/**
 * A stored DATETIME as the wall clock it actually is.
 *
 * The pool sets the connection timezone to 'Z', so the UTC parts of the driver's
 * Date ARE the stored wall clock — and calling toISOString() on it re-stamps
 * that wall clock as UTC, which the browser then shifts again. A check that ran
 * at 01:09 came out as "Tomorrow 01:09" on a machine set to SAST, which is how
 * this was found.
 *
 * Same helper, for the same reason, as wallClock() in site/jobAppointments.ts.
 * The client formats what comes out of here as a local time, and because the
 * string carries no zone that is exactly what it renders.
 */
function wallClock(value: Date | null): string | null {
  if (!value || Number.isNaN(value.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}` +
    `T${p(value.getUTCHours())}:${p(value.getUTCMinutes())}:${p(value.getUTCSeconds())}`
  )
}

/** "Email and SMS have" / "WhatsApp has" — the verb agrees with the list. */
function sentence(items: string[]): string {
  const label =
    items.length === 1
      ? items[0]
      : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  const capitalised = label.charAt(0).toUpperCase() + label.slice(1)
  return `${capitalised} ${items.length === 1 ? 'has' : 'have'}`
}
