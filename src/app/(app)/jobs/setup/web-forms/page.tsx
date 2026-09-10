import { requireModuleCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { createPortalToken } from '@/lib/publicPortalToken'
import { PageHeader, PageBody } from '@/components/ui'
import WebFormsPanel from './WebFormsPanel'

export const dynamic = 'force-dynamic'

/**
 * The two doors this business opens to people outside it.
 *
 * Public intake (§4.2) and the customer portal (§4.3): the only settings in job
 * setup that put a URL on the internet.
 */
export default async function JobWebFormsPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const [settings, portalToken] = await Promise.all([
    getSettings(siteId, [
      'job_intake_enabled',
      'job_intake_blurb',
      'job_intake_max_per_phone',
      'job_intake_show_headlines',
      'portal_enabled',
      'portal_allow_comments',
      'portal_allow_uploads',
      'portal_allow_quote_accept',
    ]),
    // The portal sign-in link (§4.3). Deterministic, so what somebody put on
    // their website keeps working; null if SESSION_SECRET is missing.
    createPortalToken(siteId).catch(() => null),
  ])

  const portalUrl = portalToken ? `${process.env.APP_URL ?? ''}/portal/${portalToken}` : null

  return (
    <>
      <PageHeader
        title="Web forms"
        subtitle="Requests from outside — public forms that create a job when someone submits one."
      />
      <PageBody>
        <WebFormsPanel
          intakeEnabled={settings.job_intake_enabled === '1'}
          intakeBlurb={settings.job_intake_blurb}
          intakeMaxPerPhone={Number(settings.job_intake_max_per_phone) || 0}
          intakeShowHeadlines={settings.job_intake_show_headlines === '1'}
          portalEnabled={settings.portal_enabled === '1'}
          portalAllowComments={settings.portal_allow_comments === '1'}
          portalAllowUploads={settings.portal_allow_uploads === '1'}
          portalAllowQuoteAccept={settings.portal_allow_quote_accept === '1'}
          portalUrl={portalUrl}
        />
      </PageBody>
    </>
  )
}
