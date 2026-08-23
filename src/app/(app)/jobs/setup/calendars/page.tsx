import { requireModuleCapability } from '@/lib/auth'
import {
  listCalendarAccounts,
  pendingChanges,
  reconcileJobCalendar,
} from '@/lib/site/jobCalendar'
import { providerConfigured } from '@/lib/site/calendarProviders'
import { PageHeader, PageBody, Callout } from '@/components/ui'
import CalendarClient from './CalendarClient'

export const dynamic = 'force-dynamic'

/**
 * Linked calendars, and what came back from them (§46.13).
 *
 * ── WHY THIS IS NOT ON THE SUBSCRIBE SCREEN ────────────────────────────────
 *
 * /jobs/my-work already offers a subscribe URL — an .ics feed a calendar polls,
 * read-only, no account linking. The two look similar and are not: a feed shows
 * a technician their day, while linking hands this app write access to somebody's
 * personal calendar and reads their busy time back.
 *
 * That second thing is a decision about the business, gated on jobs.setup, and
 * it belongs where the rest of the workflow is configured. Putting a "grant
 * access to my Google account" button beside a copyable URL would make the two
 * look like the same choice at different strengths.
 */
export default async function JobCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')
  const { message } = await searchParams

  const [accounts, changes, drift] = await Promise.all([
    listCalendarAccounts(siteId),
    pendingChanges(siteId),
    reconcileJobCalendar(siteId),
  ])

  const google = providerConfigured('google')
  const microsoft = providerConfigured('microsoft')

  return (
    <>
      <PageHeader
        title="Calendars"
        subtitle="Job visits in Google or Outlook, and what those calendars say back."
      />
      <PageBody>
        {/*
          The message from the OAuth callback.

          Shown as neutral rather than success or failure: the same parameter
          carries "Linked jane@example.com", "No calendar was linked" when
          somebody declined, and a provider's own error text. Declining is a
          legitimate answer and must not arrive in red.
        */}
        {message && <Callout tone="brand" title={message} />}

        {!google && !microsoft && (
          <Callout tone="warning" title="Calendar sync is not configured on this server">
            Linking needs a client id and secret from Google or Microsoft, set in the
            environment. Until then the subscribe link on My work is still the way to see
            visits in a calendar — it is read-only and needs no account.
          </Callout>
        )}

        {drift.silent.length > 0 && (
          <Callout tone="warning" title="A linked calendar has not been written to in a week">
            {drift.silent.map((s) => s.userName).join(', ')} — there are visits booked, so
            something is stopping the push. That is the failure nobody notices, because an
            absent event looks exactly like a quiet week.
          </Callout>
        )}

        <CalendarClient
          accounts={accounts}
          changes={changes}
          providers={{ google, microsoft }}
        />
      </PageBody>
    </>
  )
}
