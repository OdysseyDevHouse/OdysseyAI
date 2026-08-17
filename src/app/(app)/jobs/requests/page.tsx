import { requireModuleCapability } from '@/lib/auth'
import { listRequests, intakeSettings, type RequestStatus } from '@/lib/site/jobIntake'
import { createPublicIntakeToken } from '@/lib/publicIntakeToken'
import { PageHeader, PageBody, Callout, TextLink } from '@/components/ui'
import RequestsClient from './RequestsClient'

export const dynamic = 'force-dynamic'

/**
 * Work asked for from outside, waiting for somebody to decide.
 *
 * ── EVERY ROW HERE IS A PERSON WAITING ─────────────────────────────────────
 *
 * That is the whole reason this screen is a nav entry rather than a tab
 * somewhere: a request nobody opens is a customer who phoned a competitor. The
 * reconciliation screen reports anything sitting here more than three days for
 * the same reason.
 *
 * ── ACCEPTING IS A DELIBERATE ACT ──────────────────────────────────────────
 *
 * Nothing arrives as a job. Somebody reads the request, chooses which customer
 * it is for — or creates one first — and presses Accept. See the module header
 * for why no code path matches a stranger to an account automatically.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>
}) {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.edit')
  const { status } = await searchParams

  const valid: (RequestStatus | 'all')[] = ['new', 'accepted', 'rejected', 'spam', 'all']
  const active = (valid as string[]).includes(status ?? '')
    ? ((status ?? 'new') as RequestStatus | 'all')
    : 'new'

  const [requests, settings, token] = await Promise.all([
    listRequests(siteId, active),
    intakeSettings(siteId),
    // Deterministic, so the URL somebody put on their website keeps working.
    createPublicIntakeToken(siteId).catch(() => null),
  ])

  const base = process.env.APP_URL ?? ''

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle="Work asked for from outside, waiting to be accepted."
      />
      <PageBody>
        {!settings.isEnabled && (
          <Callout tone="warning" title="The public form is switched off">
            Nobody can send a request at the moment. Switch it on in{' '}
            <TextLink href="/setup/job-workflow">Setup &rsaquo; Job workflow</TextLink>. Anything
            already sent is still listed below.
          </Callout>
        )}

        <RequestsClient
          requests={requests}
          active={active}
          publicUrl={token ? `${base}/request/${token}` : null}
          formEnabled={settings.isEnabled}
        />
      </PageBody>
    </>
  )
}
