import { requireModuleCapability } from '@/lib/auth'
import { getSettings } from '@/lib/site/settings'
import { PageHeader, PageBody } from '@/components/ui'
import SignoffPanel from './SignoffPanel'

export const dynamic = 'force-dynamic'

/** What has to be true before a job can be signed off. */
export default async function JobSignoffPage() {
  const { siteId } = await requireModuleCapability('job_cards', 'jobs.setup')

  const settings = await getSettings(siteId, [
    'job_items_block_close',
    'job_headline_required',
    'job_signature_statement',
  ])

  return (
    <>
      <PageHeader
        title="Job signoff"
        subtitle="Who signs a job off, and what they have to see or sign before they can."
      />
      <PageBody>
        <SignoffPanel
          itemsBlockClose={settings.job_items_block_close !== '0'}
          headlineRequired={settings.job_headline_required === '1'}
          signatureStatement={settings.job_signature_statement}
        />
      </PageBody>
    </>
  )
}
