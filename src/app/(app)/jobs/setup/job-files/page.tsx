import { requireModuleCapability } from '@/lib/auth'
import { PageHeader, PageBody, TextLink } from '@/components/ui'
import NotBuiltYet from '../NotBuiltYet'

export const dynamic = 'force-dynamic'

/**
 * Photos and attachments on a job.
 *
 * The FEATURE works — `attachmentTargets.ts` carries a `job_card` target, files
 * attach to a job today, and reading and writing them are gated on jobs.view and
 * jobs.edit. What does not exist is anything to configure: no size cap, no type
 * allowlist, no per-stage requirement, no retention.
 *
 * So this is a stub rather than a screen, and it says which of the two it is —
 * "attachments are not built" would be false and would send somebody looking for
 * a feature they already have.
 */
export default async function JobFilesPage() {
  await requireModuleCapability('job_cards', 'jobs.setup')

  return (
    <>
      <PageHeader
        title="Job files"
        subtitle="Photos, drawings and attachments that travel with a job."
      />
      <PageBody>
        <NotBuiltYet
          what="Attaching files to a job already works — there is just nothing to set. No size limit, allowed file types, or rule about which stages need a photo."
          today={
            <>
              Who may see and add them follows the job itself: anyone who can view a job can open
              its files, and anyone who can edit one can add to them. Both are set under{' '}
              <TextLink href="/setup/roles">Roles &amp; permissions</TextLink>. Whether a customer
              may send a photo in is under{' '}
              <TextLink href="/jobs/setup/web-forms">Web forms</TextLink>.
            </>
          }
        />
      </PageBody>
    </>
  )
}
