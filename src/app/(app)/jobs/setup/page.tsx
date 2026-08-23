import { redirect } from 'next/navigation'
import { requireModuleCapability } from '@/lib/auth'
import { can } from '@/lib/site/permissions'
import { PageHeader, PageBody } from '@/components/ui'
import HubView from '@/components/HubView'
import { jobsSetupGroupsFor } from './catalogue'

export const dynamic = 'force-dynamic'

/**
 * Job cards — Setup.
 *
 * The four screens that decide how work moves, which used to be tiles in the
 * general Setup hub. A shop without the module never sees this, because the
 * gate below turns them away before the catalogue is read.
 */
export default async function JobsSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  // A hidden menu entry is not a boundary — this URL is typeable.
  const { capabilities } = await requireModuleCapability('job_cards', 'jobs.setup')

  const groups = jobsSetupGroupsFor((c) => can(capabilities, c as Parameters<typeof can>[1]))
  if (groups.length === 0) redirect('/not-allowed')

  const { q } = await searchParams

  return (
    <>
      <PageHeader
        title="Job card setup"
        subtitle="How work moves, what gets recorded, and where a visit shows up"
      />
      <PageBody>
        <HubView
          groups={groups}
          noun="job card settings"
          emptyHint="Your role does not include configuring job cards. An owner can grant this under Roles & permissions."
          initialSearch={q ?? ''}
        />
      </PageBody>
    </>
  )
}
